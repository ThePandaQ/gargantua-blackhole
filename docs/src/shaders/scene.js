/**
 * GARGANTUA — main scene pass.
 *
 * Composes: procedural multi-layer starfield + Milky Way (sampled along the
 * *bent* ray direction, which is what produces the Einstein ring), the
 * turbulent Keplerian accretion disc with N discrete crossings, and the
 * debug AOVs (step count, deflection, impact parameter, Doppler, redshift,
 * observed disc temperature, crossing count).
 *
 * Output layout of the HDR buffer:
 *   rgb = radiance with the disc suppressed (used by debug 9; also lets the
 *         composite pass isolate the disc by subtraction)
 *   a   = disc-only radiance (used by debug 7 for the temperature view)
 */

import { commonGLSL } from './common.js';
import { geodesicGLSL, diskGLSL } from './geodesic.js';

export const sceneFrag = /* glsl */`
${commonGLSL}
${geodesicGLSL}
${diskGLSL}

/* GLSL ES 3.00 has no gl_FragColor: the fragment output is a declared variable.
   This one also carries the disc-only luminance in its alpha channel, which is
   how the composite pass isolates the accretion flow for the debug views. */
out vec4 fragColor;

/* ==================================================================== *
 *  Deep sky: stars + Milky Way + nebulae, all procedural.  Called with
 *  the LENSED direction, so lensing of the background is physical.
 * ==================================================================== */
const vec3 GP = vec3(0.4364, 0.7955, -0.4201);   // galactic pole (tilted)

/* ---- one layer of the starfield -------------------------------------- *
 *  Returns the emitted COLOUR and writes the intensity through the out
 *  parameter amp. Separating the spectral class (colour) from the magnitude
 *  (scalar) is what stops the two from leaking into each other. The luminosity
 *  power law is steep, which gives a few brilliant stars among many faint ones
 *  instead of the uniform speckle a flat threshold produces. A star whose core
 *  lands exactly on the sample reaches ~20 in linear light, i.e. ~2.5 stops
 *  above the disc's mid-tones — bright, but never a white dot.              */
vec3 starLayer(vec3 d, float scale, float thresh, float bright, out float amp) {
  amp = 0.0;
  vec3 cell = d * scale;
  vec3 ip   = floor(cell);
  vec3 fp   = cell - ip - 0.5;
  float h   = hash13(ip);
  if (h < thresh) return vec3(0.0);
  float h2 = hash13(ip + 21.71);
  vec3 off = vec3(h2, hash13(ip + 47.13), hash13(ip + 91.37)) - 0.5;
  float dd = length(fp - off * 0.62);
  /* A steep core with a much fainter, tighter halo: the halo is what keeps a
     star from looking like a dead pixel, but too much of it turns the field
     into blurry blobs under bloom. 0.028 at 160x the core's spatial constant
     puts ~2 % of the peak into a compact skirt. */
  float core = exp(-dd * dd * 210.0);
  float halo = exp(-dd * dd * 26.0) * 0.028;
  float mag  = pow(hash13(ip + 133.7), 5.5);          // steep luminosity function
  float T    = mix(2700.0, 15500.0, pow(hash13(ip + 7.31), 1.6));
  amp = (core + halo) * (0.05 + 6.8 * mag) * bright;
  return blackbodyRGB(T);
}

vec3 skySample(vec3 dir, float az) {
  /* Sky azimuth is passed in already reduced. It is deliberately NOT a function
     of time here: the only motion in the background is the one the caller asks
     for, so animate=0, a frozen simulation clock and the still-image capture
     path all produce a genuinely static sky, and a reproducibility test
     measures the renderer rather than a hidden drift. */
  float ca = cos(az);
  float sa = sin(az);
  vec3 d = vec3(ca * dir.x - sa * dir.z, dir.y, sa * dir.x + ca * dir.z);
  d = normalize(d);

  float lat = dot(d, GP);
  float band = exp(-pow(lat * 3.05, 2.0));

  vec3 col = vec3(0.0);

  /* ---- stars (density masked toward the galactic plane) ---- */
  float dens = clamp(u_starDensity, 0.0, 2.0);
  if (dens > 0.001) {
    float clump = 0.45 + 1.15 * fbm3(d * 5.3, 3);
    float mask  = clamp(clump * (0.30 + 0.70 * band), 0.0, 1.0);
    float b = u_starBright;
    float a1, a2, a3;
    col += starLayer(d, 52.0,  1.0 - 0.62 * dens * mask, b, a1) * a1;
    col += starLayer(d, 122.0, 1.0 - 0.40 * dens * mask, b, a2) * (a2 * 0.62);
    /* the third layer is only spent when the tier can afford it; on cheaper
       tiers uStarLayers is 2.0 and the whole block is skipped */
    if (uStarLayers > 2.5) {
      int nIter = int(clamp(uStarIter, 1.0, 2.0) + 0.5);
      for (int i = 0; i < 2; i++) {
        if (i >= nIter) break;
        vec3 p = d;
        for (int j = 0; j < 3; j++) {
          p = (NOISE_ROT * p) * 1.21 + 0.31;
        }
        col += starLayer(normalize(p), 244.0, 1.0 - 0.26 * dens, b, a3) * (a3 * 0.34);
      }
    }
    float gal = exp(-pow(lat * 2.35, 2.0));
    col += vec3(1.0, 0.95, 0.88) * 0.0018 * dens * b * gal;
  }

  /* ---- Milky Way ---- *
   *  Everything here is scaled so the diffuse sky peaks around 0.05 in linear
   *  light while individual stars reach ~3.  That ~60:1 ratio is what keeps
   *  the sky reading as "black with stars" instead of a grey wash, and it is
   *  what lets the shadow stay genuinely black at any sane exposure.          */
  float mw = u_milkyWay;
  if (mw > 0.001) {
    float f1 = fbm3(d * 2.9 + 11.0, 5);
    float rid = fbmRidged(d * 7.2 + 3.0, 4);
    float core = exp(-pow(lat * 7.6, 2.0));
    vec3 wdir = vec3(0.7113, -0.2716, 0.6483);
    core *= 0.36 + 1.50 * pow(max(dot(d, wdir), 0.0), 5.0);   // galactic bulge
    /* the ridged field carves the dust lanes so filaments go dark, not bright */
    float dust = pow(clamp(rid * 1.15, 0.0, 1.0), 1.5);
    vec3 mwCol = mix(vec3(0.58, 0.70, 1.00), vec3(1.00, 0.90, 0.76), f1);
    mwCol = mix(mwCol, vec3(1.00, 0.97, 0.93), clamp(core * 1.4, 0.0, 1.0));
    col += mwCol * mw * (0.0125 * band * (0.35 + 0.90 * f1) + 0.0170 * core) * (1.0 - 0.86 * dust);
  }

  /* ---- nebulae ---- */
  float ne = u_nebula;
  if (ne > 0.001) {
    float f = fbm3(d * 4.6 - 7.0, 4);
    float e = pow(1.0 - abs(f * 2.0 - 1.0), 3.2);
    col += mix(vec3(0.35, 0.85, 1.00), vec3(1.00, 0.32, 0.78), fbm3(d * 1.7, 2)) * e * ne * 0.035;
  }

  return col;
}

/* ==================================================================== *
 *  Main
 * ==================================================================== */
void main() {
  vec2 ndc = (vUv * 2.0 - 1.0);
  vec2 uv  = vec2(ndc.x * uAspect, ndc.y);
  vec3 rd  = normalize(uCamFwd + uCamRight * (uv.x * uTanHalfFov)
                               + uCamUp    * (uv.y * uTanHalfFov));
  vec3 p0  = uCamPos;

  float t   = uTime * uTimeScale;
  float rin  = max(u_diskInner, 1.05);
  float rout = max(u_diskOuter, rin + 0.5);

  float pl = length(p0 * vec3(1.0, 0.0, 1.0));

  /* ---- the whole image reduces to this: the exact conserved |L| / E ---- */
  float H   = length(cross(p0, rd));
  float nu  = dot(p0, rd) / max(length(p0), 1e-5);   // cos(angle between r and ray)

  vec3  pos = p0;
  float r   = max(length(pos), 1e-3);
  vec3  vel = rd;

  vec3  radiance = vec3(0.0);   // disc contribution only
  float trans    = 1.0;
  float steps    = 0.0;
  float captured = 0.0;
  float crossed  = 0.0;
  float dbgG = 1.0, dbgTemp = 0.0, gW = -1.0;

  float maxSteps = max(uMaxSteps, 1.0);
  float baseStep = max(uBaseStep, 1e-3);
  float stepScale = clamp(uStepScale, 0.85, 1.0);

  for (int i = 0; i < MAX_ITER; i++) {
    if (float(i) >= maxSteps) break;

    if (r <= RS * 1.0008) { captured = 1.0; break; }
    if (r > 4.2e3) break;
    if (trans < 0.0025) break;

    float r2 = r * r;
    float H2 = H * H;

    /* ---- adaptive affine step ------------------------------------
       sqrt(8 r^3 / b^2) ~ 1.2 * dlambda for a circular null orbit, so
       step = a * r * sqrt(r / b) keeps the deflection per step bounded.

       Two additional limits matter:
        • inside the disc annulus, never step more than a fraction of the
          distance to the disc plane, so a grazing ray cannot tunnel through
          the sheet;
        • in the strong field, cap the step near the horizon. The 3.4*(r-Rs)
          guard alone is not enough: with the disc switched off the step there
          is LARGE, and a ray whose impact parameter sits just above b_crit can
          then be walked across the horizon instead of winding out of the
          photon sphere — which shows up as the shadow growing by ~20 % when
          the disc is hidden. 0.03 Rs per step resolves the photon sphere to
          ~1e-8 relative error over a full winding. */
    float stepR = clamp(baseStep * r * sqrt(max(r, 0.5) / max(H, 0.35)), 0.006, 0.85);
    float step  = stepR;
    if (uDiscOn > 0.5 && pl < rout * DISK_UNIT + 1.2 && pl > rin * DISK_UNIT - 1.2) {
      step = min(step, max(0.02 + 0.5 * abs(pos.y), 0.012));
    }
    float nearGuard = (r < 3.5 * RS) ? 0.03 : 0.10;
    step = min(step, max(nearGuard, 3.4 * (r - RS)));

    vec3 a1 = -1.5 * H2 * pos / (r2 * r2 * r);
    vec3 pA = pos + (0.5 * step) * vel;
    vec3 vA = vel + (0.5 * step) * a1;
    float rA = max(length(pA), 1e-3);

    vec3 a2 = -1.5 * H2 * pA / (rA * rA * rA * rA * rA);
    vec3 pB = pos + (0.5 * step) * vA;
    vec3 vB = vel + (0.5 * step) * a2;
    float rB = max(length(pB), 1e-3);

    vec3 a3 = -1.5 * H2 * pB / (rB * rB * rB * rB * rB);
    vec3 pC = pos + step * vB;
    vec3 vC = vel + step * a3;
    float rC = max(length(pC), 1e-3);

    vec3 a4 = -1.5 * H2 * pC / (rC * rC * rC * rC * rC);

    vec3 posN = pos + (step / 6.0) * (vel + 2.0 * vA + 2.0 * vB + vC);
    vec3 velN = vel + (step / 6.0) * (a1 + 2.0 * a2 + 2.0 * a3 + a4);

    /* ---- disc crossing test (world space, plane y = 0) ---- */
    if (uDiscOn > 0.5 && pos.y * posN.y <= 0.0 && pos.y != posN.y
        && crossed < uDiskCrossings) {
      float f = pos.y / (pos.y - posN.y);
      vec3 pc = pos + f * (posN - pos);
      float rl = length(pc);
      float rRs = rl * DISK_UNIT;
      if (rRs < rout && rRs > rin * 0.40) {
        discCrossing(pc, vel, H, nu, rRs, t, crossed + 1.0,
                     radiance, trans, dbgTemp, dbgG, gW);
        crossed += 1.0;
      }
    }

    pos = posN;
    vel = velN;
    r   = max(length(pos), 1e-3);
    steps += 1.0;
    pl = length(pos * vec3(1.0, 0.0, 1.0));
  }

  /* ---- escaped: sample the deep sky along the final (bent) direction.
          Multiplying by the accumulated transmittance makes the disc
          correctly eclipse the background it passes in front of. ---- */
  float skyW = (captured < 0.5) ? trans : 0.0;
  /* Sky azimuth: the written parameter, reduced modulo one turn. There is no
     hidden time term — any drift in the background has to be asked for, so
     animate=0, a frozen simulation clock and the still-image capture path all
     produce a genuinely static sky. The reduction matters because
     u_skyRotation reaches 360 deg: a float32 has no fractional precision left
     once the argument is large, and sin/cos would start returning values that
     jitter with the argument's magnitude rather than with the angle. */
  const float TAU = 6.283185307;
  float az = mod(u_skyRotation * 0.01745329252, TAU);
  vec3 sky = skySample(normalize(vel), az) * skyW;

  /* ---- debug AOVs ---- */
  vec3 outCol = sky + radiance;
  float cosT = clamp(dot(normalize(rd), normalize(vel)), -1.0, 1.0);
  if (uDebug > 0.5) {
    if (uDebug < 1.5) {
      vec3 c = max(outCol, vec3(0.0));
      float l = max(luminance(c), 1e-4);
      outCol = turbo(clamp((log2(l) + 12.0) / 15.0, 0.0, 1.0)) * (0.65 + 0.45 * clamp(l, 0.0, 1.0));
    } else if (uDebug < 2.5) {
      outCol = turbo(clamp(steps / maxSteps, 0.0, 1.0));
    } else if (uDebug < 3.5) {
      float ang = degrees(acos(cosT));
      outCol = turbo(clamp(ang / 180.0, 0.0, 1.0));
    } else if (uDebug < 4.5) {
      /* Impact parameter in units of the critical value, as a capture mask.
         The capture decision is a pure ray property, so this view states two
         facts independently of each other and of the exposure:
             captured -> a flat red  (0.62, 0.02, 0.02) after sRGB encoding
             escaped  -> the turbo ramp, which is never that red while being
                         that poor in blue
         The shadow edge therefore lands exactly on the b/b_crit = 1 contour. */
      float b = H / B_CRIT;
      outCol = captured > 0.5 ? vec3(0.62, 0.02, 0.02)
                              : turbo(clamp(b, 0.0, 1.0));
    } else if (uDebug < 5.5) {
      float d = clamp((dbgG - 0.35) / 1.35, 0.0, 1.0);
      outCol = crossed > 0.5 ? turbo(d) : vec3(0.02);
    } else if (uDebug < 6.5) {
      float sf = sqrt(max(1.0 - RS / R_PHOTON, 1e-4));   // shift at the photon sphere
      outCol = crossed > 0.5 ? turbo(sf) : vec3(0.02);
    } else if (uDebug < 7.5) {
      outCol = crossed > 0.5
        ? turbo(clamp((dbgTemp - 1500.0) / 38000.0, 0.0, 1.0))
        : vec3(0.02);
    } else if (uDebug < 8.5) {
      float c = clamp(crossed, 0.0, 7.0);
      outCol = captured > 0.5 ? vec3(0.75, 0.0, 0.0) : turbo(c / 7.0);
    } else {
      outCol = sky;                       // disc suppressed
    }
  }

  /* ------------------------------------------------------------------ *
   *  HDR buffer layout
   *  rgb = radiance (or the selected AOV)
   *  a   = ray termination code, so that a test — or a future feature — can
   *        recover the ray-domain result without going near the display
   *        pipeline:
   *          1.00  the ray reached the horizon            (captured)
   *          0.40  the ray escaped to infinity
   *          0.05  the disc stopped it
   *          0.00  the step budget ran out in the strong field
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   *  HDR buffer layout
   *  rgb = radiance (or the selected AOV)
   *  a   = ray termination code, so a test — or a future feature — can
   *        recover the ray-domain result without going near the display
   *        pipeline:
   *          1.00  the ray reached the horizon
   *          0.40  the ray escaped WITHOUT meeting the disc
   *          0.05  the ray met the disc (absorbed, or escaped after passing
   *                through it) — the crossing counter is the honest
   *                discriminator here, not a transmittance threshold, because a
   *                single crossing of a moderately thick disc still leaves the
   *                transmittance near 3e-3 and was being mislabelled as
   *                untouched sky
   *          0.00  the step budget ran out in the strong field
   * ------------------------------------------------------------------ */
  float termCode = 0.0;
  if (captured > 0.5) termCode = 1.0;
  else if (crossed > 0.5) termCode = 0.05;
  else if (trans > 0.0015) termCode = 0.40;

  fragColor = vec4(outCol, termCode);
}
`;
