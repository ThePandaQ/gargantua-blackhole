/**
 * GARGANTUA — heads-up display.
 *
 * Builds the 21 parameter sliders from config, wires every hotkey, and owns the
 * live telemetry readout. It writes nothing to the render pipeline directly: it
 * mutates `state` and emits events, so the HUD can be removed entirely with `H`
 * or `?ui=0` and the renderer keeps working.
 */

import {
  PARAM_DEFS, PARAM_GROUPS, DEBUG_MODES, VIEW_PRESETS,
  QUALITY_TIERS, QUALITY_ORDER, PARAM_COUNT,
} from '../config.js';
import {
  state, setParam, setQuality, setDebug, setCinematic, setMusic,
  setAutoQuality, saveState, resetPersisted, on, emit,
} from '../state.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export class Hud {
  constructor({ rig, score, onFullscreen, onScreenshot, onReset }) {
    this.rig = rig;
    this.score = score;
    this.onFullscreen = onFullscreen;
    this.onScreenshot = onScreenshot;
    this.onReset = onReset;
    this.toastTimer = 0;
    this.fpsSmooth = 60;
    this.el = {
      root: $('#hud'),
      sliders: $('#paramSliders'),
      stats: $('#stats'),
      debugLabel: $('#debugLabel'),
      debugDots: $('#debugDots'),
      qualityBtns: $$('#qualityGroup [data-quality]'),
      presetBtns: $$('#presetGroup [data-preset]'),
      toast: $('#toast'),
      help: $('#helpOverlay'),
      paramCount: $$('.param-count'),
      musicBtn: $('#musicBtn'),
      cineBtn: $('#cineBtn'),
      autoBtn: $('#autoBtn'),
      hudBtn: $('#hudBtn'),
      shotBtn: $('#shotBtn'),
      fsBtn: $('#fsBtn'),
      resetBtn: $('#resetBtn'),
    };
    this._buildSliders();
    this._buildDebugDots();
    this._bindButtons();
    this._bindKeys();
    this._bindState();
    this.syncAll();
  }

  /* ------------------------------------------------------------ building */
  _buildSliders() {
    const frag = document.createDocumentFragment();
    for (const g of PARAM_GROUPS) {
      const wrap = document.createElement('div');
      wrap.className = 'pgroup';
      const h = document.createElement('div');
      h.className = 'pgroup-title';
      h.innerHTML = `<span>${g.label}</span>`;
      wrap.appendChild(h);

      for (const d of PARAM_DEFS.filter((p) => p.group === g.id)) {
        const row = document.createElement('div');
        row.className = 'prow';
        row.dataset.key = d.key;
        row.title = `${d.key}  •  range ${d.min} … ${d.max} (double-click to reset)`;

        const lab = document.createElement('label');
        lab.className = 'plabel';
        lab.textContent = d.label;
        lab.htmlFor = 'p_' + d.key;

        const val = document.createElement('span');
        val.className = 'pval';
        val.id = 'v_' + d.key;

        const head = document.createElement('div');
        head.className = 'phead';
        head.append(lab, val);

        const inp = document.createElement('input');
        inp.type = 'range';
        inp.id = 'p_' + d.key;
        inp.min = String(d.min);
        inp.max = String(d.max);
        inp.step = String(d.step);
        inp.value = String(state.params[d.key]);
        inp.setAttribute('aria-label', d.label);
        inp.addEventListener('input', () => {
          setParam(d.key, parseFloat(inp.value));
          this._paint(d);
        });
        inp.addEventListener('dblclick', () => {
          setParam(d.key, d.def);
          this.syncParam(d.key);
          this.toast(`${d.label} reset`);
        });

        row.append(head, inp);
        wrap.appendChild(row);
      }
      frag.appendChild(wrap);
    }
    this.el.sliders.appendChild(frag);
    this.el.paramCount.forEach((n) => { n.textContent = String(PARAM_COUNT); });
  }

  _buildDebugDots() {
    const frag = document.createDocumentFragment();
    for (const m of DEBUG_MODES) {
      const b = document.createElement('button');
      b.className = 'dot';
      b.dataset.debug = String(m.id);
      b.textContent = String(m.id);
      b.title = `${m.id} — ${m.label} (${m.hint})`;
      b.addEventListener('click', () => setDebug(m.id));
      frag.appendChild(b);
    }
    this.el.debugDots.appendChild(frag);
  }

  _bindButtons() {
    this.el.qualityBtns.forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.quality)));
    this.el.presetBtns.forEach((b) => b.addEventListener('click', () => {
      const p = this.rig.setPreset(b.dataset.preset);
      if (p) this.toast(`VIEW — ${p.label}`);
    }));
    this.el.cineBtn?.addEventListener('click', () => setCinematic(!state.cinematic));
    this.el.autoBtn?.addEventListener('click', () => setAutoQuality(!state.autoQuality));
    this.el.hudBtn?.addEventListener('click', () => this.setHud(!state.hud));
    this.el.musicBtn?.addEventListener('click', () => this.toggleMusic());
    this.el.shotBtn?.addEventListener('click', () => this.onScreenshot?.());
    this.el.fsBtn?.addEventListener('click', () => this.onFullscreen?.());
    this.el.resetBtn?.addEventListener('click', () => this.onReset?.());
  }

  /* ------------------------------------------------------------- hotkeys */
  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const lower = k.toLowerCase();

      if (k >= '0' && k <= '9') { setDebug(parseInt(k, 10)); this.toast(`DEBUG ${k} — ${DEBUG_MODES[parseInt(k, 10)].label}`); e.preventDefault(); return; }

      switch (lower) {
        case 'c': setCinematic(!state.cinematic); this.toast(state.cinematic ? 'CINEMATIC CAMERA — ON' : 'CINEMATIC CAMERA — OFF'); break;
        case 'h': this.setHud(!state.hud); break;
        case 'm': this.toggleMusic(); break;
        case 'f': this.onFullscreen?.(); break;
        case 'p': this.onScreenshot?.(); break;
        case 'r': this.onReset?.(); break;
        case 'q': {
          const i = QUALITY_ORDER.indexOf(state.quality);
          const next = QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length];
          setQuality(next);
          this.toast(`QUALITY — ${QUALITY_TIERS[next].label}`);
          break;
        }
        case 'a': setAutoQuality(!state.autoQuality); this.toast(`AUTO QUALITY — ${state.autoQuality ? 'ON' : 'OFF'}`); break;
        case 'v': {
          const p = this.rig.cyclePreset(1);
          if (p) this.toast(`VIEW — ${p.label}`);
          break;
        }
        case 'n': {
          const p = this.rig.cyclePreset(-1);
          if (p) this.toast(`VIEW — ${p.label}`);
          break;
        }
        case 'arrowleft': case 'arrowright': {
          const dir = lower === 'arrowright' ? 1 : -1;
          const i = VIEW_PRESETS.findIndex((v) => v.id === this._presetNear());
          const nxt = VIEW_PRESETS[(i + dir + VIEW_PRESETS.length) % VIEW_PRESETS.length];
          this.rig.setPreset(nxt.id);
          this.toast(`VIEW — ${nxt.label}`);
          e.preventDefault();
          break;
        }
        case '?': case '/': this.toggleHelp(); e.preventDefault(); break;
        case 'escape': this.hideHelp(); break;
        default: break;
      }
    });
  }

  _presetNear() {
    let best = VIEW_PRESETS[0].id;
    let bd = Infinity;
    for (const p of VIEW_PRESETS) {
      const d = Math.abs(p.fov - this.rig.fovTarget) + Math.abs(p.radius - state.camera.radius) * 0.2;
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }

  /* --------------------------------------------------------------- state */
  _bindState() {
    on('param', (e) => this.syncParam(e.detail.key));
    on('debug', () => this.syncDebug());
    on('quality', () => this.syncQuality());
    on('cinematic', () => this.syncToggles());
    on('music', () => this.syncToggles());
    on('autoquality', () => this.syncToggles());
  }

  syncAll() {
    PARAM_DEFS.forEach((d) => this.syncParam(d.key));
    this.syncDebug();
    this.syncQuality();
    this.syncToggles();
    this.setHud(state.hud);
  }

  _fmt(d, v) {
    let s = d.dp > 0 ? v.toFixed(d.dp) : String(Math.round(v));
    if (d.unit === 'deg') s += '°';
    else if (d.unit) s += ' ' + d.unit;
    return s;
  }

  _paint(d) {
    const v = state.params[d.key];
    const el = document.getElementById('v_' + d.key);
    if (el) el.textContent = this._fmt(d, v);
    const row = this.el.sliders.querySelector(`.prow[data-key="${d.key}"]`);
    if (row) {
      const pc = (v - d.min) / (d.max - d.min);
      row.style.setProperty('--fill', (pc * 100).toFixed(1) + '%');
    }
  }

  syncParam(key) {
    const d = PARAM_DEFS.find((p) => p.key === key);
    if (!d) return;
    const inp = document.getElementById('p_' + key);
    if (inp && parseFloat(inp.value) !== state.params[key]) inp.value = String(state.params[key]);
    this._paint(d);
  }

  syncDebug() {
    const m = DEBUG_MODES[state.debug] || DEBUG_MODES[0];
    if (this.el.debugLabel) this.el.debugLabel.textContent = `${state.debug} · ${m.label}`;
    $$('.dot', this.el.debugDots).forEach((b) => b.classList.toggle('on', Number(b.dataset.debug) === state.debug));
  }

  syncQuality() {
    this.el.qualityBtns.forEach((b) => b.classList.toggle('on', b.dataset.quality === state.quality));
    const bt = document.getElementById('brandTier');
    if (bt) bt.textContent = QUALITY_TIERS[state.quality].label;
  }

  syncToggles() {
    const musicOn = !!(state.music && this.score && this.score.playing);
    this.el.cineBtn?.classList.toggle('on', state.cinematic);
    this.el.autoBtn?.classList.toggle('on', state.autoQuality);
    this.el.musicBtn?.classList.toggle('on', musicOn);
    if (this.el.musicBtn) this.el.musicBtn.textContent = musicOn ? '♪ ON' : 'MUSIC';
    if (this.el.cineBtn) this.el.cineBtn.textContent = state.cinematic ? '◉ LOOP' : 'CINEMA';
  }

  setHud(on_) {
    state.hud = !!on_;
    this.el.root?.classList.toggle('hud-hidden', !state.hud);
    saveState();
  }

  /* -------------------------------------------------------------- extras */
  async toggleMusic() {
    if (!this.score) return;
    const want = !(state.music && this.score.playing);
    const ok = await this.score.setPlaying(want);
    state.music = want && ok;
    emit('music', { music: state.music });
    this.syncToggles();
    if (want && !ok) this.toast('AUDIO BLOCKED — click the page first');
    else this.toast(state.music ? 'AMBIENT SCORE — ON' : 'AMBIENT SCORE — OFF');
    saveState();
  }

  toggleHelp() {
    const el = this.el.help;
    if (!el) return;
    el.classList.toggle('show');
  }
  hideHelp() { this.el.help?.classList.remove('show'); }

  toast(msg, ms = 1900) {
    const el = this.el.toast;
    if (!el) return;
    /* a still capture must be byte-reproducible, so nothing transient is drawn
       over it — the toast is for interactive use only */
    if (state.boot.screenshotRequested) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ---------------------------------------------------------------- loop */
  update(t, stats) {
    const e = this.el.stats;
    if (!e) return;
    const sp = this.rig.getSpherical();
    const m = DEBUG_MODES[state.debug] || DEBUG_MODES[0];
    const tier = QUALITY_TIERS[state.quality];
    const cam = this.rig.camera;
    e.innerHTML = `
      <div class="srow"><span>FPS</span><b>${stats.fps.toFixed(1)} / ${stats.ms.toFixed(1)} ms</b></div>
      <div class="srow"><span>BUFFER</span><b>${stats.bufferW}×${stats.bufferH}</b></div>
      <div class="srow"><span>SCALE · DPR</span><b>${(stats.resScale * 100).toFixed(0)}% · ${stats.dpr.toFixed(2)}×</b></div>
      <div class="srow"><span>TIER</span><b>${tier.label}${state.autoQuality ? ' ·AUTO' : ''}</b></div>
      <div class="srow"><span>STEPS/RAY</span><b>${stats.maxSteps}</b></div>
      <div class="srow"><span>VIEW</span><b>${state.cinematic ? (this.rig.shotLabel || 'CINEMATIC') : 'FREE ORBIT'}</b></div>
      <div class="srow wide"><span>CAM r/θ/φ</span><b>${sp.radius.toFixed(1)} · ${sp.theta.toFixed(1)}° · ${(((sp.phi % 360) + 360) % 360).toFixed(0)}°</b></div>
      <div class="srow"><span>FOV · ROLL</span><b>${cam.fov.toFixed(1)}° · ${this.rig.roll.toFixed(1)}°</b></div>
      <div class="srow"><span>MODE</span><b>${m.id} ${m.label.split(' ')[0]}</b></div>
    `;
  }

  updateCinematicBar(progress) {
    const bar = document.querySelector('#cineBar span');
    if (bar) bar.style.width = (progress * 100).toFixed(2) + '%';
  }
}
