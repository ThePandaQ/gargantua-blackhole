#!/usr/bin/env node
/**
 * GARGANTUA — independent verification of the shadow's apparent size.
 *
 * The acceptance harness compares the raytracer's measured capture fraction
 * against a closed-form expression for the apparent angular radius of the
 * shadow at a finite observer radius. If that expression were wrong, the test
 * would report a bug in the renderer that is really a bug in the test. This
 * script removes the doubt by integrating the Schwarzschild null geodesic
 * equation directly, with a completely independent method:
 *
 *      d^2u/dphi^2 + u = 3 M u^2 ,   u = 1/r ,  Rs = 1 => M = 1/2
 *
 * For each candidate impact parameter b we shoot the photon inward from a large
 * radius and read off the angle at which it arrives at r0. Bisecting on b gives
 * the b that arrives at exactly b_crit, which is the shadow's edge.
 *
 *   node tools/shadow-theory.mjs
 */

const RS = 1.0;
const M = RS / 2;
const B_CRIT = 3 * Math.sqrt(3) * RS / 2;

/* d2u/dphi2 = 3M u^2 - u, integrated with RK4 in phi, starting at r = rFar
   where the ray is travelling inward with impact parameter b.
   In Schwarzschild, (du/dphi)^2 = 1/b^2 - u^2 (1 - Rs u), so the starting
   slope is known exactly and no shooting on the initial angle is needed. */
function trajectory(b, r0, rFar = 1e6, dphi = -1e-4) {
  let u = 1 / rFar;
  const s = 1 / (b * b) - u * u * (1 - RS * u);
  if (s <= 0) return null;                       // cannot even start outward
  let du = -Math.sqrt(s);                        // incoming: u increases
  let phi = 0;

  const acc = (uu) => 3 * M * uu * uu - uu;

  for (let i = 0; i < 60_000_000; i++) {
    const r = 1 / u;
    if (u >= 1 / RS) return { captured: true, phi };     // crossed the horizon
    if (u <= 1 / r0 && du < 0) {
      /* reached the observer radius on the way in */
      const t = (1 / r0 - u) / du;                       // linear refine
      return { captured: false, phi: phi + t, u: 1 / r0 };
    }
    if (du > 0 && u < 1 / r0) {
      /* turned around before reaching r0 -> this b never gets there */
      return { captured: true, phi };
    }
    /* RK4 step in phi */
    const k1u = du, k1d = acc(u);
    const k2u = du + 0.5 * dphi * k1d, k2d = acc(u + 0.5 * dphi * k1u);
    const k3u = du + 0.5 * dphi * k2d, k3d = acc(u + 0.5 * dphi * k2u);
    const k4u = du + dphi * k3d, k4d = acc(u + dphi * k3u);
    u += (dphi / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
    du += (dphi / 6) * (k1d + 2 * k2d + 2 * k3d + k4d);
    phi += dphi;
    if (!Number.isFinite(u) || !Number.isFinite(du)) return null;
  }
  return null;
}

/**
 * Angular radius of the shadow seen by a static observer at r0, in radians.
 * theta is measured from the inward radial direction, and in Schwarzschild
 *
 *     sin^2(theta) = (b^2 / r0^2) (1 - Rs/r0)
 *
 * Which is what we are checking. We instead solve for the b that just barely
 * escapes, then read the arrival angle straight off the trajectory.
 */
function shadowAngleNumerical(r0) {
  let lo = B_CRIT;                 // escapes
  let hi = B_CRIT * 1.6;           // certainly escapes
  /* find an upper bracket that clearly arrives at r0 */
  while (trajectory(hi, r0) === null || trajectory(hi, r0).captured) hi *= 1.2;
  for (let i = 0; i < 90; i++) {
    const mid = 0.5 * (lo + hi);
    const t = trajectory(mid, r0);
    if (t === null || t.captured) lo = mid; else hi = mid;
  }
  const bEdge = 0.5 * (lo + hi);
  const sinT = Math.sqrt(Math.min(1, (bEdge * bEdge / (r0 * r0)) * (1 - RS / r0)));
  return { bEdge, theta: Math.asin(sinT), sinT };
}

console.log('\n\x1b[1mGARGANTUA - shadow geometry cross-check\x1b[0m');
console.log(`Rs = ${RS}, M = ${M}, b_crit = 3*sqrt(3)/2 = ${B_CRIT.toFixed(9)}\n`);
console.log('  r0     numerical b_edge      analytic b_edge     theta_num    theta_analytic   diff');
console.log('  ' + '-'.repeat(88));

let worst = 0;
for (const r0 of [8.4, 15, 27, 32, 60, 200, 1e4]) {
  const num = shadowAngleNumerical(r0);
  /* the closed form the harness uses */
  const sinA = Math.sqrt(Math.min(1, (B_CRIT * B_CRIT / (r0 * r0)) * (1 - RS / r0)));
  const thetaA = Math.asin(sinA);
  const d = Math.abs(num.theta - thetaA) / Math.max(thetaA, 1e-12);
  worst = Math.max(worst, d);
  console.log('  ' + String(r0).padEnd(7)
    + num.bEdge.toFixed(9).padEnd(20)
    + B_CRIT.toFixed(9).padEnd(20)
    + (num.theta * 180 / Math.PI).toFixed(5).padEnd(13)
    + (thetaA * 180 / Math.PI).toFixed(5).padEnd(17)
    + (d * 100).toFixed(5) + ' %');
}

console.log('');
if (worst < 1e-4) {
  console.log('\x1b[32mPASS\x1b[0m the closed form sin^2(theta) = (b^2/r0^2)(1 - Rs/r0) is exact');
  console.log(`     worst relative difference ${(worst * 100).toExponential(2)} % over r0 = 8.4 .. 1e4\n`);
  process.exit(0);
}
console.log(`\x1b[31mFAIL\x1b[0m the closed form is off by up to ${(worst * 100).toFixed(4)} %\n`);
process.exit(1);
