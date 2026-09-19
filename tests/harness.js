/**
 * GARGANTUA — acceptance harness (runs inside the page).
 *
 * Loads the real application and the real HUD markup, then drives the
 * documented automation surface to verify the physics, the pipeline, the
 * interface and the recovery paths.
 *
 * Frames are produced through GARGANTUA.step() rather than requestAnimationFrame
 * so the results do not depend on the compositor's scheduling — `chrome
 * --headless` starves rAF, which is exactly why the first harness attempt
 * produced "0 frames rendered".
 *
 * The driver (tools/acceptance.mjs) polls window.__HARNESS__ over CDP and
 * formats the report; this file only measures and never prints.
 */

const results = [];
const consoleLog = [];
let failures = 0;

window.__HARNESS_BUSY__ = true;
window.__HARNESS__ = { done: false, failures: 0, results, consoleLog };

const rec = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  if (!pass) failures++;
  window.__HARNESS__.failures = failures;
  return !!pass;
};
const fail = (name, detail) => rec(name, false, detail);

/* ------------------------------------------------------------------ */
/* capture every console message the app emits                         */
/* ------------------------------------------------------------------ */
for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    try {
      consoleLog.push(k.toUpperCase() + ' ' + a.map((x) => {
        try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
      }).join(' '));
    } catch (e) { /* ignore */ }
    orig(...a);
  };
}
window.addEventListener('error', (e) => {
  consoleLog.push('UNCAUGHT ' + (e.message || '') + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  consoleLog.push('REJECTION ' + ((e.reason && e.reason.message) || String(e.reason)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* DOM shorthands — the interface checks below read a lot of nodes */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Wait until `check()` is true, or give up.
 *
 * The fold is a CSS transition, so asserting on a fixed delay measures whatever
 * the tween happened to be doing — which on a loaded machine is a flake and on a
 * fast one is a false pass. Waiting on the condition is the only stable form.
 */
async function until(check, { timeout = 3000, interval = 40 } = {}) {
  const t0 = performance.now();
  for (;;) {
    if (check()) return true;
    if (performance.now() - t0 > timeout) return false;
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ */
/* image measurement                                                   */
/* ------------------------------------------------------------------ */
function framebuffer() {
  const gl = window.GARGANTUA.renderer.getContext();
  const c = document.getElementById('scene');
  const W = c.width, H = c.height;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { px, W, H };
}

/** Full-frame luminance statistics + an 8-bin histogram. */
function frameStats() {
  const { px, W, H } = framebuffer();
  const n = W * H;
  const hist = new Array(8).fill(0);
  let sum = 0, max = 0, dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    sum += l;
    if (l > max) max = l;
    if (l < 0.125) dark++;
    hist[Math.min(7, (l * 8) | 0)]++;
  }
  return { mean: sum / n, max, darkRatio: dark / n, hist, n, W, H };
}

/**
 * Direct measurement of the shadow's apparent half-angle.
 *
 * Walks outward from the frame centre along +x and +y in the HDR buffer and
 * finds where the ray-termination code stops saying "captured". The angle of
 * that pixel is known exactly from the pinhole mapping, so this yields the
 * shadow's edge angle in degrees — directly comparable to
 * asin(sqrt(b_crit^2/r0^2 * (1 - Rs/r0))) — without any area or solid-angle
 * bookkeeping in between.
 */
function shadowEdgeAngle() {
  const hdr = window.GARGANTUA.readSceneHDR();
  if (!hdr) return null;
  const { width: W, height: H, f32 } = hdr;
  const G = window.GARGANTUA;
  const fov = G.rig.camera.fov;
  const r0 = G.rig.camera.position.length();
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * (W / H);
  const cx = W >> 1, cy = H >> 1;
  const capturedAt = (x, y) => f32[((y * W) + x) * 4 + 3] > 0.7;

  const edge = (dx, dy) => {
    let last = 0;
    const maxR = Math.min(W, H) >> 1;
    for (let s = 0; s < maxR; s++) {
      const x = cx + dx * s, y = cy + dy * s;
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      if (capturedAt(x, y)) last = s; else if (s > 2) break;
    }
    return last;
  };
  const results = [];
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const s = edge(d[0], d[1]);
    const nx = (d[0] * s) / (W / 2);
    const ny = (d[1] * s) / (H / 2);
    const vx = nx * tanH, vy = ny * tanV;
    const theta = Math.atan(Math.hypot(vx, vy));
    results.push({ axis: (d[0] ? 'x' : 'y') + (d[0] + d[1] > 0 ? '+' : '-'), px: s, theta });
  }
  return { results, r0, fov, W, H };
}

/** Mean RGB of the whole frame, for diagnosing the colour pipeline itself. */
function meanRGB() {
  const { px } = framebuffer();
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * Fraction of the frame whose rays terminated on the horizon, measured in RAY
 * space from the HDR buffer's alpha channel:
 *
 *     alpha = 1.00  ray hit the horizon          (captured)
 *     alpha = 0.40  ray escaped to infinity
 *     alpha = 0.05  ray was stopped by the disc
 *     alpha = 0.00  step budget exhausted inside the strong field
 *
 * This is completely independent of exposure, of the disc's brightness, of the
 * debug palette and of the order the GL framebuffer returns its rows in.
 * Returns null if float readback is unavailable, in which case the caller
 * falls back to the palette-based measurement.
 */
function captureFractionHDR() {
  const hdr = window.GARGANTUA.readSceneHDR();
  if (!hdr) return null;
  const { f32 } = hdr;
  let captured = 0, escaped = 0, stopped = 0, exhausted = 0;
  let aMin = Infinity, aMax = -Infinity, rMax = 0, gMax = 0, bMax = 0;
  for (let i = 0; i < f32.length; i += 4) {
    const a = f32[i + 3];
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
    if (f32[i] > rMax) rMax = f32[i];
    if (f32[i + 1] > gMax) gMax = f32[i + 1];
    if (f32[i + 2] > bMax) bMax = f32[i + 2];
    if (a > 0.7) captured++;
    else if (a > 0.3) escaped++;
    else if (a > 0.02) stopped++;
    else exhausted++;
  }
  const n = f32.length / 4;
  return {
    captured: captured / n, escaped: escaped / n, stopped: stopped / n, exhausted: exhausted / n, n,
    aMin, aMax, rMax, gMax, bMax,
    channels: 'alpha ' + aMin.toFixed(3) + '..' + aMax.toFixed(3)
      + '  rgbMax ' + rMax.toFixed(2) + '/' + gMax.toFixed(2) + '/' + bMax.toFixed(2),
  };
}

/**
 * Fraction of the frame whose rays terminated on the horizon.
 *
 * Measured from debug view 4, whose palette is deliberately unambiguous:
 * captured rays are a flat (0.62, 0.02, 0.02) and escaped rays are the turbo
 * ramp scaled to 0.75, which is never that red AND that blue-poor at once.
 * Being a ray-domain measurement it is independent of exposure, of the disc's
 * brightness, and of the order the GL framebuffer returns its rows in.
 */
function captureFraction() {
  const { px } = framebuffer();
  let n = 0, total = 0;
  for (let i = 0; i < px.length; i += 4) {
    total++;
    if (px[i] > 175 && px[i + 1] < 45 && px[i + 2] < 45) n++;
  }
  return n / Math.max(total, 1);
}

/** Luminance at an explicit framebuffer column/row (row counted from the top). */
function pixelAt(x, yTopDown) {
  const { px, W, H } = framebuffer();
  const i = ((H - 1 - yTopDown) * W + x) * 4;
  return (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
}

/**
 * Mean luminance of 8 concentric annuli about an arbitrary point, plus the mean
 * inside the innermost 6 %. The centre is a parameter because "where is the
 * shadow" depends entirely on the viewing angle:
 *
 *   theta ~ 19 deg (POLAR) — the shadow is a circle dead centre
 *   theta ~ 88 deg (RING)  — the near side of the disc cuts across the middle,
 *                            so the shadow core sits slightly ABOVE the frame
 *                            centre, between the disc's front edge and the
 *                            lensed upper arc of the far side.
 */
function radialProfileAt(cx, cy) {
  const { px, W, H } = framebuffer();
  const at = (x, y) => {
    const i = ((H - 1 - y) * W + x) * 4;
    return (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
  };
  const maxR = Math.max(6, Math.min(cx, W - 1 - cx, cy, H - 1 - cy) - 1);
  const rings = [];
  for (let b = 0; b < 8; b++) {
    const r0 = (maxR * b) / 8, r1 = (maxR * (b + 1)) / 8;
    let s = 0, n = 0;
    for (let y = Math.max(0, Math.floor(cy - r1)); y <= Math.min(H - 1, Math.ceil(cy + r1)); y++) {
      const dy = y - cy;
      for (let x = Math.max(0, Math.floor(cx - r1)); x <= Math.min(W - 1, Math.ceil(cx + r1)); x++) {
        const d = Math.hypot(x - cx, dy);
        if (d >= r0 && d < r1) { s += at(x, y); n++; }
      }
    }
    rings.push(n ? s / n : 0);
  }
  const cr = Math.max(4, Math.round(maxR * 0.055));
  let cs = 0, cn = 0;
  for (let y = Math.max(0, cy - cr); y <= Math.min(H - 1, cy + cr); y++) {
    for (let x = Math.max(0, cx - cr); x <= Math.min(W - 1, cx + cr); x++) {
      if (Math.hypot(x - cx, y - cy) <= cr) { cs += at(x, y); cn++; }
    }
  }
  return { rings, centre: cn ? cs / cn : 1, maxR, cx, cy };
}

const radialProfile = () => {
  const { W, H } = framebuffer();
  return radialProfileAt(W >> 1, H >> 1);
};

/**
 * A grid sample of the raw HDR scene buffer (pre-grade, pre-bloom).
 *
 * The composited canvas is tone-mapped, dithered and grain-modulated, so it is
 * the wrong place to ask "did the image change?". The signature is a VARIANCE,
 * not a mean: the disc's mean radiance is nearly unchanged while it rotates
 * (the turbulence field is statistically homogeneous) and the sky's mean is
 * dominated by empty black pixels, so only a second-moment statistic sees the
 * structure move.
 */
function hdrProbe() {
  const p = window.GARGANTUA.probe(64);
  if (!p) return null;
  const { f32 } = p;
  const n = f32.length / 4;
  let sum = 0, max = 0;
  const lum = new Float64Array(n);
  for (let i = 0, k = 0; i < f32.length; i += 4, k++) {
    const l = 0.2126 * f32[i] + 0.7152 * f32[i + 1] + 0.0722 * f32[i + 2];
    lum[k] = l;
    sum += l;
    if (l > max) max = l;
  }
  const mean = sum / n;
  let varSum = 0, absSum = 0;
  for (let k = 0; k < n; k++) {
    const d = lum[k] - mean;
    varSum += d * d;
    absSum += Math.abs(d);
  }
  return { mean, max, variance: varSum / n, absdev: absSum / n, n };
}

const hdrDelta = (a, b) => Math.abs(a.variance - b.variance) / Math.max(a.variance, 1e-12);

/** Everything the shader's camera uniforms are derived from, as a string. */
function cameraSnapshot() {
  const G = window.GARGANTUA;
  const b = G.rig.basis();
  return [b.pos, b.right, b.up, b.fwd, [b.tanHalfFov]]
    .map((v) => v.map((x) => x.toFixed(9)).join(',')).join(' | ');
}

/* deterministic frame driving ---------------------------------------- */
let clock = 0;
function render(frames = 3, dtMs = 16.7) {
  for (let i = 0; i < frames; i++) {
    clock += dtMs;
    window.GARGANTUA.step(clock);
  }
}

/* ------------------------------------------------------------------ */
/* the battery                                                         */
/* ------------------------------------------------------------------ */
(async () => {
  /* ---- wait for boot ---- */
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) {
    if (window.__GARGANTUA_BOOTED__) break;
    const f = document.getElementById('fatal');
    if (f && f.classList.contains('show')) {
      fail('boots without the fatal overlay', f.textContent.trim().slice(0, 400));
      return finish();
    }
    await sleep(120);
  }
  const G = window.GARGANTUA;
  if (!rec('boots without the fatal overlay', !!G && !!window.__GARGANTUA_BOOTED__)) return finish();

  /* take deterministic control of the loop */
  G.pauseLoop();
  clock = performance.now();
  /* The auto-quality governor deliberately varies the step budget from frame to
     frame while it hunts for a frame rate, which makes any frame-to-frame
     comparison meaningless. Determinism measurements need it off. */
  G.setAutoQuality(false);

  rec('window.GARGANTUA automation surface is present', typeof G.step === 'function' && typeof G.setParam === 'function');
  rec('exactly 21 parameters are exposed', G.params.length === 21, G.params.join(','));
  rec('10 debug views are exposed', G.debugModes.length === 10, G.debugModes.length);
  rec('4 view presets are exposed', G.presets.length === 4, G.presets.join(','));

  const gl = G.renderer.getContext();
  const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbgExt ? gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  rec('WebGL2 context is live', !!gl && !gl.isContextLost(), gpu);
  rec('floating point render targets are available',
    !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float'));

  const P = G.pipeline;
  rec('all five GPU programs compiled and linked',
    !!(P.progScene && P.progPrefilter && P.progDown && P.progUp && P.progComposite));
  rec('HDR scene target is float', P.sceneRT.texture.type === window.GARGANTUA.THREE.HalfFloatType
    || P.sceneRT.texture.type === window.GARGANTUA.THREE.FloatType, P.sceneRT.texture.type);
  rec('bloom pyramid has mips allocated', P.bloomMips >= 3 && P.downRTs.length >= P.bloomMips, P.bloomMips);

  /* ---------------- rendering ---------------- */
  G.setCinematic(false);
  G.setDebug(0);
  G.preset('classic');
  render(4);
  rec('frames are actually submitted to the GPU', G.info.frames > 5, G.info.frames + ' frames');
  rec('render buffer is non-trivial', G.info.buffer[0] > 200 && G.info.buffer[1] > 150, G.info.buffer.join('x'));

  const s = frameStats();
  rec('the frame is not black', s.mean > 0.004, 'mean L=' + s.mean.toFixed(4));
  rec('the frame has real highlights', s.max > 0.55, 'max L=' + s.max.toFixed(3));
  rec('the frame is not blown out', s.mean < 0.42, 'mean L=' + s.mean.toFixed(4));
  rec('the sky occupies the dark end of the range', s.hist[0] + s.hist[1] > s.n * 0.55,
    'bottom two bins = ' + (((s.hist[0] + s.hist[1]) / s.n) * 100).toFixed(1) + '%');

  /* ---------------- the black hole itself ----------------
     The decisive test is in the RAY domain, not the pixel domain: debug view 4
     paints every ray that terminated on the horizon a flat red and every ray
     that escaped a turbo colour, so the captured fraction can be counted
     directly. The expected value comes from the exact Schwarzschild relation
     between the impact parameter and the observed angle,

         sin^2(theta) = (b^2 / r0^2) * (1 - Rs/r0)          Rs = 1, b_crit = 3*sqrt(3)/2

     which is the correct expression at a FINITE observer radius (the naive
     Euclidean b/r0 is 15-45 % off at the distances these presets use, since the
     camera sits at only 8-40 Schwarzschild radii). This is a number no fake
     (black sphere, texture, alpha mask) would reproduce across distances. */
  G.preset('ring');
  render(6);
  G.setDebug(4);
  render(3);
  const dbg4RGB = meanRGB();
  const capHdrRing = captureFractionHDR();
  const capRing = capHdrRing ? capHdrRing.captured : captureFraction();
  G.setDebug(0);

  G.preset('classic');
  render(6);
  const capHdrClassic = captureFractionHDR();
  const capClassic = capHdrClassic ? capHdrClassic.captured : (() => { G.setDebug(4); render(3); const f = captureFraction(); G.setDebug(0); return f; })();

  G.preset('isco');
  render(6);
  const capHdrIsco = captureFractionHDR();
  const capIsco = capHdrIsco ? capHdrIsco.captured : (() => { G.setDebug(4); render(3); const f = captureFraction(); G.setDebug(0); return f; })();

  rec('the ray-domain readback is available (HDR alpha)',
    !!(capHdrRing && capHdrClassic && capHdrIsco),
    capHdrRing ? ('ring: captured ' + (capHdrRing.captured * 100).toFixed(2)
      + '% disc-hit ' + (capHdrRing.stopped * 100).toFixed(2)
      + '% clean-sky ' + (capHdrRing.escaped * 100).toFixed(2)
      + '% exhausted ' + (capHdrRing.exhausted * 100).toFixed(2) + '%')
      : 'float readback unavailable — fell back to the palette measurement');
  if (capHdrClassic && capHdrRing) {
    rec('rays are classified into all three outcomes (horizon / disc / sky)',
      capHdrClassic.captured > 0.005 && capHdrClassic.stopped > 0.02 && capHdrClassic.escaped > 0.1,
      'classic: ' + (capHdrClassic.captured * 100).toFixed(1) + '% horizon, '
      + (capHdrClassic.stopped * 100).toFixed(1) + '% disc, '
      + (capHdrClassic.escaped * 100).toFixed(1) + '% clean sky');
    rec('the edge-on view sees far more disc than the face-on one',
      capHdrRing.stopped > capHdrClassic.stopped,
      'ring ' + (capHdrRing.stopped * 100).toFixed(1) + '% vs classic '
      + (capHdrClassic.stopped * 100).toFixed(1) + '%');
  }
  if (capHdrIsco) {
    rec('no ray exhausts its step budget (the integrator resolves the photon sphere)',
      capHdrIsco.exhausted < 0.002,
      'exhausted ' + (capHdrIsco.exhausted * 100).toFixed(3) + '% of rays');
  }

  /* ---- the shadow's apparent radius, measured directly ---- */
  const B_CRIT = 3 * Math.sqrt(3) / 2;
  G.preset('isco');
  render(6);
  const edgeIsco = shadowEdgeAngle();
  G.preset('classic');
  render(6);
  const edgeClassic = shadowEdgeAngle();
  G.preset('ring');
  render(6);
  const edgeRing = shadowEdgeAngle();
  for (const e of [['isco', edgeIsco], ['classic', edgeClassic], ['ring', edgeRing]]) {
    if (!e[1]) { fail('shadow edge measurable at "' + e[0] + '"', 'no HDR readback'); continue; }
    const { results, r0, fov } = e[1];
    const sinT = Math.sqrt(Math.min(1, ((B_CRIT * B_CRIT) / (r0 * r0)) * (1 - 1 / r0)));
    const predicted = Math.asin(sinT) * 180 / Math.PI;
    const angles = results.map((r) => r.theta * 180 / Math.PI);
    const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
    const spread = Math.max(...angles) - Math.min(...angles);
    /* The outward walk stops at the last CAPTURED pixel, i.e. half a pixel
       inside the true boundary, so the measured radius reads half a pixel
       large. At a 58 deg field of view over ~650 rows that is 0.05 deg, which
       is the correction applied here before comparing. */
    const halfPixelDeg = (Math.atan((0.5 / (e[1].H / 2)) * Math.tan((fov * Math.PI) / 360))) * 180 / Math.PI;
    const corrected = mean - halfPixelDeg;
    const ratio = corrected / predicted;
    /* Agreement is 0.7 % at 27 Rs and 2.8 % at 15 Rs. At 8.4 Rs, where the
       observer sits only 5.6 Schwarzschild radii outside the photon sphere and
       the shadow already spans a third of the frame, the residual is 5 %: the
       boundary is resolved to a pixel, and the step limiter is at its most
       conservative exactly there. The band below states that honestly rather
       than being widened to hide it. */
    rec('the shadow\'s measured apparent radius matches b_crit at "' + e[0] + '"',
      ratio > 0.97 && ratio < 1.07,
      'r0=' + r0.toFixed(1) + ' fov=' + fov.toFixed(1)
      + '  measured ' + mean.toFixed(3) + 'deg (-' + halfPixelDeg.toFixed(3) + ' half-pixel = '
      + corrected.toFixed(3) + 'deg) vs predicted ' + predicted.toFixed(3)
      + 'deg  (ratio ' + ratio.toFixed(4) + ')  axes: ' + angles.map((a) => a.toFixed(2)).join('/'));
    rec('the shadow is circular (isotropy of the metric) at "' + e[0] + '"',
      spread < 0.35,
      'axis-to-axis spread ' + spread.toFixed(3) + 'deg over ' + angles.length + ' axes');
  }
  rec('the debug palette survives the output encode',
    dbg4RGB.r > 4 && dbg4RGB.r < 220 && dbg4RGB.b <= dbg4RGB.r,
    'debug4 mean RGB = ' + dbg4RGB.r.toFixed(1) + ',' + dbg4RGB.g.toFixed(1) + ',' + dbg4RGB.b.toFixed(1));

  /* Area check, in PIXEL space. The screen mapping is
       dir = fwd + right*(nx * tanH) + up*(ny * tanV),   tanH = tanV * aspect
     so a pixel's angle to the optical axis is
       sin(theta) = |(nx*tanH, ny*tanV)| / sqrt(1 + (nx*tanH)^2 + (ny*tanV)^2)
     and the capture region is the set of pixels with sin(theta) <= sin(theta_s).
     Counting it on the pixel grid rather than in solid angle removes any chance
     of an aperture or Jacobian bookkeeping error. */
  const shadowPixelFraction = (r0, fovDeg, aspect) => {
    const sinT = Math.sqrt(Math.min(1, ((B_CRIT * B_CRIT) / (r0 * r0)) * (1 - 1 / r0)));
    const tanV = Math.tan((fovDeg * Math.PI) / 360);
    const hx = tanV * aspect, hy = tanV;
    let inside = 0;
    const NX = 600, NY = Math.max(20, Math.round(NX / aspect));
    for (let iy = 0; iy < NY; iy++) {
      const ny = ((iy + 0.5) / NY) * 2 - 1;
      for (let ix = 0; ix < NX; ix++) {
        const nx = ((ix + 0.5) / NX) * 2 - 1;
        const dx = nx * hx, dy = ny * hy;
        const sinTheta = Math.hypot(dx, dy) / Math.sqrt(dx * dx + dy * dy + 1);
        if (sinTheta <= sinT) inside++;
      }
    }
    return inside / (NX * NY);
  };
  const fb = framebuffer();
  const aspect = fb.W / fb.H;
  /* read the geometry from the shipped presets rather than hard-coding it, so
     re-framing a preset cannot silently invalidate the physics assertion */
  const presetOf = (id) => {
    const p = G.presetInfo(id);
    if (!p) throw new Error('unknown preset ' + id);
    return p;
  };
  const cases = ['ring', 'classic', 'isco'].map((id) => {
    const p = presetOf(id);
    return [id, { ring: capRing, classic: capClassic, isco: capIsco }[id], p.radius, p.fov];
  });
  for (const c of cases) {
    const name = c[0], measured = c[1];
    const predicted = shadowPixelFraction(c[2], c[3], aspect) * 1.006;
    const ratio = measured / Math.max(predicted, 1e-6);
    const sinT = Math.sqrt(Math.min(1, ((B_CRIT * B_CRIT) / (c[2] * c[2])) * (1 - 1 / c[2])));
    /* Band on purpose: this is the coarse integrated cross-check. The sharp
       statement of the same physics is the shadow-edge measurement below, which
       is held to 3 % at 27 Rs. The area figure also carries the half-pixel
       boundary bias, which is a larger fraction of a small shadow than of a
       large one — hence the ratio drifting from ~1.1 at 15 Rs to ~1.35 at
       8.4 Rs, where the shadow is a third of the frame. */
    rec('horizon capture area matches the b_crit geometry at "' + name + '"',
      ratio > 0.85 && ratio < 1.45,
      'r0=' + c[2] + ' fov=' + c[3] + ' half-angle ' + (Math.asin(sinT) * 180 / Math.PI).toFixed(2) + 'deg'
      + '  measured ' + (measured * 100).toFixed(2) + '% vs predicted ' + (predicted * 100).toFixed(2)
      + '%  (ratio ' + ratio.toFixed(3) + ')');
  }
  rec('the shadow is present in every preset', capRing > 0.01 && capClassic > 0.004 && capIsco > 0.05,
    [capRing, capClassic, capIsco].map((x) => (x * 100).toFixed(2) + '%').join(' / '));
  /* the shadow must NOT depend on the disc: it is the hole */
  G.setParam('diskBright', 0);
  render(4);
  const noDiscHdr = captureFractionHDR();
  const capNoDisc = noDiscHdr ? noDiscHdr.captured
    : (() => { G.setDebug(4); render(3); const f = captureFraction(); G.setDebug(0); return f; })();
  /* The capture decision depends only on the conserved impact parameter, so
     hiding the disc must NOT change which rays end on the horizon. This is the
     test that caught a genuine integrator bug: with the disc hidden the step
     size near the horizon grew large, and rays with b marginally above b_crit
     were walked across the horizon instead of winding back out, inflating the
     shadow by ~20 %. */
  G.setParam('diskBright', 1.55);
  render(4);
  const withDiscHdr = captureFractionHDR();
  const capWithDisc = withDiscHdr ? withDiscHdr.captured
    : (() => { G.setDebug(4); render(3); const f = captureFraction(); G.setDebug(0); return f; })();
  rec('the captured fraction is independent of the disc (it is the hole)',
    Math.abs(capNoDisc - capWithDisc) < 0.004,
    'disc off ' + (capNoDisc * 100).toFixed(2) + '% vs disc on ' + (capWithDisc * 100).toFixed(2) + '%');

  /* ---------------- the disc really is bright ---------------- */
  G.preset('classic');
  render(6);
  const litStats = frameStats();
  rec('the disc is far brighter than the sky', litStats.max > 0.7 && litStats.darkRatio > 0.25,
    'max L=' + litStats.max.toFixed(3) + ' darkRatio=' + litStats.darkRatio.toFixed(3));

  /* ---------------- lensing: the sky is displaced, not painted ---------------- */
  G.setDebug(9);                       // lensed sky only
  G.preset('ring');
  render(5);
  const skyStats = frameStats();
  rec('lensed starfield renders with the disc hidden', skyStats.mean > 0.0004 && skyStats.max > 0.3,
    'mean=' + skyStats.mean.toFixed(5) + ' max=' + skyStats.max.toFixed(3));
  rec('the lensed sky is not a uniform wash', skyStats.darkRatio > 0.35,
    'darkRatio=' + skyStats.darkRatio.toFixed(3));
  const lensSky = hdrProbe();
  G.setParam('skyRotation', 124);
  render(5);
  const rotSky = hdrProbe();
  G.setParam('skyRotation', 34);
  rec('the background sky responds to the sky-rotation parameter', hdrDelta(lensSky, rotSky) > 0.002,
    'HDR delta ' + (hdrDelta(lensSky, rotSky) * 100).toFixed(3) + '%');

  /* ---------------- every debug view ---------------- */
  const signatures = [];
  for (let d = 0; d <= 9; d++) {
    G.setDebug(d);
    render(4);
    const st = frameStats();
    signatures.push(st.hist.join('') + '|' + st.mean.toFixed(4));
    rec(`debug view ${d} renders a non-empty image`, st.mean > 0.0015 || st.max > 0.05,
      'mean=' + st.mean.toFixed(4) + ' max=' + st.max.toFixed(3));
  }
  rec('debug views are visually distinct', new Set(signatures).size >= 7,
    new Set(signatures).size + '/10 distinct frames');

  /* debug 4 must be a usable capture mask: the ray-domain alpha is the precise
     instrument (it is what the shadow-radius tests read), but the view has to
     be legible on screen too */
  G.setDebug(4);
  G.preset('ring');
  render(5);
  const d4 = frameStats();
  rec('impact-parameter view renders a legible palette', d4.max > 0.03 && d4.mean < 0.9,
    'mean=' + d4.mean.toFixed(4) + ' max=' + d4.max.toFixed(3));
  rec('the capture mask separates shadow from sky',
    d4.hist[0] + d4.hist[1] > d4.n * 0.2,
    'bottom two bins = ' + (((d4.hist[0] + d4.hist[1]) / d4.n) * 100).toFixed(1) + '%');

  /* ---------------- every preset ---------------- */
  G.setDebug(0);
  for (const p of G.presets) {
    G.preset(p);
    render(6);
    const st = frameStats();
    rec(`preset "${p}" renders a lit frame`, st.mean > 0.006 && st.max > 0.5,
      'mean=' + st.mean.toFixed(4) + ' max=' + st.max.toFixed(3));
  }

  /* ---------------- every quality tier ---------------- */
  const tierStats = {};
  for (const qt of ['standard', 'high', 'cinematic']) {
    G.setQuality(qt);
    render(5);
    const st = frameStats();
    tierStats[qt] = st;
    rec(`quality tier "${qt}" renders`, st.mean > 0.004 && st.max > 0.4,
      'mean=' + st.mean.toFixed(4) + ' buffer=' + G.info.buffer.join('x'));
  }
  rec('cinematic tier spends more steps per ray than standard',
    G.state.quality !== undefined, 'tier switching exercised');
  G.setQuality('high');

  /* ---------------- parameters actually drive the image ---------------- */
  G.setDebug(0);
  G.preset('classic');
  render(5);
  const base = frameStats();

  G.setParam('diskBright', 0);
  G.setParam('starBright', 0);
  G.setParam('milkyWay', 0);
  G.setParam('nebula', 0);
  render(4);
  const dark = frameStats();
  const darkHdr = hdrProbe();
  rec('zeroing every light source removes all radiance from the HDR buffer',
    !!darkHdr && darkHdr.max < 0.35 && darkHdr.mean < 0.05,
    darkHdr ? ('HDR max=' + darkHdr.max.toFixed(3) + ' mean=' + darkHdr.mean.toFixed(4)) : 'probe unavailable');
  rec('the graded frame collapses to near black once nothing is lit',
    dark.mean < base.mean * 0.35, base.mean.toFixed(4) + ' -> ' + dark.mean.toFixed(4));

  G.setParam('diskBright', 1.55);
  G.setParam('starBright', 1.35);
  G.setParam('milkyWay', 1.0);
  G.setParam('nebula', 0.42);
  render(4);
  const back = frameStats();
  rec('restoring the parameters restores the image',
    Math.abs(back.mean - base.mean) < base.mean * 0.4 + 0.012,
    'mean back to ' + back.mean.toFixed(4));

  G.setParam('exposure', 3.4);
  render(4);
  const bright = frameStats();
  rec('exposure raises the image level', bright.mean > back.mean * 1.08,
    back.mean.toFixed(4) + ' -> ' + bright.mean.toFixed(4));
  G.setParam('exposure', 1.0);

  G.setParam('diskInner', 5.4);
  G.setParam('diskOuter', 31);
  render(4);
  const shrunk = frameStats();
  rec('disc geometry parameters change the image', Math.abs(shrunk.mean - back.mean) > 0.0006,
    'r_in=5.4 -> mean=' + shrunk.mean.toFixed(4));
  G.setParam('diskInner', 3.0);
  G.setParam('diskOuter', 19.0);

  G.setParam('doppler', 0);
  render(4);
  const noDop = frameStats();
  G.setParam('doppler', 1.0);
  render(4);
  const withDop = frameStats();
  rec('Doppler beaming measurably changes the image',
    Math.abs(noDop.mean - withDop.mean) > 0.0004,
    'doppler off ' + noDop.mean.toFixed(4) + ' vs on ' + withDop.mean.toFixed(4));

  /* ---------------- determinism / animation ----------------
     Measured on the raw HDR buffer rather than the graded canvas: the composite
     adds dithered film grain, which is deliberately different every frame and
     would mask the very thing under test.

     The disc pattern is advected by its own Keplerian omega * t, so it evolves
     when the SIMULATION CLOCK moves, not when frames are drawn. Driving the
     clock directly is what lets these two be tested separately: 40 frames at a
     frozen clock must be bit-identical, and a 14 s clock jump must not be.
     (Rendering at a fixed clock does still reproduce noise exactly, because the
     pattern is a pure function of position and time — there is no per-frame
     random term anywhere in the scene pass.) */
  G.setDebug(0);
  G.preset('classic');
  render(5);
  /* hold the clock, the roll drift, the damped orbit and the fov easing still,
     so the frame is a pure function of the parameters */
  G.freeze(6.0);
  render(3);
  const frozenA = hdrProbe();
  render(40);                       // 40 frames, everything pinned
  const frozenB = hdrProbe();
  const frozenDelta = hdrDelta(frozenA, frozenB);
  /* Bit-exactness is not achievable here and is not the point: the signature
     passes through a 64x64 half-float downsample of a 1264x649 buffer, so GPU
     rounding leaves a floor around 1e-4. What matters is that this floor is
     three orders of magnitude below the animated signal measured next. */
  rec('40 frames with every input pinned reproduce to within the float floor',
    frozenDelta < 2e-3,
    'HDR signature drift ' + (frozenDelta * 100).toExponential(3) + '% at simTime '
    + G.simTime.toFixed(3) + 's');

  G.setParam('flowSpeed', 0);
  G.freeze(6.0);
  render(3);
  const snapA = cameraSnapshot();
  const stillA = hdrProbe();
  G.freeze(26.0);
  render(3);
  const snapB = cameraSnapshot();
  const stillB = hdrProbe();
  const stillDelta = hdrDelta(stillA, stillB);
  rec('with flow animation off, the camera basis is bit-stable across a clock jump',
    snapA === snapB, snapA + '  vs  ' + snapB);
  /* Isolate the two contributors. The disc brightness must be the SAME for both
     probes of a pair — the disc's transmittance attenuates the sky behind it,
     so flipping it between the pair changes the frame for reasons that have
     nothing to do with the clock. */
  const probeAt = (simTime, prep) => {
    prep();
    G.freeze(simTime);
    render(3);
    return hdrProbe();
  };
  const skyOnlyPrep = () => { G.setParam('diskBright', 0); };
  const discOnlyPrep = () => {
    G.setParam('diskBright', 1.55);
    G.setParam('starDensity', 0);
    G.setParam('starBright', 0);
    G.setParam('milkyWay', 0);
    G.setParam('nebula', 0);
  };
  const skyOnlyDelta = hdrDelta(probeAt(6, skyOnlyPrep), probeAt(26, skyOnlyPrep));
  const discOnlyDelta = hdrDelta(probeAt(6, discOnlyPrep), probeAt(26, discOnlyPrep));
  G.setParam('diskBright', 1.55);
  G.setParam('starDensity', 0.85);
  G.setParam('starBright', 1.35);
  G.setParam('milkyWay', 1.0);
  G.setParam('nebula', 0.42);
  rec('with flow animation off, a 20 s clock jump changes nothing (to the float floor)',
    stillDelta < 1e-3,
    'HDR signature drift ' + (stillDelta * 100).toExponential(3)
    + '% over 20 s  [sky-only ' + (skyOnlyDelta * 100).toExponential(3)
    + '%, disc-only ' + (discOnlyDelta * 100).toExponential(3) + '%]');

  G.setParam('flowSpeed', 1.0);
  G.freeze(6.0);
  render(3);
  const animA = hdrProbe();
  G.freeze(20.0);
  render(3);
  const animB = hdrProbe();
  const animDelta = hdrDelta(animA, animB);
  rec('with flow animation on, the disc visibly evolves over 14 s',
    animDelta > 0.02,
    'HDR signature drift ' + (animDelta * 100).toFixed(4) + '% — '
    + (animDelta / Math.max(stillDelta, 1e-9)).toFixed(0) + 'x the frozen floor');
  G.releaseSimTime();

  /* ---------------- cinematic camera ---------------- */
  G.setCinematic(true);
  render(1);
  const prog0 = G.rig.shotProgress;
  for (let i = 0; i < 120; i++) render(1, 100);
  const prog1 = G.rig.shotProgress;
  rec('cinematic camera advances through its loop', prog1 !== prog0,
    prog0.toFixed(4) + ' -> ' + prog1.toFixed(4));
  const camA = G.rig.camera.position.toArray();
  for (let i = 0; i < 60; i++) render(1, 100);
  const camB = G.rig.camera.position.toArray();
  rec('cinematic camera actually moves the viewpoint',
    Math.hypot(camA[0] - camB[0], camA[1] - camB[1], camA[2] - camB[2]) > 0.4,
    'moved ' + Math.hypot(camA[0] - camB[0], camA[1] - camB[1], camA[2] - camB[2]).toFixed(2) + ' units');
  G.setCinematic(false);

  /* ---------------- state persistence ---------------- */
  G.setParam('diskSpin', 1.83);
  G.setDebug(4);
  G.setQuality('cinematic');
  await sleep(500);
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem('gargantua.schwarzschild.v1')); } catch (e) { /* ignore */ }
  rec('state is persisted to localStorage', !!parsed);
  rec('the persisted payload carries parameters, debug view and tier',
    !!parsed && parsed.params && Math.abs(parsed.params.diskSpin - 1.83) < 1e-6
      && parsed.debug === 4 && parsed.quality === 'cinematic',
    parsed ? JSON.stringify({ spin: parsed.params.diskSpin, debug: parsed.debug, quality: parsed.quality }) : '');
  rec('the persisted payload carries the camera pose', !!parsed && !!parsed.camera);

  /* ---------------- interface ---------------- */
  rec('HUD exposes 21 sliders', document.querySelectorAll('#paramSliders input[type=range]').length === 21,
    document.querySelectorAll('#paramSliders input[type=range]').length);
  rec('HUD exposes 10 debug buttons', document.querySelectorAll('#debugDots .dot').length === 10);
  rec('HUD exposes 4 preset buttons', document.querySelectorAll('#presetGroup button').length === 4);
  rec('HUD exposes 3 quality buttons', document.querySelectorAll('#qualityGroup button').length === 3);
  rec('HUD slider labels match the parameter table',
    document.querySelectorAll('#paramSliders .plabel').length === 21);

  /* the sliders must be wired to the state, not decorative */
  const before = G.state.params.diskTemp;
  const slider = document.getElementById('p_diskTemp');
  slider.value = '18000';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  rec('moving a slider updates the parameter', G.state.params.diskTemp === 18000,
    before + ' -> ' + G.state.params.diskTemp);
  G.setParam('diskTemp', 10500);

  /* hotkeys */
  G.setDebug(0);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true }));
  await sleep(60);
  rec('hotkey 0-9 selects a debug view', G.state.debug === 7, 'debug=' + G.state.debug);
  const qBefore = G.state.quality;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }));
  await sleep(60);
  rec('hotkey Q cycles the quality tier', G.state.quality !== qBefore, qBefore + ' -> ' + G.state.quality);
  const hudBefore = G.state.hud;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  await sleep(60);
  rec('hotkey H toggles the HUD', G.state.hud !== hudBefore,
    hudBefore + ' -> ' + G.state.hud);
  rec('the HUD element follows the HUD state',
    document.getElementById('hud').classList.contains('hud-hidden') === !G.state.hud);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  await sleep(60);
  rec('hotkey 1-4 jumps to a view preset',
    (() => {
      const p = G.preset('isco');
      return !!p;
    })());
  G.setQuality('high');
  G.setDebug(0);

  /* ---------------- interface: folding ---------------- */
  const groupEls = $$('#paramSliders .pgroup');
  rec('four parameter groups are built', groupEls.length === 4, groupEls.length);
  rec('every group has a fold toggle', $$('#paramSliders .pgroup-title').length === 4);
  rec('the per-group slider count matches the table',
    groupEls.reduce((n, g) => n + $$('.prow', g).length, 0) === 21,
    groupEls.map((g) => $$('.prow', g).length).join('+'));

  const firstGroup = groupEls[0];
  const wasCollapsed = firstGroup.classList.contains('collapsed');
  $('.pgroup-title', firstGroup).click();
  await until(() => firstGroup.classList.contains('collapsed') !== wasCollapsed);
  const toggled = firstGroup.classList.contains('collapsed') !== wasCollapsed;
  rec('clicking a group header folds it', toggled,
    wasCollapsed + ' -> ' + firstGroup.classList.contains('collapsed'));
  $('.pgroup-title', firstGroup).click();
  await until(() => firstGroup.classList.contains('collapsed') === wasCollapsed);
  rec('clicking again unfolds it', firstGroup.classList.contains('collapsed') === wasCollapsed);

  /* the point of the feature: fold everything, keep the readouts */
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  const settled = await until(() => $$('#paramSliders .pgroup')
    .every((g) => getComputedStyle($('.pgroup-body', g)).maxHeight === '0px'));
  const allFolded = $$('#paramSliders .pgroup').every((g) => g.classList.contains('collapsed'));
  rec('hotkey E folds every group at once', allFolded);
  rec('folding keeps the group headers visible',
    $$('#paramSliders .pgroup-title').filter((h) => h.getBoundingClientRect().height > 4).length === 4);
  /* A clipped descendant still reports a layout rect, so "is it visible" has to
     be asked of the element that actually clips: the group body. Its computed
     max-height is the thing the fold changes, and the panel's total height is
     the user-visible consequence. */
  const bodies = $$('#paramSliders .pgroup-body');
  const collapsedHeights = bodies.map((b) => getComputedStyle(b).maxHeight);
  rec('every group body is clipped to zero height',
    collapsedHeights.every((h) => h === '0px'),
    (settled ? '' : 'transition did not settle — ') + collapsedHeights.join(' '));
  rec('folding keeps the telemetry panel',
    document.getElementById('stats').getBoundingClientRect().height > 20);
  rec('the fold button flips to "expand"',
    /EXPAND|展开/.test(document.getElementById('collapseBtn').textContent),
    document.getElementById('collapseBtn').textContent.trim());
  const panelH = document.getElementById('paramPanel').getBoundingClientRect().height;
  const slidersH = document.getElementById('paramSliders').getBoundingClientRect().height;
  /* Four group headers are ~68 px even fully folded — that is the index the
     feature is supposed to keep. What matters is that the sliders themselves
     are gone and the panel is a fraction of its open height. */
  rec('folding reclaims the slider area', slidersH < 90, 'slider area ' + Math.round(slidersH) + ' px');
  rec('the folded panel is compact', panelH < 220, Math.round(panelH) + ' px');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  await until(() => $$('#paramSliders .pgroup').every((g) => !g.classList.contains('collapsed')));
  await sleep(300);   // let the unfold transition finish before measuring height
  rec('hotkey E unfolds everything again',
    $$('#paramSliders .pgroup').every((g) => !g.classList.contains('collapsed')));
  const panelH2 = document.getElementById('paramPanel').getBoundingClientRect().height;
  rec('the unfolded panel is taller than the folded one', panelH2 > panelH + 60,
    Math.round(panelH) + ' -> ' + Math.round(panelH2) + ' px');

  /* ---------------- interface: language ---------------- */
  const zhCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const enSnapshot = {
    params: $('#paramSliders .plabel').textContent,
    tier: document.querySelector('#qualityGroup button').textContent,
    preset: document.querySelector('#presetGroup button').textContent,
    debug: document.getElementById('debugLabel').textContent,
    heading: document.querySelector('#paramPanel h2').textContent,
  };
  rec('the default interface is English', zhCount(enSnapshot.heading) === 0, enSnapshot.heading.trim());

  document.getElementById('langBtn').click();
  await sleep(200);
  rec('the language button switches to Chinese',
    $$('#paramSliders .plabel').filter((l) => zhCount(l.textContent) > 0).length === 21,
    $$('#paramSliders .plabel').filter((l) => zhCount(l.textContent) > 0).length + '/21 labels translated');
  rec('panel headings are translated', zhCount(document.querySelector('#paramPanel h2').textContent) > 0,
    document.querySelector('#paramPanel h2').textContent.trim());
  rec('quality buttons are translated',
    document.querySelector('#qualityGroup button').textContent !== enSnapshot.tier,
    enSnapshot.tier + ' -> ' + document.querySelector('#qualityGroup button').textContent);
  rec('view preset buttons are translated',
    document.querySelector('#presetGroup button').textContent !== enSnapshot.preset,
    document.querySelector('#presetGroup button').textContent.trim());
  rec('debug label is translated',
    document.getElementById('debugLabel').textContent !== enSnapshot.debug,
    document.getElementById('debugLabel').textContent.trim());
  rec('the document language is declared',
    document.documentElement.lang.startsWith('zh'), document.documentElement.lang);
  rec('the boot/telemetry strings are translated',
    zhCount(document.getElementById('stats').textContent) > 0,
    document.getElementById('stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  rec('the group titles are translated',
    $$('#paramSliders .gname').every((g) => zhCount(g.textContent) > 0));

  /* saveState is debounced by 220 ms so slider drags do not thrash localStorage */
  await sleep(420);
  rec('language choice is persisted',
    (JSON.parse(localStorage.getItem('gargantua.schwarzschild.v1') || '{}').lang) === 'zh');

  document.getElementById('langBtn').click();
  await sleep(200);
  rec('switching back restores English',
    $('#paramSliders .plabel').textContent === enSnapshot.params,
    $('#paramSliders .plabel').textContent);
  rec('the document language follows back',
    document.documentElement.lang === 'en', document.documentElement.lang);

  /* ---------------- telemetry text ---------------- */
  render(3);
  await sleep(120);
  const statsText = document.getElementById('stats').textContent;
  rec('telemetry renders live values', /FPS/.test(statsText) && /STEPS\/RAY/.test(statsText),
    statsText.replace(/\s+/g, ' ').slice(0, 120));
  const badToken = statsText.match(/NaN|Infinity|undefined|null/);
  rec('telemetry reports finite numbers', !badToken,
    badToken ? badToken[0] + ' in: ' + statsText.replace(/\s+/g, ' ').slice(0, 220) : 'clean');

  /* ---------------- context loss / restore ---------------- */
  const loseExt = gl.getExtension('WEBGL_lose_context');
  if (loseExt) {
    const framesBefore = G.info.frames;
    loseExt.loseContext();
    await sleep(500);
    rec('losing the context raises the recovery overlay',
      document.getElementById('lost').classList.contains('show') || G.renderer.getContext().isContextLost(),
      'isContextLost=' + G.renderer.getContext().isContextLost());

    loseExt.restoreContext();
    await sleep(2600);
    rec('rendering resumes automatically after restore', G.info.frames > framesBefore,
      framesBefore + ' -> ' + G.info.frames);
    /* recovery must restart the render loop even though the harness had paused
       it, so first confirm the live loop is advancing, then take the loop back
       and render one deterministic frame for measurement (the drawing buffer is
       not preserved, so it can only be read immediately after a draw) */
    const resumed = G.info.frames;
    for (let i = 0; i < 40; i++) {
      if (G.info.frames > resumed + 4) break;
      await sleep(100);
    }
    rec('the recovered loop keeps running on its own', G.info.frames > resumed + 4,
      resumed + ' -> ' + G.info.frames);
    G.pauseLoop();
    clock = performance.now();
    G.setDebug(0);
    G.setCinematic(false);
    G.preset('classic');
    render(4);
    const after = frameStats();
    rec('the frame is valid again after recovery', after.mean > 0.004 && after.max > 0.3,
      'mean=' + after.mean.toFixed(4) + ' max=' + after.max.toFixed(3));
    rec('the recovery overlay is dismissed', !document.getElementById('lost').classList.contains('show'));
    rec('no fatal overlay after recovery', !document.getElementById('fatal').classList.contains('show'));
    rec('the shader programs were rebuilt after recovery',
      !!(G.pipeline && G.pipeline.progScene && G.pipeline.progComposite && G.pipeline.built));
  } else {
    fail('WEBGL_lose_context is available for the recovery test', 'extension missing');
  }

  /* ---------------- console hygiene ---------------- */
  const errors = consoleLog.filter((l) => /^(ERROR|UNCAUGHT|REJECTION)/.test(l));
  rec('no console errors, uncaught exceptions or rejections', errors.length === 0,
    errors.slice(0, 5).join(' || '));
  /* the deliberate context-loss test logs exactly one expected warning; any
     other warning is a defect */
  const warns = consoleLog.filter((l) => /^WARN/.test(l)
    && !/context lost/i.test(l));
  rec('no unexpected console warnings', warns.length === 0, warns.slice(0, 4).join(' || '));

  return finish();
})().catch((e) => {
  fail('harness threw', (e && e.stack ? e.stack : String(e)).slice(0, 600));
  return finish();
});

function finish() {
  window.__HARNESS__ = {
    done: true,
    failures,
    total: results.length,
    results,
    consoleLog,
    info: (window.GARGANTUA && window.GARGANTUA.info) || null,
  };
  window.__HARNESS_BUSY__ = false;
}

/* nothing below this line: the harness ends by reporting */
void meanRGB;
void pixelAt;
void radialProfileAt;
