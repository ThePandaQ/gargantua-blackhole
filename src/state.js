/**
 * GARGANTUA — state store.
 *
 * Resolution order (lowest -> highest priority):
 *   DEFAULT_PARAMS  ->  localStorage  ->  URL query string (deep-linkable)
 *
 * Everything is debounce-persisted so slider drags do not thrash localStorage.
 */

import {
  DEFAULT_PARAMS, PARAM_BY_KEY, PARAM_DEFS,
  DEFAULT_QUALITY, QUALITY_TIERS, STORAGE_KEY,
} from './config.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The out-of-the-box folding: the two groups that change the look most are open,
 * the other two are shut, so the panel fits a 720 px-tall viewport without
 * scrolling. Users can then fold everything away to watch the render.
 */
export function defaultCollapsed() {
  return { geometry: false, matter: false, sky: true, optics: true };
}

/* ------------------------------------------------------------------ *
 *  URL overrides
 *
 *  Applied AFTER the persisted state, so a link always wins over whatever the
 *  browser had stored. They are collected here rather than in loadState() so
 *  the "which wins" rule is stated in exactly one place.
 * ------------------------------------------------------------------ */

const boolOf = (v, dflt) => {
  if (v === null || v === undefined || v === '') return dflt;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return dflt;
};

export const state = {
  params: clone(DEFAULT_PARAMS),
  quality: DEFAULT_QUALITY,
  debug: 0,
  cinematic: true,
  autoQuality: true,
  hud: true,
  music: false,
  /** 'en' | 'zh' */
  lang: 'en',
  /**
   * Parameter groups folded shut, by group id. Independent from `hud`, which
   * hides everything: the point of collapsing is to keep the readouts while
   * giving the render the screen.
   */
  collapsed: {},
  time: 0,
  /* camera: spherical about the singularity, scene units */
  camera: { radius: 27, theta: 74.5, phi: 34, fov: 42, roll: 1.2 },
  /* runtime / not persisted */
  boot: {
    screenshotRequested: false, shotDelay: 0, shotTime: 0,
    outWidth: 0, outHeight: 0, ui: true, animate: true, autoplayMusic: false,
  },
  stats: { fps: 0, ms: 0, resScale: 1, heap: 0 },
  contextLost: false,
};

/* ---------------------------------------------------------------- utils */

const clampNum = (v, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(d.max, Math.max(d.min, n));
};

function applyParam(key, value) {
  const d = PARAM_BY_KEY[key];
  if (!d) return false;
  state.params[key] = clampNum(value, d);
  return true;
}

/* ------------------------------------------------------------ persistence */

let saveTimer = 0;

export function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload = {
        v: 1,
        params: state.params,
        quality: state.quality,
        debug: state.debug,
        cinematic: state.cinematic,
        autoQuality: state.autoQuality,
        hud: state.hud,
        music: state.music,
        lang: state.lang,
        collapsed: state.collapsed,
        camera: state.camera,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) { /* private mode / quota — non fatal */ }
  }, 220);
}

export function loadState() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
  /* Nothing stored yet: start from the shipped folding rather than from an
     empty object, which would report every group as expanded. */
  if (!raw) {
    state.collapsed = defaultCollapsed();
    return state;
  }
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') {
      if (p.params) for (const d of PARAM_DEFS) {
        if (p.params[d.key] !== undefined) applyParam(d.key, p.params[d.key]);
      }
      if (QUALITY_TIERS[p.quality]) state.quality = p.quality;
      if (Number.isInteger(p.debug)) state.debug = Math.min(9, Math.max(0, p.debug));
      if (typeof p.cinematic === 'boolean') state.cinematic = p.cinematic;
      if (typeof p.autoQuality === 'boolean') state.autoQuality = p.autoQuality;
      if (typeof p.hud === 'boolean') state.hud = p.hud;
      if (typeof p.music === 'boolean') state.music = p.music;
      if (p.lang === 'zh' || p.lang === 'en') state.lang = p.lang;
      if (p.collapsed && typeof p.collapsed === 'object') {
        for (const k of Object.keys(p.collapsed)) state.collapsed[k] = !!p.collapsed[k];
      }
      if (p.camera) for (const k of ['radius', 'theta', 'phi', 'fov', 'roll']) {
        if (Number.isFinite(p.camera[k])) state.camera[k] = p.camera[k];
      }
    }
  } catch (e) { /* corrupted payload — fall back to the shipped defaults */ }
  return state;
}

export function resetPersisted() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  state.params = clone(DEFAULT_PARAMS);
  state.quality = DEFAULT_QUALITY;
  state.debug = 0;
  state.camera = { radius: 27, theta: 74.5, phi: 34, fov: 42, roll: 1.2 };
  state.cinematic = true;
  state.collapsed = defaultCollapsed();
  saveState();
}

/* ------------------------------------------------------------------- URL */

export function applyUrlOverrides(search = location.search) {
  const q = new URLSearchParams(search);
  if (![...q.keys()].length) return;

  for (const d of PARAM_DEFS) {
    if (q.has(d.key)) applyParam(d.key, q.get(d.key));
    else if (q.has('p_' + d.key)) applyParam(d.key, q.get('p_' + d.key));
  }
  if (q.has('quality') && QUALITY_TIERS[q.get('quality')]) state.quality = q.get('quality');
  if (q.has('debug')) state.debug = Math.min(9, Math.max(0, parseInt(q.get('debug'), 10) || 0));
  if (q.has('hud')) state.hud = boolOf(q.get('hud'), state.hud);
  if (q.has('ui')) { state.hud = boolOf(q.get('ui'), state.hud); state.boot.ui = state.hud; }
  if (q.has('cinematic')) state.cinematic = boolOf(q.get('cinematic'), state.cinematic);
  if (q.has('music')) state.music = boolOf(q.get('music'), state.music);
  if (q.has('lang') && (q.get('lang') === 'zh' || q.get('lang') === 'en')) state.lang = q.get('lang');
  if (q.has('auto')) state.autoQuality = boolOf(q.get('auto'), state.autoQuality);
  if (q.has('cam')) {
    const n = q.get('cam').split(',').map(Number);
    if (n.length >= 3 && n.every(Number.isFinite)) {
      state.camera.radius = Math.max(4, n[0]);
      state.camera.theta = n[1];
      state.camera.phi = n[2];
      if (n.length > 3) state.camera.fov = Math.min(100, Math.max(12, n[3]));
    }
  }
  /* headless screenshot automation */
  state.boot.screenshotRequested = boolOf(q.get('shot'), false);
  if (q.has('shot')) {
    state.boot.shotDelay = Number(q.get('shotDelay') ?? 0.6) || 0.6;
    state.boot.shotTime = Number(q.get('t') ?? 0) || 0;
    state.boot.outWidth = parseInt(q.get('w'), 10) || 0;
    state.boot.outHeight = parseInt(q.get('h'), 10) || 0;
    /* A capture request means "give me the picture", so it must not inherit the
       diagnostic view someone left switched on. Without this, one person
       leaving `9` selected poisons every later capture through localStorage —
       which is exactly how two frames in the gallery came out black. An
       explicit debug= in the URL still wins, because it is applied above. */
    if (!q.has('debug')) state.debug = 0;
  }
  if (q.has('time')) state.time = Number(q.get('time')) || 0;
  if (q.has('animate')) state.boot.animate = boolOf(q.get('animate'), true);
  if (q.has('t') && !state.boot.screenshotRequested) state.time = Number(q.get('t')) || 0;
  /* The HUD is hidden for stills, and a hidden parameter panel should not keep
     reporting itself as expanded — `?ui=0&collapse=1` gives the cleanest frame. */
  if (q.has('collapse')) {
    const on_ = boolOf(q.get('collapse'), false);
    for (const k of Object.keys(state.collapsed)) state.collapsed[k] = on_;
  }
}

/* ------------------------------------------------------------------ events */

const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, fn);
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export function setParam(key, value, { silent = false } = {}) {
  if (!applyParam(key, value)) return;
  if (!silent) {
    emit('param', { key, value: state.params[key] });
    saveState();
  }
}

export function setQuality(id, { silent = false } = {}) {
  if (!QUALITY_TIERS[id]) return;
  state.quality = id;
  if (!silent) { emit('quality', { quality: id }); saveState(); }
}

export function setDebug(n, { silent = false } = {}) {
  state.debug = Math.min(9, Math.max(0, n | 0));
  if (!silent) { emit('debug', { debug: state.debug }); saveState(); }
}

export function setCinematic(on_, { silent = false } = {}) {
  state.cinematic = !!on_;
  if (!silent) { emit('cinematic', { cinematic: state.cinematic }); saveState(); }
}

export function setMusic(on_, { silent = false } = {}) {
  state.music = !!on_;
  if (!silent) { emit('music', { music: state.music }); saveState(); }
}

export function setAutoQuality(on_, { silent = false } = {}) {
  state.autoQuality = !!on_;
  if (!silent) { emit('autoquality', { autoQuality: state.autoQuality }); saveState(); }
}

export function setLang(id, { silent = false } = {}) {
  if (id !== 'zh' && id !== 'en') return;
  if (state.lang === id) return;
  state.lang = id;
  if (!silent) { emit('lang', { lang: id }); saveState(); }
}

export function setCollapsed(groupId, on_, { silent = false } = {}) {
  state.collapsed[groupId] = !!on_;
  if (!silent) { emit('collapsed', { group: groupId, collapsed: !!on_ }); saveState(); }
}

export function setAllCollapsed(on_, { silent = false } = {}) {
  for (const k of Object.keys(state.collapsed)) state.collapsed[k] = !!on_;
  if (!silent) { emit('collapsed', { group: '*', collapsed: !!on_ }); saveState(); }
}

export const anyExpanded = () => Object.values(state.collapsed).some((v) => !v);

export const tier = () => QUALITY_TIERS[state.quality] || QUALITY_TIERS[DEFAULT_QUALITY];
