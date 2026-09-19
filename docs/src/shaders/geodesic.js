/**
 * GARGANTUA — Schwarzschild null-geodesic integrator (fragment shader).
 *
 * ============================ THE PHYSICS ============================
 * Units: Rs = 1, c = 1, G = 1  ->  M = 1/2.
 *
 * A null geodesic in Schwarzschild spacetime obeys the Binet-type equation
 *
 *        d^2u/dphi^2 + u = 3 M u^2 ,      u = 1/r          (exact, GR)
 *
 * which we rewrite as a pure Newtonian-looking central-force problem in the
 * orbital plane.  With H = |r x v| the conserved specific angular momentum
 * (equal to the impact parameter b because |v| = 1 at infinity this reduces to
 *
 *        d^2 r / dlambda^2 = -3 H^2 r / r^5 = -(3/2) Rs H^2 r / r^5
 *
 * i.e. an extra ATTRACTIVE 1/r^4 term on top of the (absent) Newtonian one.
 * We integrate it with classical RK4 using an affine parameter lambda that is
 * arc length at infinity.  No weak-field approximation, no screen-space fudge:
 * the shadow, the photon ring, the higher-order images and the Einstein ring
 * all fall out of the integration.
 *
 * Photon sphere  r = 1.5 , critical impact parameter b = 3*sqrt(3)/2 = 2.598.
 * Disc ISCO      r = 3.0 (default truncation of the accretion flow).
 *
 * Everything is done in world space with the disc in the y = 0 plane, which
 * removes the usual seam/pole problems of spherical (r, theta, phi) stepping
 * and keeps the step size uniform in the strong field.
 * =====================================================================
 */

export const geodesicGLSL = /* glsl */`
precision highp float;

in vec2 vUv;
uniform vec2  uResolution;
uniform float uTime;

/* ---- camera (orthonormal basis, world space) ---- */
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

/* ---- the 21 live parameters ---- */
uniform float u_diskInner;      // Rs
uniform float u_diskOuter;      // Rs
uniform float u_diskThickness;
uniform float u_diskDensity;
uniform float u_diskSlices;
uniform float u_diskSpin;
uniform float u_diskTemp;       // K
uniform float u_diskBright;
uniform float u_doppler;
uniform float u_redshift;
uniform float u_turbulence;
uniform float u_flowSpeed;
uniform float u_starDensity;
uniform float u_starBright;
uniform float u_milkyWay;
uniform float u_nebula;
uniform float u_skyRotation;    // deg
uniform float u_exposure;
uniform float u_bloom;
uniform float u_bloomThreshold; // consumed by the bloom pass
uniform float u_dispersion;     // consumed by the composite pass

/* ---- quality / modes ---- */
uniform float uMaxSteps;
uniform float uBaseStep;
uniform float uStepScale;
uniform float uDiskCrossings;
uniform float uStarLayers;
uniform float uStarIter;
uniform float uDebug;
uniform float uTimeScale;
uniform float uDiscOn;          // 1 = render disc, 0 = lensed sky only

/* ---- fixed geometry constants (Rs = 1) ---- */
#define RS        1.0
#define R_PHOTON  1.5
#define B_CRIT    2.59807621135
#define MAX_ITER  900
#define PI        3.14159265359

/* scene units -> Rs.  One world unit is 2 Rs, so r_scene = r_Rs / DISK_UNIT.
   Working in scene units keeps float precision comfortable far from the hole. */
#define DISK_UNIT 2.0

/* ==================================================================== *
 *  Precision-safe hashing / value noise / fbm
 *  (sin()-based hashes break on tiled mobile GPUs — integer hashing does not)
 * ==================================================================== */
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

const mat3 NOISE_ROT = mat3(
   0.00,  0.80,  0.60,
  -0.80,  0.36, -0.48,
  -0.60, -0.48,  0.64
);

float fbm3(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    n += a;
    p = NOISE_ROT * p * 2.03;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}

float fbmRidged(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float v = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    s += a * v * v;
    n += a;
    p = NOISE_ROT * p * 2.11;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}

/* Colour science (luminance / blackbodyRGB / aces / srgbEncode / turbo)
   and the integer hashes live in shaders/common.js and are injected ahead of
   this block by scene.js, so both the scene and composite passes share one
   definition of each. */
`;

/* ====================================================================== *
 *  Accretion disc
 * ====================================================================== */
export const diskGLSL = /* glsl */`
/* ---- Shakura-Sunyaev-like radial profile ---------------------------- *
 *  T(r) ~ r^(-3/4) * (1 - sqrt(r_in/r))^(1/4)  with the standard
 *  zero-torque inner boundary, sharpened so the hot plunging region reads
 *  clearly at cinematic exposure.  r is in Rs.                              */
float discTempShape(float r, float rin, float rout) {
  float f = max(1.0 - sqrt(clamp(rin / max(r, 1e-3), 0.0, 1.0)), 0.0);
  float base = pow(max(r, 1e-3) / rin, -0.75) * pow(max(f, 1e-4), 0.25);
  float edge = smoothstep(0.0, 0.16, (r - rin) / max(rin, 1e-3));
  float outer = smoothstep(1.0, 0.78, r / max(rout, 1e-3));
  return clamp(base * (0.16 + 0.84 * edge) * (0.25 + 0.75 * outer), 0.0, 1.35);
}

/* ---- Keplerian angular velocity, scene units, Rs = 1 ---------------- */
float omegaKepler(float rRs) { return sqrt(0.5 / (rRs * rRs * rRs)); }

/* ---- emissivity + density of the turbulent flow --------------------- *
 *  Differential rotation is applied INSIDE the noise lookup: every hotspot is
 *  advected by its own Keplerian omega * dt, so the pattern is sheared into
 *  trailing spiral filaments instead of rotating rigidly.
 *
 *  flowSpeed scales the WHOLE temporal evolution — the advection phase and the
 *  slow restructure term alike. Scaling only the advection would leave the
 *  pattern drifting at flowSpeed = 0, which is both surprising to a user and
 *  fatal to a reproducibility test.                                       */
void discSample(vec3 p, float rRs, float seed, float t,
                out float dens, out float tempK) {
  float rin  = max(u_diskInner, 1.05);
  float rout = max(u_diskOuter, rin + 0.5);
  float r    = rRs * DISK_UNIT;                 // scene units
  float phi  = atan(p.z, p.x);
  float flowT = t * u_flowSpeed;

  float w     = omegaKepler(rRs) * u_diskSpin * flowT;
  float swirl = phi + w;

  /* trailing spiral density waves (log-spiral, local shearing sheet) */
  float spiral = sin(2.0 * swirl - 5.5 * log(max(r, 1e-3)) + seed * 1.7);

  vec3 q = vec3(cos(swirl) * r, p.y * 3.1, sin(swirl) * r);
  float f1 = fbm3(q * 0.62, 4);
  float f2 = fbm3(q * 1.95 + f1 * 0.9, 3);
  float rid = fbmRidged(vec3(swirl * 1.25, log(max(r, 1e-3)) * 2.2, flowT * 0.05) * 1.4, 3);

  /* threaded filaments: turbulence parameter blends order <-> chaos */
  float fil = mix(1.0, rid, clamp(u_turbulence, 0.0, 1.0));

  float densBase = pow(clamp(f1 * 0.68 + f2 * 0.45, 0.0, 2.0), 1.55);
  dens = densBase * mix(1.0, 0.55 + 0.85 * (0.5 + 0.5 * spiral), u_turbulence)
       * mix(1.0, 1.35, fil) * u_diskThickness;

  /* radial envelope: inner rim, soft outer taper, dynamic range compression */
  float env = smoothstep(0.0, 1.0, (rRs - rin) / max(rin * 0.10, 0.12));
  env *= smoothstep(0.0, 1.0, (rout - rRs) / max(rout * 0.16, 0.5));
  dens *= env;
  dens = pow(max(dens, 0.0), 0.74);

  /* the plunging region inside the ISCO is hot and tenuous, not empty */
  float plunge = smoothstep(rin, rin * 0.55, rRs) * 0.30;
  dens += plunge * (0.35 + 0.65 * f1);

  tempK = u_diskTemp * discTempShape(rRs, rin, rout)
        + u_diskTemp * 0.55 * smoothstep(rin * 1.35, rin * 0.85, rRs)
                     * smoothstep(rin * 0.5, rin * 0.9, rRs);
}

/* ---- the disc crossing integrator ---------------------------------- *
 *  For every crossing of the y = 0 plane we compute the emitted radiance
 *  and the OBSERVED radiance via the exact relativistic transfer function
 *
 *      g = E_obs / E_emit = sqrt(f) / ( gamma (1 - beta.n) )
 *
 *  with f = 1 - Rs/r (gravitational shift) and beta the Keplerian orbital
 *  velocity measured by the local static observer.  Specific intensity
 *  transforms as I_obs = g^4 I_emit (Liouville), which is what produces
 *  the one-sided beaming of a near edge-on disc.                           */
void discCrossing(vec3 p, vec3 v, float H, float nu, float rRs, float t,
                  float phase, inout vec3 radiance, inout float trans,
                  inout float dbgTemp, inout float dbgG, inout float gW) {
  float dens, tempK;
  discSample(p, rRs, phase * 3.1, t, dens, tempK);

  float op = clamp(u_diskDensity * dens, 0.0, 8.0);
  float alpha = 1.0 - exp(-op);
  alpha = clamp(alpha, 0.0, 1.0);

  float r    = rRs * DISK_UNIT;
  float f    = max(1.0 - RS / max(rRs, 1.0001), 1e-4);
  float sqf  = sqrt(f);

  float phi = atan(p.z, p.x);
  vec3  rhat = vec3(p.x, 0.0, p.z) / max(length(vec2(p.x, p.z)), 1e-4);
  vec3  phihat = vec3(-sin(phi), 0.0, cos(phi));

  /* photon kinematics at the crossing: radial from the null condition,
     tangential from the conserved H = b (|H| = b, direction rhat x v). */
  float nrc  = v.y > 0.0 ? 1.0 : -1.0;
  float nr   = nrc * sqf * sqrt(max(1.0 - f * H * H / (r * r), 0.0));
  vec3  Hv   = cross(p, v);
  float Hm   = length(Hv);
  vec3  hhat = Hm > 1e-6 ? Hv / Hm : phihat;
  vec3  phat = cross(hhat, rhat);
  float ptc  = dot(phat, phihat) >= 0.0 ? 1.0 : -1.0;
  float np   = ptc * sqf * H / r;

  vec3  nphot = nr * rhat + np * phat;

  /* Keplerian emitter 4-velocity as seen by the local static observer */
  float Om  = omegaKepler(rRs) * u_diskSpin;
  float vk  = min(sqrt(0.5 / max(rRs - RS, 1e-3)), 0.965);
  float gam = 1.0 / sqrt(max(1.0 - vk * vk, 1e-5));
  vec3  vhat = phihat;
  float bd   = dot(vk * vhat, nphot);
  float dop  = 1.0 / max(gam * (1.0 - bd), 1e-3);   // delta = nu_obs/nu_emit(local)

  /* full relativistic transfer g = sqrt(f) * delta.
     u_redshift / u_doppler let the two effects be dialled independently. */
  float gFull = sqf * mix(1.0, dop, clamp(u_doppler, 0.0, 1.0));
  float gEff  = mix(sqf, gFull, clamp(u_redshift, 0.0, 1.0));
  gEff = max(gEff, 1e-3);

  float Tobs = tempK * gEff;
  vec3  emis = blackbodyRGB(Tobs);

  /* Stefan-Boltzmann: radiance ~ T^4, and Liouville: I_obs = g^4 I_emit.
     Everything is expressed relative to the parameter temperature so the slider
     rescales the whole disc instead of double-counting the profile.

     The extra dens^1.15 factor is a gentle optically-thin weighting: the
     plunging region inside the ISCO is genuinely hotter, and with radiance set
     by T^4 alone there was nothing to weigh it down, so that thin hot gas
     outshone the body of the disc and clipped the inner rim to flat white. A
     steep exponent over-corrects the other way and flattens the disc into haze,
     because the density field only spans about a factor of eight. */
  float bol   = pow(max(tempK, 1.0) / max(u_diskTemp, 1.0), 4.0);
  float boost = mix(1.0, pow(gEff, 4.0), clamp(u_doppler, 0.0, 1.0));
  float opt   = pow(clamp(dens, 0.0, 2.5), 1.15);
  vec3  src   = emis * bol * boost * opt * u_diskBright * 150.0 * uDiscOn;

  radiance += trans * alpha * src;
  trans    *= (1.0 - alpha * 0.985);

  float wt = alpha + 1e-3;
  if (wt > gW) { gW = wt; dbgG = gEff; dbgTemp = Tobs; }
}
`;
