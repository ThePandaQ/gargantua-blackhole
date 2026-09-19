/**
 * GARGANTUA — post pipeline shaders.
 *
 *   scene(HDR RGBA16F)
 *     -> prefilter (soft-knee threshold)
 *     -> N x downsample (13-tap Call-of-Duty style)
 *     -> N x upsample   (9-tap tent)
 *     -> composite: exposure, bloom, spectral dispersion, ACES, vignette,
 *                   film grain, ordered dither, sRGB encode
 *
 * The composite also carries every debug view so that a single pass writes
 * the canvas.
 */

import { commonGLSL } from './common.js';

/* A fullscreen triangle generated from gl_VertexID: no attribute buffers and
   no VBOs at all, so there is nothing to bind and nothing to leak.
   The version directive must be the very first line of the source. */
export const fullscreenVert = /* glsl */`#version 300 es
precision highp float;
out vec2 vUv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/* Every fragment source below is GLSL ES 3.00 (WebGL2) and is prefixed with
   the version directive plus a default precision by the pipeline. They must not
   carry a version directive of their own, and `varying` is a reserved word in
   ES 3.00 — the interpolant is spelled `in vec2 vUv` in every fragment stage,
   matching the `out vec2 vUv` in the fullscreen vertex shader. */
export const shaderVersionHeader = '#version 300 es\n';

/** Prefix a fragment source with the ES 3.00 version directive. */
export const asFragment = (src, extra = '') => shaderVersionHeader + extra + src;

export const prefilterFrag = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

/* self-contained: the prefilter must not depend on the shared library */
float preLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c += texture(uSrc, vUv).rgb * 4.0;
  c /= 8.0;

  float l = preLum(c);
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  w = clamp(w, 0.0, 1.0) * step(1e-5, uThreshold + uKnee);

  c *= w;
  c = min(c, vec3(uClamp));
  fragColor = vec4(c, 1.0);
}
`;

export const downsampleFrag = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uSrc, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uSrc, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uSrc, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uSrc, vUv).rgb;
  vec3 f = texture(uSrc, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSrc, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uSrc, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uSrc, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uSrc, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSrc, vUv + t * vec2( 1.0, -1.0)).rgb;

  vec3 o = e * 0.125;
  o += (a + c + g + i) * 0.03125;
  o += (b + d + f + h) * 0.0625;
  o += (j + k + l + m) * 0.125;
  fragColor = vec4(o, 1.0);
}
`;

export const upsampleFrag = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;      // smaller mip being enlarged
uniform sampler2D uAdd;      // same-size mip accumulated so far
uniform vec2  uTexel;
uniform float uRadius;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 o = texture(uSrc, vUv).rgb * 4.0;
  o += texture(uSrc, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
  o += texture(uSrc, vUv + vec2( t.x,  0.0)).rgb * 2.0;
  o += texture(uSrc, vUv + vec2( 0.0, -t.y)).rgb * 2.0;
  o += texture(uSrc, vUv + vec2( 0.0,  t.y)).rgb * 2.0;
  o += texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb;
  o += texture(uSrc, vUv + vec2( t.x, -t.y)).rgb;
  o += texture(uSrc, vUv + vec2(-t.x,  t.y)).rgb;
  o += texture(uSrc, vUv + vec2( t.x,  t.y)).rgb;
  o *= (1.0 / 16.0);
  o += texture(uAdd, vUv).rgb;
  fragColor = vec4(o, 1.0);
}
`;

export const compositeFrag = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;

${commonGLSL}

uniform sampler2D uScene;     // HDR scene (a = disc luminance)
uniform sampler2D uBloom;     // blurred bloom pyramid, top mip
uniform vec2  uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uBloomClamp;
uniform float uBloomMips;
uniform float uDispersion;
uniform float uGrain;
uniform float uVignette;
uniform float uDebug;

vec3 sampleScene(vec2 uv) { return texture(uScene, clamp(uv, vec2(0.0015), vec2(0.9985))).rgb; }

float grainNoise(vec2 p, float t) {
  vec3 q = vec3(p * 2.71, t);
  float n = fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  return n;
}

void main() {
  vec2 uv = vUv;
  vec2 d  = uv - 0.5;
  float r2 = dot(d, d);

  vec4 s = texture(uScene, uv);
  vec3 col = s.rgb;
  /* s.a is the ray termination code written by the scene pass (1 = captured,
     0.4 = escaped, 0.05 = absorbed by the disc, 0 = step budget exhausted). */
  float termCode = s.a;
  if (termCode == 0.0) termCode = 0.4;   // guard against an unused sampler

  /* ---------------- debug views (post-tonemap so they stay legible) ------ */
  if (uDebug > 0.5) {
    if (uDebug < 1.5) {
      /* raw HDR: exposure + ACES, then a false-colour log-luminance overlay */
      vec3 lin = aces(col * uExposure);
      vec3 mapped = mix(srgbEncode(lin),
                        turbo(clamp(log2(max(luminance(lin), 1e-6)) * 0.22 + 0.5, 0.0, 1.0)),
                        0.55);
      fragColor = vec4(mapped, 1.0);
      return;
    }
    /* Every other AOV is already a display-referred palette. It still travels
       the same linear -> sRGB path as the beauty pass (the geometry pass writes
       linear light, the encode happens at the end of this function), so the
       palette is first pushed through the INVERSE transfer, and the encode at
       the end undoes it exactly. Writing the AOV straight through instead would
       add a gamma the palette never asked for, lifting the dark end of the ramp
       and flattening every debug view into mid grey. */
    fragColor = vec4(srgbToLinear(clamp(col, 0.0, 1.0)), 1.0);
    return;
  }

  /* ---------------- chromatic dispersion -------------------------------- *
     Separate radial scales per channel — a real lens has slightly different
     focal length per wavelength; here it also sells the gravitational
     gradient at the shadow edge.                                          */
  float amt = uDispersion * 0.010;
  if (amt > 1e-5) {
    col.r = sampleScene(uv + d * amt).r;
    col.b = sampleScene(uv - d * amt).b;
  }

  /* ---------------- exposure + bloom ------------------------------------ */
  col *= uExposure;
  /* Bloom is deliberately bypassed for the AOVs: a debug view is a measurement
     of the render, and smearing it with the beauty pass's glow both misleads
     the eye and destroys the sharp boundary the impact-parameter view exists to
     show. */
  /* Decay the contribution of each successive mip. The pyramid's widest levels
     hold almost no structure — only the frame's mean brightness — and adding
     that back at full weight lays a faint circular veil over the whole image.
     Weighting the wide, soft tail down keeps the tight glow around genuine
     highlights and drops the veil.

     The mip chain is written explicitly by the pipeline (each level is a
     downsample of the one before), so the eight taps below are all real. They
     are unrolled because textureLod's level argument has to be a constant
     expression in GLSL ES 3.00. */
  vec3 bloom = vec3(0.0);
  if (uDebug < 0.5) {
    float w = 1.0;
    bloom += textureLod(uBloom, uv, 0.0).rgb * w; w *= 0.65;
    if (uBloomMips > 1.0) { bloom += textureLod(uBloom, uv, 1.0).rgb * w; w *= 0.65; }
    if (uBloomMips > 2.0) { bloom += textureLod(uBloom, uv, 2.0).rgb * w; w *= 0.65; }
    if (uBloomMips > 3.0) { bloom += textureLod(uBloom, uv, 3.0).rgb * w; w *= 0.65; }
    if (uBloomMips > 4.0) { bloom += textureLod(uBloom, uv, 4.0).rgb * w; w *= 0.65; }
    if (uBloomMips > 5.0) { bloom += textureLod(uBloom, uv, 5.0).rgb * w; w *= 0.65; }
    if (uBloomMips > 6.0) { bloom += textureLod(uBloom, uv, 6.0).rgb * w; }
    bloom *= 0.62;
  }
  col += min(bloom * uBloomStrength, vec3(uBloomClamp));

  /* ---------------- grade ----------------------------------------------- */
  col = aces(col);

  /* vignette (natural cos^4-ish falloff plus a soft artistic stop) */
  float v = 1.0 - uVignette * (0.34 + 0.66 * smoothstep(0.10, 0.86, r2 * 1.9));
  col *= clamp(v, 0.0, 1.0);

  /* film grain — SCALED BY THE LOCAL LEVEL rather than added flat.
     A constant additive grain would put a ~0.07 floor across the whole frame
     and lift the event horizon off pure black. Multiplying instead keeps the
     grain strongest where the image has signal (the disc, the highlights) and
     lets it vanish inside the shadow, which is both more film-like and what
     keeps the hole genuinely black. */
  float gn = (grainNoise(uv * uResolution * 0.72, fract(uTime) * 91.7) - 0.5)
           + (grainNoise(uv * uResolution * 1.83 + 37.0, fract(uTime) * 57.3) - 0.5) * 0.5;
  float lum = luminance(col);
  col *= 1.0 + gn * uGrain * (0.05 + 0.30 * smoothstep(0.0, 0.5, lum));

  /* dither, applied as a signed rounding offset so it kills banding without
     moving the black point */
  float dth = grainNoise(uv * uResolution + 19.3, 0.5) - 0.5;
  col += dth / 255.0;

  fragColor = vec4(srgbEncode(clamp(col, 0.0, 1.0)), 1.0);
}
`;
