/**
 * GARGANTUA — heads-up display.
 *
 * Builds the 21 parameter sliders from config, wires every hotkey, and owns the
 * live telemetry readout. It writes nothing to the render pipeline directly: it
 * mutates `state` and emits events, so the HUD can be removed entirely with `H`
 * or `?ui=0` and the renderer keeps working.
 *
 * Two interface features live here:
 *   • language  — every string goes through t(); switching re-renders the HUD
 *                 and calls applyI18n() for the static markup.
 *   • folding   — parameter groups collapse individually or all at once, so a
 *                 user can dial in a look and then give it the whole screen
 *                 without losing the readouts.
 */

import {
  PARAM_DEFS, PARAM_GROUPS, DEBUG_MODES, VIEW_PRESETS,
  QUALITY_TIERS, QUALITY_ORDER, PARAM_COUNT,
} from '../config.js';
import {
  state, setParam, setQuality, setDebug, setCinematic, setMusic,
  setAutoQuality, setLang, setCollapsed, setAllCollapsed, anyExpanded,
  saveState, resetPersisted, on, emit,
} from '../state.js';
import {
  t, isZh, labelOf, hintOf, groupLabel, paramLabel, tierLabel, presetLabel,
  debugLabel, applyI18n, LANGS,
} from '../i18n/index.js';

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
    this.rows = new Map();
    this.groups = new Map();
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
      helpBody: $('#helpBody'),
      paramCount: $$('.param-count'),
      musicBtn: $('#musicBtn'),
      cineBtn: $('#cineBtn'),
      autoBtn: $('#autoBtn'),
      hudBtn: $('#hudBtn'),
      shotBtn: $('#shotBtn'),
      fsBtn: $('#fsBtn'),
      resetBtn: $('#resetBtn'),
      collapseBtn: $('#collapseBtn'),
      langBtn: $('#langBtn'),
      cineBar: $('#cineBar'),
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
      wrap.dataset.group = g.id;

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'pgroup-title';
      head.dataset.group = g.id;
      head.setAttribute('aria-expanded', 'true');
      head.innerHTML = '<span class="chev" aria-hidden="true"></span>'
        + '<span class="gname"></span><span class="gcount"></span>';
      head.addEventListener('click', () => this.toggleGroup(g.id));

      const body = document.createElement('div');
      body.className = 'pgroup-body';

      let n = 0;
      for (const d of PARAM_DEFS.filter((p) => p.group === g.id)) {
        n++;
        const row = document.createElement('div');
        row.className = 'prow';
        row.dataset.key = d.key;

        const label = document.createElement('label');
        label.className = 'plabel';
        label.htmlFor = 'p_' + d.key;

        const val = document.createElement('span');
        val.className = 'pval';
        val.id = 'v_' + d.key;

        const line = document.createElement('div');
        line.className = 'phead';
        line.append(label, val);

        const inp = document.createElement('input');
        inp.type = 'range';
        inp.id = 'p_' + d.key;
        inp.min = String(d.min);
        inp.max = String(d.max);
        inp.step = String(d.step);
        inp.value = String(state.params[d.key]);
        inp.addEventListener('input', () => {
          setParam(d.key, parseFloat(inp.value));
          this._paint(d);
        });
        inp.addEventListener('dblclick', () => {
          setParam(d.key, d.def);
          this.syncParam(d.key);
          this.toast(t('toast.paramReset', { v: paramLabel(d) }));
        });

        row.append(line, inp);
        body.appendChild(row);
        this.rows.set(d.key, { def: d, row, label, val, inp });
      }

      head.querySelector('.gcount').textContent = String(n);
      wrap.append(head, body);
      frag.appendChild(wrap);
      this.groups.set(g.id, { head, body, wrap, def: g });
    }
    this.el.sliders.appendChild(frag);
    this.el.paramCount.forEach((n) => { n.textContent = String(PARAM_COUNT); });
    this._paintGroupTitles();
  }

  _buildDebugDots() {
    const frag = document.createDocumentFragment();
    for (const m of DEBUG_MODES) {
      const b = document.createElement('button');
      b.className = 'dot';
      b.dataset.debug = String(m.id);
      b.textContent = String(m.id);
      b.addEventListener('click', () => setDebug(m.id));
      frag.appendChild(b);
    }
    this.el.debugDots.replaceChildren(frag);
  }

  _bindButtons() {
    this.el.qualityBtns.forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.quality)));
    this.el.presetBtns.forEach((b) => b.addEventListener('click', () => {
      const p = this.rig.setPreset(b.dataset.preset);
      if (p) this.toast(t('toast.view', { v: presetLabel(p.id) }));
    }));
    this.el.cineBtn?.addEventListener('click', () => setCinematic(!state.cinematic));
    this.el.autoBtn?.addEventListener('click', () => setAutoQuality(!state.autoQuality));
    this.el.hudBtn?.addEventListener('click', () => this.setHud(!state.hud));
    this.el.musicBtn?.addEventListener('click', () => this.toggleMusic());
    this.el.shotBtn?.addEventListener('click', () => this.onScreenshot?.());
    this.el.fsBtn?.addEventListener('click', () => this.onFullscreen?.());
    this.el.resetBtn?.addEventListener('click', () => this.onReset?.());
    this.el.collapseBtn?.addEventListener('click', () => this.toggleAllGroups());
    this.el.langBtn?.addEventListener('click', () => this.toggleLang());
    $('#helpClose')?.addEventListener('click', () => this.hideHelp());
    this.el.help?.addEventListener('click', (e) => {
      /* clicking the backdrop closes, clicking the panel does not */
      if (e.target === this.el.help) this.hideHelp();
    });
    $('#helpBtn2')?.addEventListener('click', () => this.toggleHelp());
  }

  /* ------------------------------------------------------------- hotkeys */
  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        if (e.key === 'Escape') el.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const lower = k.toLowerCase();

      if (k >= '0' && k <= '9') {
        const n = parseInt(k, 10);
        setDebug(n);
        this.toast(t('toast.debug', { n, v: debugLabel(n) }));
        e.preventDefault();
        return;
      }

      switch (lower) {
        case 'c': setCinematic(!state.cinematic);
          this.toast(state.cinematic ? t('toast.cineOn') : t('toast.cineOff')); break;
        case 'h': this.setHud(!state.hud); break;
        case 'e': this.toggleAllGroups(); break;
        case 'l': this.toggleLang(); break;
        case 'm': this.toggleMusic(); break;
        case 'f': this.onFullscreen?.(); break;
        case 'p': this.onScreenshot?.(); break;
        case 'r': this.onReset?.(); break;
        case 'q': {
          const i = QUALITY_ORDER.indexOf(state.quality);
          const next = QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length];
          setQuality(next);
          this.toast(t('toast.quality', { v: tierLabel(next) }));
          break;
        }
        case 'a':
          setAutoQuality(!state.autoQuality);
          this.toast(state.autoQuality ? t('toast.autoOn') : t('toast.autoOff'));
          break;
        case 'v': {
          const p = this.rig.cyclePreset(1);
          if (p) this.toast(t('toast.view', { v: presetLabel(p.id) }));
          break;
        }
        case 'n': {
          const p = this.rig.cyclePreset(-1);
          if (p) this.toast(t('toast.view', { v: presetLabel(p.id) }));
          break;
        }
        case 'arrowleft': case 'arrowright': {
          const dir = lower === 'arrowright' ? 1 : -1;
          const i = VIEW_PRESETS.findIndex((v) => v.id === this._presetNear());
          const nxt = VIEW_PRESETS[(i + dir + VIEW_PRESETS.length) % VIEW_PRESETS.length];
          this.rig.setPreset(nxt.id);
          this.toast(t('toast.view', { v: presetLabel(nxt.id) }));
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
      const d = Math.abs(p.fov - this.rig.fovTarget)
        + Math.abs(p.radius - state.camera.radius) * 0.2;
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
    on('lang', () => this.syncLang());
    on('collapsed', () => this.syncCollapsed());
  }

  syncAll() {
    PARAM_DEFS.forEach((d) => this.syncParam(d.key));
    this.syncDebug();
    this.syncQuality();
    this.syncToggles();
    this.syncLang();
    this.syncCollapsed();
    this.setHud(state.hud);
  }

  /* ----------------------------------------------------------- language */
  syncLang() {
    applyI18n();
    for (const [key, r] of this.rows) {
      r.label.textContent = paramLabel(r.def);
      r.inp.setAttribute('aria-label', paramLabel(r.def));
      r.row.title = `${key}  •  ${r.def.min} … ${r.def.max}${isZh() ? '（双击恢复默认）' : ' (double-click to reset)'}`;
      this._paint(r.def);
    }
    this._paintGroupTitles();
    for (const [id, g] of this.groups) {
      const p = VIEW_PRESETS.find((v) => v.id === id);
      void p;
      g.head.title = `${groupLabel(id)} — ${isZh() ? '点击展开/收起' : 'click to fold/unfold'}`;
    }
    this.el.presetBtns.forEach((b) => {
      const p = VIEW_PRESETS.find((x) => x.id === b.dataset.preset);
      if (p) b.textContent = p.key + ' ' + presetLabel(p.id);
    });
    this.el.qualityBtns.forEach((b) => {
      const id = b.dataset.quality;
      b.textContent = t('btn.quality.' + id);
      b.title = isZh() ? QUALITY_TIERS[id].zhHint : QUALITY_TIERS[id].hint;
    });
    this.el.debugDots && $$('.dot', this.el.debugDots).forEach((b) => {
      const m = DEBUG_MODES.find((x) => x.id === Number(b.dataset.debug));
      if (m) b.title = `${m.id} — ${labelOf(m)}（${hintOf(m)}）`;
    });
    $$('.consts [data-const]').forEach((row) => {
      row.querySelector('span').textContent = t('const.' + row.dataset.const);
    });
    if (this.el.langBtn) {
      const other = LANGS.find((l) => l.id !== state.lang);
      this.el.langBtn.textContent = other.label;
      this.el.langBtn.title = isZh() ? 'Switch to English (L)' : '切换到中文界面 (L)';
    }
    this.syncDebug();
    this._buildHelp();
    this.syncCollapsed();
    this.syncToggles();
    /* the telemetry labels changed language, so redraw it now rather than
       waiting for a frame that may never come */
    this._renderStats();
  }

  toggleLang() {
    setLang(state.lang === 'zh' ? 'en' : 'zh');
    this.toast(t('toast.langSwitched'));
  }

  /* ------------------------------------------------------------ folding */
  groupIsCollapsed(id) { return !!state.collapsed[id]; }

  toggleGroup(id) {
    const next = !this.groupIsCollapsed(id);
    setCollapsed(id, next);
    this.toast(t(next ? 'toast.groupCollapsed' : 'toast.groupExpanded',
      { v: groupLabel(id) }), 1200);
  }

  toggleAllGroups() {
    const fold = anyExpanded();       // if anything is open, fold everything
    setAllCollapsed(fold);
    this.toast(t(fold ? 'toast.collapsed' : 'toast.expanded'));
  }

  syncCollapsed() {
    for (const [id, g] of this.groups) {
      const off = this.groupIsCollapsed(id);
      g.wrap.classList.toggle('collapsed', off);
      g.head.setAttribute('aria-expanded', off ? 'false' : 'true');
    }
    const allShut = !anyExpanded();
    if (this.el.collapseBtn) {
      this.el.collapseBtn.textContent = t(allShut ? 'ui.expandAll' : 'ui.collapseAll');
      this.el.collapseBtn.title = t('ui.collapseAllTitle');
    }
    document.body.classList.toggle('all-collapsed', allShut);
  }

  _paintGroupTitles() {
    for (const [id, g] of this.groups) {
      g.head.querySelector('.gname').textContent = groupLabel(id);
    }
  }

  /* ------------------------------------------------------------- painting */
  _fmt(d, v) {
    let s = d.dp > 0 ? v.toFixed(d.dp) : String(Math.round(v));
    if (d.unit === 'deg') s += '°';
    else if (d.unit) s += ' ' + d.unit;
    return s;
  }

  _paint(d) {
    const r = this.rows.get(d.key);
    if (!r) return;
    const v = state.params[d.key];
    r.val.textContent = this._fmt(d, v);
    const pc = (v - d.min) / (d.max - d.min);
    r.row.style.setProperty('--fill', (pc * 100).toFixed(1) + '%');
  }

  syncParam(key) {
    const r = this.rows.get(key);
    if (!r) return;
    if (parseFloat(r.inp.value) !== state.params[key]) r.inp.value = String(state.params[key]);
    this._paint(r.def);
  }

  syncDebug() {
    if (this.el.debugLabel) {
      this.el.debugLabel.textContent = `${state.debug} · ${debugLabel(state.debug)}`;
    }
    $$('.dot', this.el.debugDots).forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.debug) === state.debug);
    });
  }

  syncQuality() {
    this.el.qualityBtns.forEach((b) => b.classList.toggle('on', b.dataset.quality === state.quality));
    const bt = document.getElementById('brandTier');
    if (bt) bt.textContent = tierLabel(state.quality);
  }

  syncToggles() {
    const musicOn = !!(state.music && this.score && this.score.playing);
    this.el.cineBtn?.classList.toggle('on', state.cinematic);
    this.el.autoBtn?.classList.toggle('on', state.autoQuality);
    this.el.musicBtn?.classList.toggle('on', musicOn);
    if (this.el.musicBtn) this.el.musicBtn.textContent = t(musicOn ? 'btn.musicOn' : 'btn.music');
    if (this.el.cineBtn) this.el.cineBtn.textContent = t(state.cinematic ? 'btn.cinemaOn' : 'btn.cinema');
    if (this.el.hudBtn) this.el.hudBtn.textContent = t(state.hud ? 'ui.hide' : 'ui.show');
  }

  setHud(on_) {
    state.hud = !!on_;
    this.el.root?.classList.toggle('hud-hidden', !state.hud);
    if (this.el.hudBtn) this.el.hudBtn.textContent = t(state.hud ? 'ui.hide' : 'ui.show');
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
    if (want && !ok) this.toast(t('toast.audioBlocked'));
    else this.toast(t(state.music ? 'toast.musicOn' : 'toast.musicOff'));
    saveState();
  }

  toggleHelp() {
    const el = this.el.help;
    if (!el) return;
    if (!el.classList.contains('show')) this._buildHelp();
    el.classList.toggle('show');
  }

  hideHelp() { this.el.help?.classList.remove('show'); }

  /** The help overlay is rebuilt per language, from the dictionaries. */
  _buildHelp() {
    const body = this.el.helpBody;
    if (!body) return;
    const dl = (pairs) => '<dl>' + pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
    const debugRows = DEBUG_MODES.map((m) => [String(m.id), labelOf(m) + ' — ' + hintOf(m)]);
    body.innerHTML =
      '<div class="help-col">'
      + `<h3>${t('help.camera')}</h3>`
      + dl([
        ['DRAG', t('help.drag')],
        [isZh() ? '滚轮 / 双指' : 'WHEEL / PINCH', t('help.wheel')],
        ['1 2 3 4', t('help.presets')],
        ['V / N', t('help.cycle')],
        ['← →', t('help.arrows')],
        ['C', t('help.cine')],
      ])
      + `<h3>${t('help.debug')}</h3>`
      + dl(debugRows)
      + '</div>'
      + '<div class="help-col">'
      + `<h3>${t('help.ui')}</h3>`
      + dl([
        ['H', t('help.hud')],
        ['E', t('help.e')],
        ['L', t('help.l')],
        ['Q', t('help.q')],
        ['A', t('help.a')],
        ['M', t('help.m')],
        ['P', t('help.p')],
        ['F', t('help.f')],
        ['R', t('help.r')],
        ['?', t('help.help')],
      ])
      + `<h3>${t('help.auto')}</h3>`
      + `<dl class="mono">`
      + `<dt>?shot=1</dt><dd>${t('help.shot')}</dd>`
      + `<dt>&amp;t=12</dt><dd>${t('help.t')}</dd>`
      + `<dt>&amp;w=3840&amp;h=2160</dt><dd>${t('help.wh')}</dd>`
      + `<dt>&amp;preset=ring</dt><dd>${t('help.preset')}</dd>`
      + `<dt>&amp;ui=0</dt><dd>${t('help.uizero')}</dd>`
      + `<dt>&amp;lang=zh</dt><dd>${isZh() ? '直接用中文界面打开' : 'open directly in Chinese'}</dd>`
      + '</dl>'
      + `<p class="help-note">${t('help.note')}</p>`
      + '</div>';
  }

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
  update(tSec, stats) {
    /* Cache the sample so the panel can be re-rendered with new labels when the
       language changes, without waiting for the next frame — the render loop is
       often idle by then (a still capture, or a paused automation driver). */
    this._stats = stats;
    this._renderStats(tSec);
  }

  _renderStats() {
    const e = this.el.stats;
    const stats = this._stats;
    if (!e || !stats) return;
    const sp = this.rig.getSpherical();
    const tier = QUALITY_TIERS[state.quality];
    const cam = this.rig.camera;
    const view = state.cinematic
      ? (this.rig.shotLabel || (isZh() ? '电影运镜' : 'CINEMATIC'))
      : t('stat.freeOrbit');
    e.innerHTML = `
      <div class="srow"><span>${t('stat.fps')}</span><b>${stats.fps.toFixed(1)} / ${stats.ms.toFixed(1)} ms</b></div>
      <div class="srow"><span>${t('stat.buffer')}</span><b>${stats.bufferW}×${stats.bufferH}</b></div>
      <div class="srow"><span>${t('stat.scale')}</span><b>${(stats.resScale * 100).toFixed(0)}% · ${stats.dpr.toFixed(2)}×</b></div>
      <div class="srow"><span>${t('stat.tier')}</span><b>${tierLabel(state.quality)}${state.autoQuality ? ' ·' + (isZh() ? '自动' : 'AUTO') : ''}</b></div>
      <div class="srow"><span>${t('stat.steps')}</span><b>${stats.maxSteps}</b></div>
      <div class="srow"><span>${t('stat.view')}</span><b>${view}</b></div>
      <div class="srow wide"><span>${t('stat.cam')}</span><b>${sp.radius.toFixed(1)} · ${sp.theta.toFixed(1)}° · ${(((sp.phi % 360) + 360) % 360).toFixed(0)}°</b></div>
      <div class="srow"><span>${t('stat.fov')}</span><b>${cam.fov.toFixed(1)}° · ${this.rig.roll.toFixed(1)}°</b></div>
      <div class="srow"><span>${t('stat.mode')}</span><b>${state.debug} ${debugLabel(state.debug)}</b></div>
    `;
  }

  updateCinematicBar(progress) {
    const bar = this.el.cineBar?.querySelector('span');
    if (bar) bar.style.width = (progress * 100).toFixed(2) + '%';
  }
}
