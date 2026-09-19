/**
 * GARGANTUA — global configuration: the 21 live parameters, quality tiers,
 * camera presets, debug views and the cinematic shot list.
 *
 * Geometrised units are used everywhere:  Schwarzschild radius Rs = 1, c = 1, G = 1.
 *   event horizon   r = 1.0
 *   photon sphere   r = 1.5       (unstable circular null orbit)
 *   critical impact b = 3*sqrt(3)/2 = 2.598076
 *   ISCO            r = 3.0       (truncation of the accretion disc)
 */

export const RS = 1.0;
export const PHOTON_SPHERE = 1.5;
export const B_CRIT = 3 * Math.sqrt(3) / 2;
export const DISK_UNIT = 2.0; // 1 scene unit = 2 Rs  -> disc ri=3Rs means unitRadius=1.5

/* ------------------------------------------------------------------ *
 * The 21 parameters.  `key` doubles as the GLSL uniform name (u_<key>)
 * and as the query-string / localStorage key.
 * ------------------------------------------------------------------ */
export const PARAM_DEFS = [
  // ---- Geometry -------------------------------------------------------
  { key: 'diskInner',     group: 'geometry', label: 'Disc Inner Edge',   min: 1.5,  max: 6.0,  step: 0.01, def: 3.0,  unit: 'Rs', dp: 2 },
  { key: 'diskOuter',     group: 'geometry', label: 'Disc Outer Edge',   min: 6.0,  max: 34.0, step: 0.05, def: 19.0, unit: 'Rs', dp: 2 },
  { key: 'diskThickness', group: 'geometry', label: 'Disc Thickness',    min: 0.01, max: 0.40, step: 0.005, def: 0.085, unit: '', dp: 3 },
  { key: 'diskDensity',   group: 'geometry', label: 'Disc Density',      min: 0.0,  max: 8.0,  step: 0.02, def: 3.40, unit: '', dp: 2 },
  { key: 'diskSlices',    group: 'geometry', label: 'Disc Turbulence',   min: 1,    max: 6,    step: 1,    def: 4,    unit: '', dp: 0 },
  { key: 'diskSpin',      group: 'geometry', label: 'Orbital Speed',     min: 0.0,  max: 2.5,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  // ---- Matter ---------------------------------------------------------
  { key: 'diskTemp',      group: 'matter',   label: 'Disc Temperature',  min: 1200, max: 30000, step: 25,  def: 10500, unit: 'K', dp: 0 },
  { key: 'diskBright',    group: 'matter',   label: 'Disc Brightness',   min: 0.0,  max: 6.0,  step: 0.01, def: 1.55, unit: '', dp: 2 },
  { key: 'doppler',       group: 'matter',   label: 'Doppler Boost',     min: 0.0,  max: 1.0,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  { key: 'redshift',      group: 'matter',   label: 'Grav. Redshift',    min: 0.0,  max: 1.0,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  { key: 'turbulence',    group: 'matter',   label: 'Turbulence',        min: 0.0,  max: 1.0,  step: 0.01, def: 0.72, unit: '', dp: 2 },
  { key: 'flowSpeed',     group: 'matter',   label: 'Flow Animation',    min: 0.0,  max: 2.0,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  // ---- Sky ------------------------------------------------------------
  { key: 'starDensity',   group: 'sky',      label: 'Star Density',      min: 0.0,  max: 2.0,  step: 0.01, def: 0.85, unit: '', dp: 2 },
  { key: 'starBright',    group: 'sky',      label: 'Star Brightness',   min: 0.0,  max: 5.0,  step: 0.01, def: 1.35, unit: '', dp: 2 },
  { key: 'milkyWay',      group: 'sky',      label: 'Milky Way',         min: 0.0,  max: 3.0,  step: 0.01, def: 1.00, unit: '', dp: 2 },
  { key: 'nebula',        group: 'sky',      label: 'Nebula Glow',       min: 0.0,  max: 2.0,  step: 0.01, def: 0.42, unit: '', dp: 2 },
  { key: 'skyRotation',   group: 'sky',      label: 'Sky Rotation',      min: 0,    max: 360,  step: 0.5,  def: 34.0, unit: 'deg', dp: 1 },
  // ---- Optics ---------------------------------------------------------
  { key: 'exposure',      group: 'optics',   label: 'Exposure',          min: 0.05, max: 4.0,  step: 0.01, def: 1.60, unit: '', dp: 2 },
  { key: 'bloom',         group: 'optics',   label: 'Bloom',             min: 0.0,  max: 2.0,  step: 0.01, def: 0.62, unit: '', dp: 2 },
  { key: 'bloomThreshold',group: 'optics',   label: 'Bloom Threshold',   min: 0.0,  max: 4.0,  step: 0.01, def: 1.05, unit: '', dp: 2 },
  { key: 'dispersion',    group: 'optics',   label: 'Chromatic Disp.',   min: 0.0,  max: 1.0,  step: 0.01, def: 0.28, unit: '', dp: 2 },
];

export const PARAM_COUNT = PARAM_DEFS.length; // 21

export const PARAM_GROUPS = [
  { id: 'geometry', label: 'Accretion Geometry' },
  { id: 'matter',   label: 'Matter & Relativity' },
  { id: 'sky',      label: 'Deep Sky' },
  { id: 'optics',   label: 'Optics & Grade' },
];

export const DEFAULT_PARAMS = Object.freeze(
  PARAM_DEFS.reduce((acc, d) => { acc[d.key] = d.def; return acc; }, {})
);

export const PARAM_BY_KEY = PARAM_DEFS.reduce((acc, d) => { acc[d.key] = d; return acc; }, {});

/* ------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------ */
export const QUALITY_TIERS = {
  standard: {
    id: 'standard', label: 'STANDARD', hint: 'Laptop / integrated GPU',
    resScale: 0.62, maxDpr: 1.0, maxSteps: 150, baseStep: 0.170, stepScale: 0.98,
    diskCrossings: 3, bloomMips: 4, starLayers: 2, starIter: 1, useBloom: true, minRes: 0.42,
  },
  high: {
    id: 'high', label: 'HIGH', hint: 'Discrete GPU',
    resScale: 1.0, maxDpr: 1.5, maxSteps: 260, baseStep: 0.115, stepScale: 0.99,
    diskCrossings: 5, bloomMips: 5, starLayers: 3, starIter: 1, useBloom: true, minRes: 0.55,
  },
  cinematic: {
    id: 'cinematic', label: 'CINEMATIC', hint: 'Heavy GPU / stills',
    resScale: 1.0, maxDpr: 2.0, maxSteps: 380, baseStep: 0.082, stepScale: 1.0,
    diskCrossings: 7, bloomMips: 6, starLayers: 3, starIter: 2, useBloom: true, minRes: 0.7,
  },
};
export const QUALITY_ORDER = ['standard', 'high', 'cinematic'];
export const DEFAULT_QUALITY = 'high';

/* ------------------------------------------------------------------ *
 * Camera view presets (spherical, scene units, Y = disc normal)
 *
 * `radius` must exceed `diskOuter / DISK_UNIT` for the low-inclination looks,
 * or the camera ends up buried inside the disc and the frame fills with
 * glowing gas — which is exactly what happened to the old ISCO preset at
 * r = 8.4 with a disc out to 19 scene units.
 * ------------------------------------------------------------------ */
export const VIEW_PRESETS = [
  { id: 'ring',     label: 'PHOTON RING',  key: '1', radius: 15.0, theta: 88.6, phi: 128, fov: 34, roll: 0,   hint: 'edge-on, critical structure' },
  { id: 'classic',  label: 'CINEMATIC',    key: '2', radius: 27.0, theta: 74.5, phi: 34,  fov: 42, roll: 1.2, hint: 'Interstellar look' },
  { id: 'isco',     label: 'BEAMING',      key: '3', radius: 13.5, theta: 62.0, phi: 304, fov: 52, roll: -3,  hint: 'close, extreme Doppler beaming' },
  { id: 'polar',    label: 'POLAR SWEEP',  key: '4', radius: 32.0, theta: 19.0, phi: 210, fov: 40, roll: 0,   hint: 'face-on, full disc' },
];

/* ------------------------------------------------------------------ *
 * Debug visualisation modes (keys 0-9)
 * ------------------------------------------------------------------ */
export const DEBUG_MODES = [
  { id: 0, label: 'FINAL COMPOSITE',     hint: 'graded HDR frame' },
  { id: 1, label: 'RAW HDR / FALSE COL', hint: 'pre-tonemap log2 luminance' },
  { id: 2, label: 'INTEGRATION COST',    hint: 'RK4 steps per pixel' },
  { id: 3, label: 'DEFLECTION ANGLE',    hint: 'total light bending (deg)' },
  { id: 4, label: 'IMPACT PARAMETER',    hint: 'b / b_crit, shadow edge = 1' },
  { id: 5, label: 'DOPPLER FACTOR',      hint: 'delta = 1/(gamma(1 - beta.n))' },
  { id: 6, label: 'GRAVITATIONAL SHIFT', hint: 'sqrt(1 - Rs/r) at emission' },
  { id: 7, label: 'DISC TEMPERATURE',    hint: 'observed blackbody T (K)' },
  { id: 8, label: 'DISC CROSSINGS',      hint: 'number of disc intersections' },
  { id: 9, label: 'SKY ONLY (LENSED)',   hint: 'disc suppressed, pure lensing' },
];

/* ------------------------------------------------------------------ *
 * Cinematic shot list — seamless loop (theta/phi/radius/fov keyframes)
 * ------------------------------------------------------------------ */
export const CINEMATIC_SHOTS = [
  { t: 0.0,  radius: 60.0, theta: 87.0, phi: 120.0, fov: 30, label: 'APPROACH' },
  { t: 12.0, radius: 22.0, theta: 88.6, phi: 200.0, fov: 34, label: 'EDGE-ON / PHOTON RING' },
  { t: 24.0, radius: 12.5, theta: 80.0, phi: 285.0, fov: 50, label: 'GRAZING THE DISC' },
  { t: 36.0, radius: 27.0, theta: 74.5, phi: 34.0,  fov: 42, label: 'THE CLASSIC' },
  { t: 48.0, radius: 34.0, theta: 46.0, phi: 300.0, fov: 40, label: 'RISING' },
  { t: 60.0, radius: 32.0, theta: 20.0, phi: 210.0, fov: 40, label: 'POLAR SWEEP' },
  { t: 72.0, radius: 44.0, theta: 62.0, phi: 150.0, fov: 36, label: 'RETURN' },
  { t: 84.0, radius: 60.0, theta: 87.0, phi: 120.0, fov: 30, label: 'APPROACH' }, // == t0 -> loop
];
export const CINEMATIC_LOOP = 84.0;

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */
export const STORAGE_KEY = 'gargantua.schwarzschild.v1';
