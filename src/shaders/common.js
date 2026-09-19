/**
 * GARGANTUA — shared GLSL fragments.
 *
 * These live in their own module because BOTH the scene pass and the composite
 * pass need them, and they must be injected as source text (WebGL2 has no
 * #include). Keeping them here rather than on a shared object keeps the
 * dependency graph honest: shaders/geodesic.js -> shaders/common.js.
 */

export const commonGLSL = /* glsl */`
/* ---- luminance in Rec.709 primaries ---- */
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* ---- analytic Planck locus (Tanner Helland fit, linear light, normalised).
        Used for the disc blackbody AND for stellar spectral class colour. ---- */
vec3 blackbodyRGB(float k) {
  float t = clamp(k, 900.0, 40000.0) / 100.0;
  float r, g, b;
  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(max(t, 1.0)) - 161.1195681661;
  } else {
    r = 329.698727446 * pow(max(t - 60.0, 1e-3), -0.1332047592);
    g = 288.1221695283 * pow(max(t - 60.0, 1e-3), -0.0755148492);
  }
  if (t >= 66.0)      b = 255.0;
  else if (t <= 19.0) b = 0.0;
  else                b = 138.5177312231 * log(max(t - 10.0, 1e-3)) - 305.0447927307;
  vec3 c = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  return c / max(luminance(c), 1e-3);
}

/* ---- ACES filmic (Narkowicz fit) ---- */
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/* ---- linear -> sRGB transfer ---- */
vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92,
             1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}

/* ---- sRGB -> linear transfer (exact inverse of srgbEncode) ---- */
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92,
             pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4)),
             step(vec3(0.04045), c));
}

/* ---- Turbo false-colour ramp (debug AOVs) ---- */
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c = vec3(0.0);
  c.r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  c.g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  c.b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return clamp(c, 0.0, 1.0);
}

/* ---- precision-safe hashing (sin() hashes break on tiled mobile GPUs) ---- */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;
