/**
 * GARGANTUA — Schwarzschild Black Hole Raytracer
 * entry point / orchestrator.
 *
 * Boot order matters:
 *   1. read persisted state + URL overrides
 *   2. probe WebGL2 and floating-point render support (fail loudly, not black)
 *   3. build the pipeline, compile the shaders, THEN hide the boot overlay
 *   4. start the RAF loop
 *
 * Also owns: quality/resolution governance, screenshot automation, context-loss
 * recovery and the on-screen error surface. Nothing here may throw silently —
 * every failure path ends in a readable overlay.
 */

import * as THREE from 'three';
import {
  state, loadState, applyUrlOverrides, saveState, on,
  setQuality, setParam, setDebug, setCinematic, setMusic, setAutoQuality,
  emit, resetPersisted, tier,
} from './state.js';
import {
  PARAM_DEFS, DEFAULT_PARAMS, QUALITY_TIERS, VIEW_PRESETS, DEBUG_MODES,
} from './config.js';
import { t, isZh, applyI18n, missingTranslations } from './i18n/index.js';
import { BlackHolePipeline } from './render/pipeline.js';
import { Governor } from './render/governor.js';
import { CameraRig } from './camera/rig.js';
import { Hud } from './ui/hud.js';
import { AmbientScore } from './audio/ambient.js';

/* ------------------------------------------------------------------ *
 *  tiny DOM helpers + error surface
 * ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const boot = $('#boot');
const bootLog = $('#bootLog');
const bootBar = $('#bootBar');
const lostEl = $('#lost');
const lostMsg = $('#lostMsg');
const fatalEl = $('#fatal');

/* the inline guard in index.html would otherwise fire 15 s in and tell the user
   the app had stalled, when in fact it booted fine */
clearTimeout(window.__GARGANTUA_BOOT_TIMER__);
/* Modules are demonstrably loading, so put the interface into the persisted
   language before anything reads a string from it. */
applyI18n();
if (bootLog) bootLog.textContent = t('boot.compile');

/* A missing translation renders as English (or as the key), which nobody
   notices until a user does. Say so once, loudly, in development. */
{
  const missing = missingTranslations();
  if (missing.length) {
    console.warn('[GARGANTUA] untranslated interface strings:', missing.join(', '));
  }
}

const setBoot = (msg, pct) => {
  if (bootLog) bootLog.textContent = msg;
  if (bootBar) bootBar.style.width = Math.round(pct * 100) + '%';
};

function fatal(titleKey, detail) {
  if (!fatalEl) return;
  fatalEl.querySelector('.fatal-box').innerHTML =
    `<h2>${t(titleKey)}</h2><p>${detail}</p>`;
  fatalEl.classList.add('show');
  if (boot) boot.classList.add('done');
}

window.addEventListener('error', (e) => {
  const msg = e.error?.message || e.message || 'unknown error';
  console.error('[GARGANTUA] uncaught', e.error || e.message);
  if (!running) fatal('fatal.startup.title', escapeHtml(msg));
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[GARGANTUA] unhandled rejection', e.reason);
});

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/* ------------------------------------------------------------------ *
 *  1. configuration
 * ------------------------------------------------------------------ */
loadState();
applyUrlOverrides();

const canvas = $('#scene');
const dprCap = () => Math.min(window.devicePixelRatio || 1, tier().maxDpr);

/* ------------------------------------------------------------------ *
 *  2. renderer
 * ------------------------------------------------------------------ */
let renderer;
let pipeline;
let rig;
let hud;
let score;
let governor;
let running = false;
let rendererEpoch = 0;

function makeRenderer() {
  const r = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    /* The WebGL default is to clear the drawing buffer once the compositor has
       taken the frame. That is the right default for a real-time canvas, but it
       makes `canvas.toDataURL()` a race: it usually wins, and occasionally reads
       back an empty buffer. In the automation path (and only there) the buffer
       is preserved, so the documented capture interface is deterministic. */
    preserveDrawingBuffer: state.boot.screenshotRequested,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  });
  r.autoClear = false;
  r.setClearColor(0x000000, 1);
  /* We hand-encode sRGB in the composite shader, so three must not do it. */
  r.outputColorSpace = THREE.LinearSRGBColorSpace;
  r.debug.checkShaderErrors = false;   // we compile our own programs
  return r;
}

setBoot(t('boot.probe'), 0.06);

const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) {
  fatal('fatal.webgl2.title', t('fatal.webgl2.body'));
  throw new Error('WebGL2 unavailable');
}

try {
  renderer = makeRenderer();
} catch (e) {
  fatal('fatal.ctx.title', escapeHtml(e.message));
  throw e;
}

setBoot(t('boot.compile'), 0.22);

try {
  pipeline = new BlackHolePipeline(renderer, { bloomMips: tier().bloomMips });
} catch (e) {
  console.error('[GARGANTUA] pipeline build failed', e);
  fatal('fatal.shader.title', escapeHtml(e.message).slice(0, 900));
  throw e;
}

setBoot(t('boot.build'), 0.62);

/* ------------------------------------------------------------------ *
 *  3. camera / hud / audio
 * ------------------------------------------------------------------ */
const camera = new THREE.PerspectiveCamera(
  state.camera.fov || 42,
  window.innerWidth / Math.max(window.innerHeight, 1),
  0.01,
  4000
);
rig = new CameraRig(camera, canvas);
score = new AmbientScore();
governor = new Governor(state, {
  tier: () => tier(),
  onTierChange: (id) => { setQuality(id); applyQuality(); },
});

hud = new Hud({
  rig,
  score,
  onFullscreen: toggleFullscreen,
  onScreenshot: (opts) => downloadShot(opts),
  onReset: () => {
    resetPersisted();
    applyQuality();
    pipeline.setSize(0, 0);
    resize(true);
    hud?.syncAll();
    rig.setSpherical(27, 74.5, 34, 42);
    rig.setRoll(1.2);
    hud?.toast(t('toast.reset'));
  },
});

/* if the URL asked for a named preset, honour it before the first frame */
(() => {
  const q = new URLSearchParams(location.search);
  const p = q.get('preset') || q.get('view');
  if (p) rig.setPreset(p);
})();

/* ------------------------------------------------------------------ *
 *  4. sizing
 * ------------------------------------------------------------------ */
let bufW = 2, bufH = 2;

function targetSize() {
  const q = new URLSearchParams(location.search);
  if (q.has('w') && q.has('h')) {
    const w = Math.max(64, Math.min(7680, parseInt(q.get('w'), 10) || 0));
    const h = Math.max(64, Math.min(4320, parseInt(q.get('h'), 10) || 0));
    if (w && h) return { w, h, dpr: 1, forced: true };
  }
  const t = tier();
  const dpr = dprCap();
  const scale = t.resScale * (state.autoQuality ? governor.scale : 1);
  const w = Math.max(160, Math.round(window.innerWidth * dpr * scale));
  const h = Math.max(90, Math.round(window.innerHeight * dpr * scale));
  return { w, h, dpr, forced: false };
}

function applyQuality() {
  const t = tier();
  pipeline.setSize(pipeline.width, pipeline.height, { bloomMips: t.bloomMips });
  const bt = $('#brandTier');
  if (bt) bt.textContent = t.label;
  resize(true);
}

let lastSizeKey = '';
function resize(force = false) {
  const { w, h, dpr, forced } = targetSize();
  const key = `${w}x${h}|${dpr}|${state.quality}|${state.autoQuality}`;
  if (!force && key === lastSizeKey) return;
  lastSizeKey = key;
  bufW = w; bufH = h;
  renderer.setPixelRatio(1);            // we manage the buffer ourselves
  renderer.setSize(w, h, false);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  pipeline.setSize(w, h, { bloomMips: tier().bloomMips });
  camera.aspect = (forced ? w : window.innerWidth) / Math.max(forced ? h : window.innerHeight, 1);
  camera.updateProjectionMatrix();
  state.stats.resScale = state.autoQuality ? governor.scale : 1;
  state.stats.dpr = dpr;
  dirty = true;
}

const onResize = () => { lastSizeKey = ''; resize(true); };
window.addEventListener('resize', onResize, { passive: true });
window.addEventListener('orientationchange', () => setTimeout(onResize, 220), { passive: true });
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize, { passive: true });

/* ------------------------------------------------------------------ *
 *  5. uniforms
 * ------------------------------------------------------------------ */
const paramsVec = { ...DEFAULT_PARAMS };
let dirty = true;
let shotFired = false;

on('param', () => { dirty = true; });
on('debug', () => { dirty = true; });
on('quality', () => { dirty = true; });
on('cinematic', () => { dirty = true; });
on('autoquality', () => { dirty = true; });

function buildUniforms(elapsed) {
  const t = tier();
  const b = rig.basis();
  for (const d of PARAM_DEFS) paramsVec[d.key] = state.params[d.key];
  const dbg = state.debug;
  return {
    time: state.time + elapsed,
    timeScale: state.boot.animate ? 1 : 0,
    camPos: b.pos, camRight: b.right, camUp: b.up, camFwd: b.fwd,
    tanHalfFov: b.tanHalfFov,
    params: paramsVec,
    /* ---- quality budget ---- */
    maxSteps: Math.round(t.maxSteps * (state.autoQuality ? (0.62 + 0.38 * governor.scale) : 1)),
    baseStep: t.baseStep / Math.max(0.55, state.autoQuality ? governor.scale : 1),
    stepScale: t.stepScale,
    diskCrossings: dbg === 8 ? 7 : t.diskCrossings,
    starLayers: t.starLayers,
    starIter: t.starIter,
    /* ---- modes ---- */
    debug: dbg,
    discOn: dbg === 9 ? 0 : 1,
    useBloom: t.useBloom,
    bloomStrength: state.params.bloom,
    bloomThreshold: state.params.bloomThreshold,
    /* ---- grade ---- */
    exposure: state.params.exposure,
    dispersion: state.params.dispersion,
    grain: 0.85,
    vignette: 0.92,
    /* the automated driver switches bloom off while it measures the raw HDR
       buffer, so that a deterministic comparison is not perturbed by the
       pyramid; nothing in the shipped interface sets this */
    probeMode: !!state.boot.probeMode,
  };
}

/* ------------------------------------------------------------------ *
 *  6. the loop
 * ------------------------------------------------------------------ */
let last = performance.now();
let elapsed = 0;
let fpsAcc = 0, fpsN = 0, fpsOut = 0;
let msOut = 0;
let hudAcc = 0;
let renderCount = 0;
let lastMaxSteps = 0;
let halted = false;
let rafId = 0;
let simControl = false;   // when true, only setSimTime() moves the sim clock
/* the RAF handle is captured so an automated driver can take over the loop */
const scheduleFrame = () => { rafId = requestAnimationFrame(tick); };

function tick(now) {
  if (!running || halted) return;
  scheduleFrame();
  step(now);
}

/**
 * Advance the simulation and render exactly one frame.
 *
 * @param {number} now  high-resolution timestamp in ms (performance.now())
 * @returns {boolean}   whether a GPU frame was actually submitted
 *
 * Exposed as GARGANTUA.step() so headless drivers can produce bit-deterministic
 * frames without depending on requestAnimationFrame, which is starved in
 * `chrome --headless` when virtual time is enabled.
 */
function step(now) {
  const rawMs = Math.max(0, now - last);
  last = now;
  const dt = Math.min(rawMs / 1000, 0.25);
  let submitted = false;

  if (renderer.getContext().isContextLost()) {
    onContextLost();
    return false;
  }

  /* -- simulation clock: frozen when ?animate=0 or a still is requested -- */
  const animate = state.boot.animate && !state.boot.screenshotRequested;
  if (animate && !simControl) elapsed += dt;

  /* -- camera -- */
  rig.update(dt, elapsed);

  /* -- quality governance -- */
  if (state.autoQuality && !state.boot.screenshotRequested) {
    governor.update(dt, now / 1000, 0);
    state.stats.resScale = governor.scale;
    const { w } = targetSize();
    if (w !== bufW) { lastSizeKey = ''; resize(); }
  }

  /* -- render: continuous while the flow animates, otherwise on demand -- */
  const moving = state.cinematic || animate || state.params.flowSpeed > 0.0001;
  if ((dirty || moving || state.boot.screenshotRequested) && pipeline) {
    const u = buildUniforms(elapsed);
    lastMaxSteps = u.maxSteps;
    const ok = pipeline.frame(u);
    if (ok) {
      renderCount++;
      submitted = true;
      if (state.boot.screenshotRequested && !shotFired) {
        shotFired = true;
        finishShot(u);
        halted = true;               // deterministic still: stop advancing
      }
    }
    dirty = false;
  }

  /* -- telemetry -- */
  fpsAcc += rawMs; fpsN++;
  if (fpsAcc >= 240) {
    fpsOut = 1000 / (fpsAcc / fpsN);
    msOut = rawMs;
    governor.push(fpsAcc / fpsN);
    fpsAcc = 0; fpsN = 0;
  }
  hudAcc += dt;
  if (hudAcc > 0.2 && hud) {
    hudAcc = 0;
    state.stats.fps = fpsOut; state.stats.ms = msOut;
    state.stats.bufferW = bufW; state.stats.bufferH = bufH;
    state.stats.maxSteps = lastMaxSteps;
    hud.update(now / 1000, state.stats);
    hud.updateCinematicBar(state.cinematic ? rig.shotProgress : 0);
  }

  score?.tick();
  return submitted;
}

/* ------------------------------------------------------------------ *
 *  7. screenshot automation
 * ------------------------------------------------------------------ */
function finishShot(u) {
  try {
    const url = canvas.toDataURL('image/png');
    window.__GARGANTUA_SHOT__ = url;
    window.__GARGANTUA_READY__ = true;
    const meta = {
      width: canvas.width, height: canvas.height,
      time: u.time, quality: state.quality, debug: state.debug,
      camera: rig.getSpherical(), fov: camera.fov,
      steps: u.maxSteps, crossings: u.diskCrossings,
    };
    window.__GARGANTUA_META__ = meta;
    window.dispatchEvent(new CustomEvent('gargantua:shot', { detail: meta }));
    /* Populate telemetry before going still: the HUD refreshes on a timer that
       only runs while frames are being produced, so a frozen capture would
       otherwise show an empty panel and a DOM screenshot would record it. */
    state.stats.bufferW = bufW;
    state.stats.bufferH = bufH;
    state.stats.maxSteps = lastMaxSteps;
    state.stats.fps = fpsOut || 0;
    state.stats.ms = msOut || 0;
    hud?.update(performance.now() / 1000, state.stats);
    hud?.updateCinematicBar(state.cinematic ? rig.shotProgress : 0);
    /* A still is finished the moment the frame is captured: drop the boot
       curtain immediately rather than waiting for its fade, so a screenshot
       taken by an external tool never catches it mid-transition. */
    boot?.classList.add('done');
    if (boot) boot.style.display = 'none';
    if (state.hud) hud?.toast(t('toast.shotReady'), 4200);
    setBoot(t('boot.captured'), 1);
  } catch (e) {
    console.error('[GARGANTUA] screenshot failed', e);
  }
}

function downloadShot() {
  try {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `gargantua_${Date.now()}.png`;
    a.click();
    hud?.toast(t('toast.pngSaved'));
  } catch (e) {
    console.error('[GARGANTUA] download failed', e);
    hud?.toast(t('toast.pngFailed'));
  }
}

/* ------------------------------------------------------------------ *
 *  8. fullscreen
 * ------------------------------------------------------------------ */
async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (e) { hud?.toast(t('toast.fsBlocked')); }
}

/* ------------------------------------------------------------------ *
 *  9. context loss / recovery
 * ------------------------------------------------------------------ */
let lostShown = false;
function onContextLost() {
  if (lostShown) return;
  lostShown = true;
  state.contextLost = true;
  running = false;
  if (lostEl) {
    lostEl.classList.add('show');
    if (lostMsg) lostMsg.textContent = t('lost.body');
  }
  emit('contextlost', {});
}

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.warn('[GARGANTUA] WebGL context lost — awaiting restore');
  onContextLost();
}, false);

canvas.addEventListener('webglcontextrestored', () => {
  console.info('[GARGANTUA] WebGL context restored — rebuilding GPU resources');
  recover();
}, false);

function recover() {
  try {
    rendererEpoch++;
    /* The old context is gone; three.js objects belonging to it must not be
       deleted through the new one (that logs "object does not belong to this
       context" and spams the console). Drop the references instead. */
    if (!state.contextLost) {
      try { pipeline.destroy(); } catch (e) { /* ignore */ }
    }
    pipeline = null;
    try { renderer.dispose(); } catch (e) { /* ignore */ }

    renderer = makeRenderer();
    camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    camera.updateProjectionMatrix();

    pipeline = new BlackHolePipeline(renderer, { bloomMips: tier().bloomMips });
    lastSizeKey = '';
    resize(true);
    governor.reset();
    lostShown = false;
    state.contextLost = false;
    shotFired = false;
    halted = false;
    lostEl?.classList.remove('show');
    /* an automated driver may have paused the loop; recovery always restarts it */
    if (!running) { running = true; last = performance.now(); scheduleFrame(); }
    hud?.toast(t('toast.ctxRestored'), 2600);
  } catch (e) {
    console.error('[GARGANTUA] recovery failed', e);
    if (lostMsg) lostMsg.textContent =
      t('lost.failed') + ': ' + e.message + (isZh()
        ? ' —— 请点击“立即恢复”重试，或刷新页面。'
        : ' — press RESTORE NOW to try again, or reload the page.');
  }
}
$('#lostBtn')?.addEventListener('click', () => {
  if (renderer.getContext().isContextLost()) {
    /* the driver has not handed the context back yet: ask three to force it */
    try {
      const ext = renderer.getContext().getExtension('WEBGL_lose_context');
      ext?.restoreContext();
    } catch (e) { /* ignore */ }
    if (lostMsg) lostMsg.textContent = t('lost.waiting');
  } else {
    recover();
  }
});

/* ------------------------------------------------------------------ *
 *  10. go
 * ------------------------------------------------------------------ */
function bootDone() {
  setBoot(t('boot.done'), 1);
  boot?.classList.add('done');
  setTimeout(() => {
    if (boot && !state.boot.screenshotRequested) boot.style.display = 'none';
  }, 1000);
}

/* the shaders are already compiled at this point: the expensive, failure-prone
   work happened before the overlay lifts, so a successful boot cannot black-screen */
resize(true);
hud.syncAll();

/* music is allowed to auto-start only when the browser lets us */
if (state.music) {
  score.setPlaying(true).then((ok) => {
    if (!ok) { state.music = false; emit('music', { music: false }); }
    hud.syncToggles();
  }).catch(() => { state.music = false; hud.syncToggles(); });
}

running = true;
last = performance.now();
scheduleFrame();

/* give the first frame a chance to land before the curtain lifts */
setTimeout(() => {
  bootDone();
  window.__GARGANTUA_BOOTED__ = true;
  emit('boot', {});
}, state.boot.screenshotRequested ? 700 : 420);

/* keep the URL clean of automation parameters so a refresh is a fresh boot */
if (state.boot.screenshotRequested) {
  document.title = 'GARGANTUA — capturing frame';
}

/* expose a small, documented control surface for automation and debugging */
window.GARGANTUA = {
  version: '1.0.0',
  THREE,
  state,
  setParam, setQuality, setDebug, setCinematic, setMusic, setAutoQuality,
  preset: (id) => rig.setPreset(id),
  /* pin the camera roll and zero its organic drift, for reproducible stills */
  setRoll: (deg) => {
    rig.driftRoll = 0;
    rig.setRoll(Number(deg) || 0, { instant: true });
    rig.roll = Number(deg) || 0;
    rig.applyRoll();
    dirty = true;
  },
  screenshot: (opts) => downloadShot(opts),
  presets: VIEW_PRESETS.map((v) => v.id),
  /* the shipped preset definitions, so an external test can assert against the
     same numbers the interface uses instead of duplicating them */
  presetInfo: (id) => VIEW_PRESETS.find((v) => v.id === id) || null,
  debugModes: DEBUG_MODES.map((d) => `${d.id} ${d.label}`),
  params: PARAM_DEFS.map((d) => d.key),
  get renderer() { return renderer; },
  get pipeline() { return pipeline; },
  get rig() { return rig; },
  get info() {
    return {
      booted: !!window.__GARGANTUA_BOOTED__,
      frames: renderCount,
      buffer: [bufW, bufH],
      quality: state.quality,
      epoch: rendererEpoch,
      lost: state.contextLost,
    };
  },
  recover,
  /* deterministic manual frame driver — used by tools/acceptance.mjs */
  step: (ms) => step(Number.isFinite(ms) ? ms : performance.now()),
  pauseLoop: () => { running = false; cancelAnimationFrame(rafId); },
  resumeLoop: () => {
    if (running) return;
    halted = false; running = true; last = performance.now(); scheduleFrame();
  },
  get running() { return running; },
  /* RGBA readback of the composited canvas. Requires the frame to still be in
     the drawing buffer, so call it immediately after step() and never while
     the animation loop is running. */
  readPixels: () => {
    const gl = renderer.getContext();
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { width: w, height: h, data: Array.from(px) };
  },
  /* Deterministic pre-grade sample of the HDR scene buffer. The probe is only
     meaningful when the composite's temporal dither is not in play, so the
     caller is expected to have frozen the clock. */
  probe: (n) => {
    state.boot.probeMode = true;
    dirty = true;
    step(performance.now());
    const out = pipeline ? pipeline.probe(n) : null;
    state.boot.probeMode = false;
    dirty = true;
    return out;
  },
  /* ray-domain readback: the alpha channel of the HDR buffer is 1 for rays
     that terminated on the horizon, 0.4 for rays that escaped, 0.05 for rays
     the disc stopped. Lets a test ask "how big is the shadow?" in ray space
     without going anywhere near the display pipeline. */
  readSceneHDR: () => {
    state.boot.probeMode = true;
    dirty = true;
    step(performance.now());
    const out = pipeline ? pipeline.readSceneHDR() : null;
    state.boot.probeMode = false;
    dirty = true;
    return out;
  },
  /* Absolute control of the simulation clock, for tests that need a known
     amount of disc rotation rather than a known number of frames. While
     simControl is on, step() advances real time (so camera damping and fov
     easing still work) but leaves the simulation clock exactly where the caller
     put it. */
  setSimTime: (seconds) => {
    simControl = true;
    elapsed = Number(seconds) || 0;
    dirty = true;
  },
  /**
   * Freeze every continuously-varying input: the simulation clock, the camera
   * roll drift, the damped orbit, and the fov easing. With all of those held,
   * the frame becomes a pure function of the parameters — which is what lets a
   * test tell "the disc is animating" apart from "the camera is still
   * settling".
   */
  freeze: (simTime) => {
    simControl = true;
    if (Number.isFinite(simTime)) elapsed = simTime;
    rig.driftRoll = 0;
    rig.roll = rig.baseRoll;
    rig.applyRoll();
    rig.fovCurrent = rig.fovTarget;
    camera.fov = rig.fovTarget;
    camera.updateProjectionMatrix();
    rig.controls.enableDamping = false;
    rig.controls.update();
    rig.frozen = true;
    dirty = true;
  },
  releaseSimTime: () => {
    simControl = false;
    rig.frozen = false;
    rig.controls.enableDamping = true;
  },
  get simTime() { return state.time + elapsed; },
};
