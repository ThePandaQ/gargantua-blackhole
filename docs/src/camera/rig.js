/**
 * GARGANTUA — camera rig.
 *
 * Two co-existing modes:
 *   • FREE      : OrbitControls (damped), W axis locked to the disc normal.
 *   • CINEMATIC : an autonomous 84 s closed-loop dolly through 7 keyframed
 *                 shots, interpolated with a Catmull-Rom spline in
 *                 (radius, cos theta, phi-unwrapped, fov) so it never
 *                 violates its own spherical coordinate ranges.
 *
 * Any pointer/wheel input hands control back to the user and switches the rig
 * to FREE, exactly like a real cinematics system.
 */

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VIEW_PRESETS, CINEMATIC_SHOTS, CINEMATIC_LOOP } from '../config.js';
import { state, on, saveState, setCinematic } from '../state.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------- spline */
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function unwrapPhi(phi) {
  let out = [phi[0]];
  for (let i = 1; i < phi.length; i++) {
    let p = phi[i];
    while (p - out[i - 1] > 180) p -= 360;
    while (p - out[i - 1] < -180) p += 360;
    out.push(p);
  }
  return out;
}

const _SHOTS = (() => {
  const s = CINEMATIC_SHOTS;
  const phi = unwrapPhi(s.map((k) => k.phi));
  return s.map((k, i) => ({
    t: k.t, label: k.label,
    radius: k.radius,
    cosT: Math.cos(clamp(k.theta, 0.6, 179.4) * DEG),
    phi: phi[i],
    fov: k.fov,
  }));
})();

export function cinematicStateAt(time) {
  const loop = CINEMATIC_LOOP;
  const t = ((time % loop) + loop) % loop;
  const n = _SHOTS.length;
  let i = 0;
  for (let k = 0; k < n - 1; k++) if (t >= _SHOTS[k].t) i = k;
  const a = _SHOTS[i];
  const b = _SHOTS[i + 1] || _SHOTS[0];
  const span = Math.max(b.t - a.t, 1e-3);
  const raw = clamp((t - a.t) / span, 0, 1);
  const u = raw * raw * (3 - 2 * raw);           // smoothstep ease
  const p0 = _SHOTS[i - 1] || _SHOTS[n - 2] || a;
  const p3 = _SHOTS[i + 2] || _SHOTS[1] || b;
  return {
    radius: catmull(p0.radius, a.radius, b.radius, p3.radius, u),
    cosT: clamp(catmull(p0.cosT, a.cosT, b.cosT, p3.cosT, u), -0.9995, 0.9995),
    phi: catmull(p0.phi, a.phi, b.phi, p3.phi, u),
    fov: catmull(p0.fov, a.fov, b.fov, p3.fov, u),
    label: a.label,
    progress: t / loop,
    index: i,
  };
}

/* ------------------------------------------------------------------ rig */
export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.controls = new OrbitControls(camera, domElement);
    const c = this.controls;
    c.enableDamping = true;
    c.dampingFactor = 0.055;
    c.rotateSpeed = 0.62;
    c.zoomSpeed = 0.78;
    c.panSpeed = 0.5;
    c.enablePan = false;               // the singularity stays centred
    c.minDistance = 4.2;
    c.maxDistance = 460;
    c.minPolarAngle = 0.035;
    c.maxPolarAngle = Math.PI - 0.035;
    c.target.set(0, 0, 0);
    c.autoRotate = false;
    c.autoRotateSpeed = 0.18;

    this.roll = state.camera.roll || 0;
    this.baseRoll = state.camera.roll || 0;
    this.driftRoll = 0;
    this.frozen = false;
    this.fovTarget = state.camera.fov;
    this.fovCurrent = state.camera.fov;
    this.shotLabel = CINEMATIC_SHOTS[0].label;
    this.shotProgress = 0;

    /* start from the persisted spherical camera */
    this.setSpherical(state.camera.radius, state.camera.theta, state.camera.phi, state.camera.fov, { instant: true });
    this.applyRoll();

    this._bindInput();
    this._bindState();
  }

  /* ------------------------------------------------------------ helpers */
  setSpherical(radius, thetaDeg, phiDeg, fov, { instant = false } = {}) {
    const r = clamp(radius, this.controls.minDistance, this.controls.maxDistance);
    const th = clamp(thetaDeg, 0.6, 179.4) * DEG;
    const ph = phiDeg * DEG;
    const sp = Math.sin(th);
    this.camera.position.set(r * sp * Math.sin(ph), r * Math.cos(th), r * sp * Math.cos(ph));
    this.camera.lookAt(0, 0, 0);
    if (Number.isFinite(fov)) {
      this.fovTarget = clamp(fov, 12, 100);
      if (instant) { this.fovCurrent = this.fovTarget; this.camera.fov = this.fovTarget; this.camera.updateProjectionMatrix(); }
    }
    if (instant) this.controls.update();
  }

  getSpherical() {
    const p = this.camera.position;
    const r = Math.max(p.length(), 1e-4);
    return { radius: r, theta: Math.acos(clamp(p.y / r, -1, 1)) * RAD, phi: Math.atan2(p.x, p.z) * RAD };
  }

  setRoll(deg, { instant = false } = {}) {
    this.baseRoll = deg;
    if (instant) this.roll = deg;
    this.applyRoll();
  }

  applyRoll() {
    const a = this.roll * DEG;
    this.camera.up.set(Math.sin(a), Math.cos(a), 0);
    this.camera.lookAt(0, 0, 0);
  }

  setPreset(id, { instant = false } = {}) {
    const p = VIEW_PRESETS.find((v) => v.id === id);
    if (!p) return null;
    this.setCinematic(false);
    this.setSpherical(p.radius, p.theta, p.phi, p.fov, { instant: false });
    this.setRoll(p.roll || 0);
    const s = this.getSpherical();
    state.camera.radius = s.radius; state.camera.theta = s.theta; state.camera.phi = s.phi;
    state.camera.fov = p.fov; state.camera.roll = p.roll || 0;
    saveState();
    return p;
  }

  cyclePreset(dir = 1) {
    const cur = VIEW_PRESETS.findIndex((v) => Math.abs(v.fov - this.fovTarget) < 0.6
      && Math.abs(v.radius - this.camera.position.length())
        / Math.max(v.radius, 1) < 0.16);
    const idx = cur >= 0 ? (cur + dir + VIEW_PRESETS.length) % VIEW_PRESETS.length
      : (dir > 0 ? 0 : VIEW_PRESETS.length - 1);
    return this.setPreset(VIEW_PRESETS[idx].id);
  }

  setCinematic(on_, { silent = false } = {}) {
    if (silent) { this._cinematic = !!on_; return; }
    if (state.cinematic === !!on_) return;
    setCinematic(!!on_);
  }

  /* ------------------------------------------------------------- input */
  _bindInput() {
    const hand = () => { if (state.cinematic) setCinematic(false); };
    const el = this.dom;
    el.addEventListener('pointerdown', hand, { passive: true });
    el.addEventListener('wheel', hand, { passive: true });
    el.addEventListener('touchstart', hand, { passive: true });
    /* kill the context menu so right-drag zoom feels native */
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _bindState() {
    on('cinematic', (e) => {
      if (e.detail.cinematic) {
        /* resume exactly from the current pose */
        const s = this.getSpherical();
        this._resume = { radius: s.radius, theta: s.theta, phi: s.phi };
      }
    });
    on('param', () => { /* nothing: parameters do not move the camera */ });
  }

  /* ------------------------------------------------------------- update */
  update(dt, elapsed) {
    /* A frozen rig is completely inert. Even with the drift zeroed, the roll
       smoothing below would call applyRoll() every frame and nudged the right
       and up vectors by ~0.2 deg — invisible to the eye, fatal to a
       reproducibility test. */
    if (this.frozen) return;

    if (state.cinematic) {
      const k = cinematicStateAt(elapsed);
      const r = clamp(k.radius, this.controls.minDistance, this.controls.maxDistance);
      const th = Math.acos(k.cosT);
      const sp = Math.sin(th);
      const ph = k.phi * DEG;
      this.camera.position.set(r * sp * Math.sin(ph), r * Math.cos(th), r * sp * Math.cos(ph));
      this.fovTarget = clamp(k.fov, 12, 100);
      this.driftRoll = Math.sin(elapsed * 0.043) * 1.6 + Math.sin(elapsed * 0.011) * 2.2;
      this.shotLabel = k.label;
      this.shotProgress = k.progress;
      this.controls.target.set(0, 0, 0);
    } else {
      const changed = this.controls.update();
      this.driftRoll = Math.sin(elapsed * 0.031) * 0.55;
      void changed;
    }

    /* smooth fov */
    if (Math.abs(this.fovCurrent - this.fovTarget) > 1e-3) {
      this.fovCurrent += (this.fovTarget - this.fovCurrent) * Math.min(1, dt * 4.0);
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    /* roll: authored base roll + slow organic drift (this is what makes the
       horizon line feel hand-held rather than CAD-perfect) */
    const wantRoll = this.baseRoll + this.driftRoll;
    if (Math.abs(this.roll - wantRoll) > 1e-3) {
      this.roll += (wantRoll - this.roll) * Math.min(1, dt * 2.2);
      this.applyRoll();
    } else {
      this.applyRoll();
    }

    /* persist the free camera pose */
    if (!state.cinematic) {
      const s = this.getSpherical();
      state.camera.radius = s.radius;
      state.camera.theta = s.theta;
      state.camera.phi = s.phi;
      state.camera.fov = this.fovTarget;
      state.camera.roll = this.baseRoll;
    }
  }

  /** Orthonormal camera basis pushed to the shader. */
  basis() {
    const m = this.camera.matrixWorld.elements;
    return {
      pos: [m[12], m[13], m[14]],
      right: [m[0], m[1], m[2]],
      up: [m[4], m[5], m[6]],
      fwd: [-m[8], -m[9], -m[10]],
      fov: this.camera.fov,
      tanHalfFov: Math.tan(this.camera.fov * 0.5 * DEG),
    };
  }

  dispose() {
    this.controls.dispose();
  }
}
