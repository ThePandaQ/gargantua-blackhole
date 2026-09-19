/**
 * GARGANTUA — render pipeline.
 *
 * Three.js owns the canvas/context/clock and OrbitControls drives the camera,
 * but the entire image is produced by five hand-written GLSL ES 3.00 programs
 * driving one fullscreen triangle (no VBOs at all — the vertex positions come
 * from gl_VertexID):
 *
 *   pass 1  scene      Schwarzschild null-geodesic RK4 integration -> RGBA16F
 *   pass 2  prefilter  soft-knee bright pass
 *   pass 3  downsample 13-tap pyramid (N mips)
 *   pass 4  upsample   9-tap tent pyramid, additively accumulated upward
 *   pass 5  composite  exposure / bloom / dispersion / ACES / vignette / grain
 *
 * Only RGBA16F is used, so dynamic range survives between passes intact and the
 * shadow can stay genuinely black next to the disc's hot inner rim.
 */

import * as THREE from 'three';
import { sceneFrag } from '../shaders/scene.js';
import {
  fullscreenVert, prefilterFrag, downsampleFrag, upsampleFrag, compositeFrag,
  shaderVersionHeader,
} from '../shaders/post.js';

const HALF = THREE.HalfFloatType;
const MAX_MIPS = 7;
/* Every program is GLSL ES 3.00 (WebGL2): 32-bit ints, bitwise operators,
   gl_VertexID, non-constant loop bounds. The version directive has to be the
   literal first line, and a default float precision has to be declared right
   after it for the fragment stage. */
const FRAG_HEADER = `${shaderVersionHeader}precision highp float;\nprecision highp int;\n`;
const VERT_HEADER = `${shaderVersionHeader}precision highp float;\nprecision highp int;\n`;

/* IEEE-754 binary16 -> double, for reading RGBA16F targets back on the CPU. */
const _hf = new Float32Array(1);
const _hi = new Int32Array(_hf.buffer);
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7C00) >> 10;
  const f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1F) return f ? NaN : (s ? -Infinity : Infinity);
  const exp = e - 15 + 127;
  if (exp <= 0 || exp >= 255) return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  _hi[0] = (s << 31) | (exp << 23) | (f << 13);
  return _hf[0];
}

/* ------------------------------------------------------------------ *
 *  Raw GL helpers
 * ------------------------------------------------------------------ */
function compile(gl, type, src, tag) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '(no log)';
    gl.deleteShader(sh);
    const numbered = src.split('\n')
      .map((l, i) => String(i + 1).padStart(4, ' ') + ' | ' + l).join('\n');
    const err = new Error(`[GARGANTUA] ${tag} shader compile failed:\n${log}\n${numbered}`);
    err.shaderLog = log;
    throw err;
  }
  return sh;
}

class FSProgram {
  constructor(gl, fragSrc, tag, vertSrc = fullscreenVert) {
    this.gl = gl;
    this.tag = tag;
    /* Each stage needs the #version directive as its literal first line, but a
       fragment source may already start with its own precision declaration, so
       the header carries the precision statements and any source-supplied
       precision block simply becomes a redundant (legal) re-declaration. */
    const vs = compile(gl, gl.VERTEX_SHADER,
      vertSrc.startsWith('#version') ? vertSrc : VERT_HEADER + vertSrc, tag + ':vert');
    const fs = compile(gl, gl.FRAGMENT_SHADER,
      fragSrc.startsWith('#version') ? fragSrc : FRAG_HEADER + fragSrc, tag + ':frag');
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p) || '(no log)';
      gl.deleteProgram(p);
      throw new Error(`[GARGANTUA] ${tag} program link failed: ${log}`);
    }
    this.program = p;
    this.uniforms = Object.create(null);
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) break;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms[name] = gl.getUniformLocation(p, name);
    }
  }
  use() { this.gl.useProgram(this.program); return this; }
  u1f(n, v) { const l = this.uniforms[n]; if (l) this.gl.uniform1f(l, v); return this; }
  u2f(n, a, b) { const l = this.uniforms[n]; if (l) this.gl.uniform2f(l, a, b); return this; }
  u3f(n, a, b, c) { const l = this.uniforms[n]; if (l) this.gl.uniform3f(l, a, b, c); return this; }
  u1i(n, v) { const l = this.uniforms[n]; if (l) this.gl.uniform1i(l, v); return this; }
  destroy() { if (this.program) { this.gl.deleteProgram(this.program); this.program = null; } }
}

/* ------------------------------------------------------------------ *
 *  Pipeline
 * ------------------------------------------------------------------ */
export class BlackHolePipeline {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.vertexArray = null;
    this.width = 0;
    this.height = 0;
    this.built = false;
    this.bloomMips = 5;
    this.frameCount = 0;
    this._build(opts);
  }

  get contextIsLost() {
    const gl = this.gl;
    return !gl || gl.isContextLost();
  }

  /* ---------------- resource construction ---------------- */
  _build(opts = {}) {
    const gl = this.gl;
    const f = gl.getExtension('EXT_color_buffer_float');
    const hf = gl.getExtension('EXT_color_buffer_half_float');
    if (!f && !hf) {
      throw new Error(
        '[GARGANTUA] This GPU/driver cannot render into floating point textures '
        + '(EXT_color_buffer_float / EXT_color_buffer_half_float missing). '
        + 'HDR geodesic ray-tracing requires it.'
      );
    }

    if (!this.vertexArray) this.vertexArray = gl.createVertexArray();

    this.progScene = new FSProgram(gl, sceneFrag, 'scene');
    this.progPrefilter = new FSProgram(gl, prefilterFrag, 'prefilter');
    this.progDown = new FSProgram(gl, downsampleFrag, 'downsample');
    this.progUp = new FSProgram(gl, upsampleFrag, 'upsample');
    this.progComposite = new FSProgram(gl, compositeFrag, 'composite');

    this.sceneRT = this._makeRT(2, 2, 'scene');
    this.downRTs = [];
    this.upRTs = [];
    for (let i = 0; i < MAX_MIPS; i++) {
      this.downRTs.push(this._makeRT(2, 2, 'bloomDown' + i));
      this.upRTs.push(this._makeRT(2, 2, 'bloomUp' + i));
    }

    this.built = true;
    if (opts.width && opts.height) {
      this.bloomMips = opts.bloomMips || this.bloomMips;
      this.setSize(opts.width, opts.height, { bloomMips: opts.bloomMips });
    }
  }

  _makeRT(w, h, name) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: HALF,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.name = name;
    rt.texture.generateMipmaps = false;
    return rt;
  }

  /**
   * The live WebGLTexture behind a render target (or a texture directly).
   *
   * three.js only realises the GPU texture the first time a target is bound, so
   * calling bindTexture() with rt.texture before that happens hands the driver a
   * plain JS object and throws. Forcing one bind through the renderer makes the
   * handle exist; after that the cached __webglTexture is stable until the
   * target is resized or the context is lost.
   */
  textureHandle(rtOrTexture) {
    if (!rtOrTexture) return null;
    const isRT = typeof rtOrTexture.isWebGLRenderTarget === 'boolean' && rtOrTexture.isWebGLRenderTarget;
    const tex = isRT ? rtOrTexture.texture : rtOrTexture;
    if (!tex) return null;
    let props = this.renderer.properties.get(tex);
    if (!props || !props.__webglTexture) {
      if (isRT) {
        this.renderer.setRenderTarget(rtOrTexture);
        this.renderer.setRenderTarget(null);
        props = this.renderer.properties.get(tex);
      }
    }
    return (props && props.__webglTexture) || null;
  }

  /* pass 2-4 result: the accumulated bloom, ready to be sampled */
  bloomTexture() {
    return this.upRTs[0] ? this.upRTs[0].texture : this.sceneRT.texture;
  }

  /**
   * Read the raw HDR scene buffer back to the CPU at a reduced resolution.
   *
   * The composited canvas is tone-mapped, dithered and grain-modulated, so it
   * is a poor basis for a determinism check or for recovering a ray-domain
   * fact. This returns the pre-grade radiance on a small grid — including the
   * alpha channel, which carries the disc-only luminance.
   *
   * Nothing calls this unless asked, so it costs production nothing.
   */
  probe(n = 64) {
    if (!this.built || this.contextIsLost) return null;
    const gl = this.gl;
    n = Math.max(8, Math.min(256, n | 0));
    this.probeRT = this.probeRT || this._makeRT(n, n, 'probe');
    const rt = this.probeRT;
    if (rt.width !== n || rt.height !== n) rt.setSize(n, n);

    const p = this.progDown.use();
    p.u1i('uSrc', 0);
    p.u2f('uTexel', 1 / this.width, 1 / this.height);
    this.renderer.setRenderTarget(rt);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(this.sceneRT));
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    const raw = new Uint16Array(n * n * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, n, n, raw);

    /* CRITICAL: unbind. Leaving a render target bound makes every later frame
       draw into the 64x64 probe buffer instead of the canvas — which silently
       invalidates any pixel measurement taken afterwards. */
    this.renderer.setRenderTarget(null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const f32 = new Float32Array(n * n * 4);
    for (let i = 0; i < raw.length; i++) f32[i] = halfToFloat(raw[i]);
    return { w: n, h: n, f32 };
  }

  /**
   * Full-resolution readback of the RGBA16F scene buffer.
   *
   * This is the only measurement in the project that sees the ray-domain result
   * before any display transform, which makes it the right instrument for
   * "which rays ended on the horizon?" (alpha is 1 for captured rays, 0.4 for
   * escaped ones, 0.05 for rays the disc stopped). It is slow — a 1264x649
   * float readback is 3.3 MB — so it is only ever used by the test harness.
   *
   * @returns {{width:number,height:number,f32:Float32Array}|null}
   */
  readSceneHDR() {
    if (!this.built || this.contextIsLost || !this.sceneRT) return null;
    const w = this.sceneRT.width, h = this.sceneRT.height;
    /* An RGBA16F target must be read with type = HALF_FLOAT into a Uint16Array.
       Handing readPixels a Float32Array here is silently wrong: the call is
       made with format RGBA / type HALF_FLOAT and the buffer is interpreted as
       half-floats, so every value decodes as 0 and the readback looks empty
       rather than failing. Decode explicitly with halfToFloat(). */
    const raw = new Uint16Array(w * h * 4);
    try {
      this.renderer.readRenderTargetPixels(this.sceneRT, 0, 0, w, h, raw);
    } catch (e) {
      return null;   // readback of this target type is unavailable
    }
    const f32 = new Float32Array(w * h * 4);
    for (let i = 0; i < raw.length; i++) f32[i] = halfToFloat(raw[i]);
    return { width: w, height: h, f32 };
  }

  destroy() {
    const kill = (rt) => { if (rt) { try { rt.dispose(); } catch (e) { /* ignore */ } } };
    kill(this.sceneRT); this.sceneRT = null;
    kill(this.probeRT); this.probeRT = null;
    (this.downRTs || []).forEach(kill); (this.upRTs || []).forEach(kill);
    this.downRTs = []; this.upRTs = [];
    [this.progScene, this.progPrefilter, this.progDown, this.progUp, this.progComposite]
      .forEach((p) => { if (p) { try { p.destroy(); } catch (e) { /* ignore */ } } });
    this.progScene = this.progPrefilter = this.progDown = this.progUp = this.progComposite = null;
    if (this.vertexArray && this.gl && !this.gl.isContextLost()) {
      try { this.gl.deleteVertexArray(this.vertexArray); } catch (e) { /* ignore */ }
    }
    this.vertexArray = null;
    this.built = false;
  }

  /** Full rebuild after a context loss/restore cycle. */
  rebuild(renderer) {
    if (renderer) this.renderer = renderer;
    this.gl = this.renderer.getContext();
    this.built = false;
    try { this.vertexArray = null; } catch (e) { /* ignore */ }
    const w = this.width, h = this.height, m = this.bloomMips;
    this.width = 0; this.height = 0;
    this._build({ width: w, height: h, bloomMips: m });
  }

  /* ---------------- sizing ---------------- */
  setSize(w, h, { bloomMips } = {}) {
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    if (bloomMips) this.bloomMips = Math.max(1, Math.min(MAX_MIPS, bloomMips | 0));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    if (!this.built) return;
    this.sceneRT.setSize(w, h);
    for (let i = 0; i < MAX_MIPS; i++) {
      const d = Math.pow(2, i + 1);
      const bw = Math.max(1, Math.floor(w / d));
      const bh = Math.max(1, Math.floor(h / d));
      this.downRTs[i].setSize(bw, bh);
      this.upRTs[i].setSize(bw, bh);
    }
  }

  /* ---------------- passes ---------------- */

  /* pass 1: the actual black hole */
  renderScene(u) {
    const gl = this.gl;
    const p = this.progScene.use();
    p.u2f('uResolution', this.width, this.height);
    p.u1f('uTime', u.time);
    p.u3f('uCamPos', u.camPos[0], u.camPos[1], u.camPos[2]);
    p.u3f('uCamRight', u.camRight[0], u.camRight[1], u.camRight[2]);
    p.u3f('uCamUp', u.camUp[0], u.camUp[1], u.camUp[2]);
    p.u3f('uCamFwd', u.camFwd[0], u.camFwd[1], u.camFwd[2]);
    p.u1f('uTanHalfFov', u.tanHalfFov);
    p.u1f('uAspect', this.width / this.height);
    p.u1f('uTimeScale', u.timeScale);
    p.u1f('uDiscOn', u.discOn);
    p.u1f('uMaxSteps', u.maxSteps);
    p.u1f('uBaseStep', u.baseStep);
    p.u1f('uStepScale', u.stepScale);
    p.u1f('uDiskCrossings', u.diskCrossings);
    p.u1f('uStarLayers', u.starLayers);
    p.u1f('uStarIter', u.starIter);
    p.u1f('uDebug', u.debug);
    const params = u.params;
    for (const k in params) p.u1f('u_' + k, params[k]);

    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear(true, false, false);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* passes 2-4: HDR bloom pyramid, returns the texture holding the result */
  renderBloom({ threshold, knee, clampMax, radius, mips }) {
    const gl = this.gl;
    const M = Math.max(1, Math.min(mips || this.bloomMips, MAX_MIPS, this.bloomMips));
    if (!this.sceneRT || !this.downRTs[0] || !this.upRTs[0]) {
      throw new Error('[GARGANTUA] bloom requested before the render targets exist');
    }
    /* the base level is sampled with explicit LODs, so it needs a mip chain */
    this.upRTs[0].texture.generateMipmaps = true;
    this.upRTs[0].texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.upRTs[0].texture.needsUpdate = true;

    /* --- prefilter: scene -> down[0] --- */
    let p = this.progPrefilter.use();
    p.u1i('uSrc', 0);
    p.u1f('uThreshold', threshold);
    p.u1f('uKnee', knee);
    p.u1f('uClamp', clampMax);
    p.u2f('uTexel', 1 / this.width, 1 / this.height);
    this.renderer.setRenderTarget(this.downRTs[0]);
    gl.activeTexture(gl.TEXTURE0);
    /* three.js allocates the underlying WebGL texture on first bind, so read
       the live handle through the renderer's properties rather than assuming
       rt.texture has already been realised */
    gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(this.sceneRT));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* --- downsample: down[i-1] -> down[i] --- */
    for (let i = 1; i < M; i++) {
      const prev = this.downRTs[i - 1];
      p = this.progDown.use();
      p.u1i('uSrc', 0);
      p.u2f('uTexel', 1 / prev.width, 1 / prev.height);
      this.renderer.setRenderTarget(this.downRTs[i]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(prev));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* --- copy the smallest mip into the top of the up chain --- */
    p = this.progDown.use();
    p.u1i('uSrc', 0);
    p.u2f('uTexel', 1 / this.downRTs[M - 1].width, 1 / this.downRTs[M - 1].height);
    this.renderer.setRenderTarget(this.upRTs[M - 1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(this.downRTs[M - 1]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* --- upsample: tent(up[i]) + down[i-1] -> up[i-1] --- */
    for (let i = M - 1; i > 0; i--) {
      const small = this.upRTs[i];
      const big = this.downRTs[i - 1];
      p = this.progUp.use();
      p.u1i('uSrc', 0);
      p.u1i('uAdd', 1);
      p.u2f('uTexel', 1 / small.width, 1 / small.height);
      p.u1f('uRadius', radius);
      this.renderer.setRenderTarget(this.upRTs[i - 1]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(small));
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(big));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.activeTexture(gl.TEXTURE0);
    /* Publish the pyramid as a real mip chain on the base level, so the
       composite can weight each octave separately with textureLod. Generating
       them here costs M-1 tiny blits and buys a much better-controlled glow:
       the wide, structureless tail of the pyramid can be attenuated instead of
       being added back at full weight as a veil over the whole frame. */
    const base = this.upRTs[0];
    if (base && base.texture.generateMipmaps === false) {
      for (let i = 1; i < M; i++) {
        const src = this.upRTs[i];
        if (!src || src.width > base.width) continue;
        this.renderer.copyTextureToTexture(
          src.texture, base.texture, null, null, i, 0
        );
      }
    }
    return base.texture;
  }
  /* pass 5: grade + present */
  composite(o) {
    const gl = this.gl;
    const p = this.progComposite.use();
    p.u1i('uScene', 0);
    p.u1i('uBloom', 1);
    p.u2f('uResolution', this.width, this.height);
    p.u1f('uTime', o.time);
    p.u1f('uExposure', o.exposure);
    p.u1f('uBloomStrength', o.bloomStrength);
    p.u1f('uBloomClamp', o.bloomClamp ?? 2.4);
    p.u1f('uBloomMips', o.bloomMips ?? 0);
    p.u1f('uDispersion', o.dispersion);
    p.u1f('uGrain', o.grain);
    p.u1f('uVignette', o.vignette);
    p.u1f('uDebug', o.debug);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(this.sceneRT));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textureHandle(o.bloomTex || this.sceneRT));

    this.renderer.setRenderTarget(null);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** One full frame. `u` is assembled by main.js. */
  frame(u) {
    if (!this.built || this.contextIsLost) return false;
    const gl = this.gl;
    this.renderer.autoClear = false;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, this.width, this.height);

    this.renderScene(u);

    let bloomTex = null;
    let bloomMips = 0;
    if (!u.probeMode && u.useBloom && u.bloomStrength > 0.001 && this.bloomMips > 0) {
      /* Cap the pyramid. The widest mips of a 7-level chain are only a few tens
         of pixels across, so they carry almost no structure — just the frame's
         mean brightness — and adding that back at full weight lays a faint
         circular veil over the whole image. Five levels already reach a ~60 px
         radius, which is as wide as a bloom lobe needs to be. */
      bloomMips = Math.min(this.bloomMips, 5);
      bloomTex = this.renderBloom({
        threshold: Math.max(u.bloomThreshold, 0),
        knee: 0.62,
        clampMax: 48.0,
        radius: 1.0,
        mips: bloomMips,
      });
    }

    this.composite({
      exposure: u.exposure,
      bloomStrength: bloomTex ? u.bloomStrength : 0,
      bloomClamp: 2.4,
      bloomMips: bloomTex ? bloomMips : 0,
      dispersion: u.dispersion,
      grain: u.grain,
      vignette: u.vignette,
      debug: u.debug,
      time: u.time,
      bloomTex,
    });
    this.frameCount++;
    return true;
  }
}
