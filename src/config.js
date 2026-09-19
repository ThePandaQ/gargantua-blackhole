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
 * and as the query-string / localStorage key.  `zh` is the label shown
 * when the interface is switched to Chinese.
 * ------------------------------------------------------------------ */
export const PARAM_DEFS = [
  // ---- Geometry -------------------------------------------------------
  { key: 'diskInner',     group: 'geometry', label: 'Disc Inner Edge',   zh: '盘内边界',     min: 1.5,  max: 6.0,  step: 0.01, def: 3.0,  unit: 'Rs', dp: 2 },
  { key: 'diskOuter',     group: 'geometry', label: 'Disc Outer Edge',   zh: '盘外边界',     min: 6.0,  max: 34.0, step: 0.05, def: 19.0, unit: 'Rs', dp: 2 },
  { key: 'diskThickness', group: 'geometry', label: 'Disc Thickness',    zh: '盘厚度',       min: 0.01, max: 0.40, step: 0.005, def: 0.085, unit: '', dp: 3 },
  { key: 'diskDensity',   group: 'geometry', label: 'Disc Density',      zh: '盘密度',       min: 0.0,  max: 8.0,  step: 0.02, def: 3.40, unit: '', dp: 2 },
  { key: 'diskSlices',    group: 'geometry', label: 'Disc Turbulence',   zh: '湍流层数',     min: 1,    max: 6,    step: 1,    def: 4,    unit: '', dp: 0 },
  { key: 'diskSpin',      group: 'geometry', label: 'Orbital Speed',     zh: '轨道速度',     min: 0.0,  max: 2.5,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  // ---- Matter ---------------------------------------------------------
  { key: 'diskTemp',      group: 'matter',   label: 'Disc Temperature',  zh: '盘温度',       min: 1200, max: 30000, step: 25,  def: 10500, unit: 'K', dp: 0 },
  { key: 'diskBright',    group: 'matter',   label: 'Disc Brightness',   zh: '盘亮度',       min: 0.0,  max: 6.0,  step: 0.01, def: 1.55, unit: '', dp: 2 },
  { key: 'doppler',       group: 'matter',   label: 'Doppler Boost',     zh: '多普勒增亮',   min: 0.0,  max: 1.0,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  { key: 'redshift',      group: 'matter',   label: 'Grav. Redshift',    zh: '引力红移',     min: 0.0,  max: 1.0,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  { key: 'turbulence',    group: 'matter',   label: 'Turbulence',        zh: '湍流强度',     min: 0.0,  max: 1.0,  step: 0.01, def: 0.72, unit: '', dp: 2 },
  { key: 'flowSpeed',     group: 'matter',   label: 'Flow Animation',    zh: '流动速度',     min: 0.0,  max: 2.0,  step: 0.01, def: 1.0,  unit: '', dp: 2 },
  // ---- Sky ------------------------------------------------------------
  { key: 'starDensity',   group: 'sky',      label: 'Star Density',      zh: '恒星密度',     min: 0.0,  max: 2.0,  step: 0.01, def: 0.85, unit: '', dp: 2 },
  { key: 'starBright',    group: 'sky',      label: 'Star Brightness',   zh: '恒星亮度',     min: 0.0,  max: 5.0,  step: 0.01, def: 1.35, unit: '', dp: 2 },
  { key: 'milkyWay',      group: 'sky',      label: 'Milky Way',         zh: '银河',         min: 0.0,  max: 3.0,  step: 0.01, def: 1.00, unit: '', dp: 2 },
  { key: 'nebula',        group: 'sky',      label: 'Nebula Glow',       zh: '星云辉光',     min: 0.0,  max: 2.0,  step: 0.01, def: 0.42, unit: '', dp: 2 },
  { key: 'skyRotation',   group: 'sky',      label: 'Sky Rotation',      zh: '星空旋转',     min: 0,    max: 360,  step: 0.5,  def: 34.0, unit: 'deg', dp: 1 },
  // ---- Optics ---------------------------------------------------------
  { key: 'exposure',      group: 'optics',   label: 'Exposure',          zh: '曝光',         min: 0.05, max: 4.0,  step: 0.01, def: 1.60, unit: '', dp: 2 },
  { key: 'bloom',         group: 'optics',   label: 'Bloom',             zh: '泛光',         min: 0.0,  max: 2.0,  step: 0.01, def: 0.62, unit: '', dp: 2 },
  { key: 'bloomThreshold',group: 'optics',   label: 'Bloom Threshold',   zh: '泛光阈值',     min: 0.0,  max: 4.0,  step: 0.01, def: 1.05, unit: '', dp: 2 },
  { key: 'dispersion',    group: 'optics',   label: 'Chromatic Disp.',   zh: '色散',         min: 0.0,  max: 1.0,  step: 0.01, def: 0.28, unit: '', dp: 2 },
];

export const PARAM_COUNT = PARAM_DEFS.length; // 21

export const PARAM_GROUPS = [
  { id: 'geometry', label: 'Accretion Geometry',    zh: '吸积盘几何' },
  { id: 'matter',   label: 'Matter & Relativity',   zh: '物质与相对论' },
  { id: 'sky',      label: 'Deep Sky',              zh: '深空背景' },
  { id: 'optics',   label: 'Optics & Grade',        zh: '光学与调色' },
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
    zh: '标准', zhHint: '笔记本 / 核显',
    resScale: 0.62, maxDpr: 1.0, maxSteps: 150, baseStep: 0.170, stepScale: 0.98,
    diskCrossings: 3, bloomMips: 4, starLayers: 2, starIter: 1, useBloom: true, minRes: 0.42,
  },
  high: {
    id: 'high', label: 'HIGH', hint: 'Discrete GPU',
    zh: '高', zhHint: '独立显卡',
    resScale: 1.0, maxDpr: 1.5, maxSteps: 260, baseStep: 0.115, stepScale: 0.99,
    diskCrossings: 5, bloomMips: 5, starLayers: 3, starIter: 1, useBloom: true, minRes: 0.55,
  },
  cinematic: {
    id: 'cinematic', label: 'CINEMATIC', hint: 'Heavy GPU / stills',
    zh: '电影级', zhHint: '高端显卡 / 静帧',
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
  { id: 'ring',     label: 'PHOTON RING',  zh: '光子环',   key: '1', radius: 15.0, theta: 88.6, phi: 128, fov: 34, roll: 0,   hint: 'edge-on, critical structure',   zhHint: '侧视，临界结构' },
  { id: 'classic',  label: 'CINEMATIC',    zh: '电影感',   key: '2', radius: 27.0, theta: 74.5, phi: 34,  fov: 42, roll: 1.2, hint: 'Interstellar look',             zhHint: '《星际穿越》构图' },
  { id: 'isco',     label: 'BEAMING',      zh: '相对论喷流', key: '3', radius: 13.5, theta: 62.0, phi: 304, fov: 52, roll: -3,  hint: 'close, extreme Doppler beaming', zhHint: '近距离，极强多普勒增亮' },
  { id: 'polar',    label: 'POLAR SWEEP',  zh: '极轴俯视', key: '4', radius: 32.0, theta: 19.0, phi: 210, fov: 40, roll: 0,   hint: 'face-on, full disc',            zhHint: '正面俯视，完整盘面' },
];

/* ------------------------------------------------------------------ *
 * Debug visualisation modes (keys 0-9)
 * ------------------------------------------------------------------ */
export const DEBUG_MODES = [
  { id: 0, label: 'FINAL COMPOSITE',     zh: '最终合成',     hint: 'graded HDR frame',                 zhHint: '调色后的 HDR 帧' },
  { id: 1, label: 'RAW HDR / FALSE COL', zh: '原始 HDR 伪彩', hint: 'pre-tonemap log2 luminance',       zhHint: '色调映射前的 log2 亮度' },
  { id: 2, label: 'INTEGRATION COST',    zh: '积分开销',     hint: 'RK4 steps per pixel',              zhHint: '每像素 RK4 步数' },
  { id: 3, label: 'DEFLECTION ANGLE',    zh: '偏折角',       hint: 'total light bending (deg)',        zhHint: '光线总弯折角度（度）' },
  { id: 4, label: 'IMPACT PARAMETER',    zh: '碰撞参数',     hint: 'b / b_crit, shadow edge = 1',      zhHint: 'b / b_crit，阴影边界 = 1' },
  { id: 5, label: 'DOPPLER FACTOR',      zh: '多普勒因子',   hint: 'delta = 1/(gamma(1 - beta.n))',    zhHint: 'δ = 1/(γ(1 − β·n))' },
  { id: 6, label: 'GRAVITATIONAL SHIFT', zh: '引力频移',     hint: 'sqrt(1 - Rs/r) at emission',       zhHint: '发光处 √(1 − Rs/r)' },
  { id: 7, label: 'DISC TEMPERATURE',    zh: '盘观测温度',   hint: 'observed blackbody T (K)',         zhHint: '观测到的黑体温度（K）' },
  { id: 8, label: 'DISC CROSSINGS',      zh: '盘穿越次数',   hint: 'number of disc intersections',     zhHint: '光线穿过盘面的次数' },
  { id: 9, label: 'SKY ONLY (LENSED)',   zh: '仅星空（透镜）', hint: 'disc suppressed, pure lensing',   zhHint: '隐藏盘面，纯引力透镜' },
];

/* ------------------------------------------------------------------ *
 * Cinematic shot list — seamless loop (theta/phi/radius/fov keyframes)
 * ------------------------------------------------------------------ */
export const CINEMATIC_SHOTS = [
  { t: 0.0,  radius: 60.0, theta: 87.0, phi: 120.0, fov: 30, label: 'APPROACH',              zh: '接近' },
  { t: 12.0, radius: 22.0, theta: 88.6, phi: 200.0, fov: 34, label: 'EDGE-ON / PHOTON RING', zh: '侧视 / 光子环' },
  { t: 24.0, radius: 12.5, theta: 80.0, phi: 285.0, fov: 50, label: 'GRAZING THE DISC',      zh: '掠过盘面' },
  { t: 36.0, radius: 27.0, theta: 74.5, phi: 34.0,  fov: 42, label: 'THE CLASSIC',           zh: '经典构图' },
  { t: 48.0, radius: 34.0, theta: 46.0, phi: 300.0, fov: 40, label: 'RISING',                zh: '抬升' },
  { t: 60.0, radius: 32.0, theta: 20.0, phi: 210.0, fov: 40, label: 'POLAR SWEEP',           zh: '极轴扫掠' },
  { t: 72.0, radius: 44.0, theta: 62.0, phi: 150.0, fov: 36, label: 'RETURN',                zh: '返回' },
  { t: 84.0, radius: 60.0, theta: 87.0, phi: 120.0, fov: 30, label: 'APPROACH',              zh: '接近' }, // == t0 -> loop
];
export const CINEMATIC_LOOP = 84.0;

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */
export const STORAGE_KEY = 'gargantua.schwarzschild.v1';
