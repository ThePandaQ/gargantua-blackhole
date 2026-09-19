/**
 * GARGANTUA — interface languages.
 *
 * Two languages, English and Simplified Chinese. The design constraint that
 * shaped this file: the parameter table, the presets, the debug modes and the
 * cinematic shots already live in config.js, so their Chinese labels live there
 * too (`zh`, `zhHint`) rather than being duplicated in a parallel table that
 * could drift out of step. What remains here is the interface chrome — headings,
 * buttons, telemetry rows, toasts and the help overlay.
 *
 * Everything user-visible goes through `t()`. `applyI18n()` then walks the DOM
 * for `data-i18n` / `data-i18n-*` attributes, so markup stays declarative and a
 * new string cannot be silently left untranslated: the validator counts them.
 */

import { PARAM_DEFS, PARAM_GROUPS, DEBUG_MODES, VIEW_PRESETS, QUALITY_TIERS } from '../config.js';
import { state } from '../state.js';

export const LANGS = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'zh', label: '中文', name: '简体中文' },
];

const DICT = {
  en: {
    /* ---- panel headings ---- */
    'panel.params': 'PARAMETERS',
    'panel.reset': 'RESET',
    'panel.telemetry': 'TELEMETRY',
    'panel.live': 'LIVE',
    'panel.view': 'VIEW',
    'panel.render': 'RENDER',
    'panel.debug': 'DEBUG VIEW',

    /* ---- header / buttons ---- */
    'brand.sub': 'SCHWARZSCHILD RAYTRACER',
    'ui.hide': 'HIDE UI',
    'ui.hideTitle': 'Hide the interface (H)',
    'ui.show': 'SHOW UI',
    'ui.langTitle': 'Switch to Chinese (L)',
    'ui.collapseAll': 'COLLAPSE ALL',
    'ui.expandAll': 'EXPAND ALL',
    'ui.collapseAllTitle': 'Collapse every parameter group so the render fills the view (E)',
    'ui.resetTitle': 'Reset every parameter to defaults (R)',

    /* ---- panel footer hints ---- */
    'foot.collapse': 'fold all',
    'foot.hide': 'hide interface',

    'btn.quality.standard': 'STD',
    'btn.quality.high': 'HIGH',
    'btn.quality.cinematic': 'CINE',
    'btn.auto': 'AUTO',
    'btn.cinema': 'CINEMA',
    'btn.cinemaOn': '◉ LOOP',
    'btn.music': 'MUSIC',
    'btn.musicOn': '♪ ON',
    'btn.png': 'PNG',
    'btn.full': 'FULL',
    'btn.keys': 'KEYS',

    'view.title.ring': 'Edge-on — photon ring and higher-order images (1)',
    'view.title.classic': 'The Interstellar framing (2)',
    'view.title.isco': 'Close approach, extreme beaming (3)',
    'view.title.polar': 'Near face-on, full disc (4)',

    'render.title.standard': 'Low-power tier (Q cycles)',
    'render.title.high': 'Default tier',
    'render.title.cinematic': 'Maximum fidelity tier',
    'render.title.auto': 'Automatic tier switching (A)',
    'render.title.cinema': 'Cinematic camera loop (C)',
    'render.title.music': 'Ambient score (M)',
    'render.title.png': 'Download a PNG of the current camera (P)',
    'render.title.full': 'Fullscreen (F)',
    'render.title.keys': 'Keyboard reference (?)',

    'const.horizon': 'HORIZON',
    'const.photon': 'PHOTON SPHERE',
    'const.shadow': 'SHADOW',
    'const.isco': 'ISCO',

    /* ---- telemetry rows ---- */
    'stat.fps': 'FPS',
    'stat.buffer': 'BUFFER',
    'stat.scale': 'SCALE · DPR',
    'stat.tier': 'TIER',
    'stat.steps': 'STEPS/RAY',
    'stat.view': 'VIEW',
    'stat.cam': 'CAM r/θ/φ',
    'stat.fov': 'FOV · ROLL',
    'stat.mode': 'MODE',
    'stat.freeOrbit': 'FREE ORBIT',

    /* ---- cinematic progress ---- */
    'cine.title': 'Cinematic loop position',

    /* ---- toasts ---- */
    'toast.reset': 'ALL PARAMETERS RESET',
    'toast.quality': 'QUALITY — {v}',
    'toast.autoOn': 'AUTO QUALITY — ON',
    'toast.autoOff': 'AUTO QUALITY — OFF',
    'toast.cineOn': 'CINEMATIC CAMERA — ON',
    'toast.cineOff': 'CINEMATIC CAMERA — OFF',
    'toast.musicOn': 'AMBIENT SCORE — ON',
    'toast.musicOff': 'AMBIENT SCORE — OFF',
    'toast.audioBlocked': 'AUDIO BLOCKED — click the page first',
    'toast.debug': 'DEBUG {n} — {v}',
    'toast.view': 'VIEW — {v}',
    'toast.paramReset': '{v} reset',
    'toast.pngSaved': 'PNG SAVED',
    'toast.pngFailed': 'PNG FAILED — see console',
    'toast.fsBlocked': 'FULLSCREEN BLOCKED',
    'toast.shotReady': 'SHOT READY — window.__GARGANTUA_SHOT__',
    'toast.ctxRestored': 'GPU CONTEXT RESTORED',
    'toast.langSwitched': 'LANGUAGE — 简体中文',
    'toast.collapsed': 'ALL GROUPS COLLAPSED — press E to restore',
    'toast.expanded': 'ALL GROUPS EXPANDED',
    'toast.groupCollapsed': '{v} collapsed',
    'toast.groupExpanded': '{v} expanded',

    /* ---- boot sequence ---- *
     * Only the phases that main.js can reach are here. `loading`, `shaders`,
     * `halted`, the whole `file.*` family and the whole `stall.*` family are
     * deliberately NOT in this dictionary: they belong to the inline boot guard
     * in index.html, which must keep working when the modules are exactly what
     * failed and therefore cannot import this file. That guard carries its own
     * two-language copy, and tools/i18n-audit.mjs knows about the duplication. */
    'boot.done': 'ready',
    'boot.captured': 'frame captured',
    'boot.probe': 'probing WebGL2…',
    'boot.compile': 'compiling geodesic integrator…',
    'boot.build': 'building camera and interface…',

    /* ---- overlays ---- *
     * The `stall.*` family lives only in the boot guard (see the note above);
     * by the time main.js runs it has already cancelled that timer. What is
     * left here is everything the module itself can put on screen. */

    'fatal.webgl2.title': 'WEBGL2 UNAVAILABLE',
    'fatal.webgl2.body': 'GARGANTUA integrates null geodesics in a WebGL2 fragment shader. '
      + 'This browser or GPU driver reports no WebGL2 context. Try a recent Chrome, Edge, '
      + 'Firefox or Safari 15+, and make sure hardware acceleration is enabled.',
    'fatal.ctx.title': 'CONTEXT CREATION FAILED',
    'fatal.shader.title': 'SHADER COMPILATION FAILED',
    'fatal.startup.title': 'STARTUP FAILED',
    'fatal.js.title': 'JAVASCRIPT REQUIRED',
    'fatal.js.body': 'GARGANTUA integrates null geodesics in a fragment shader and therefore '
      + 'needs JavaScript and WebGL2.',

    'lost.title': 'GPU CONTEXT LOST',
    'lost.body': 'The WebGL context was released by the driver (this happens on GPU reset, '
      + 'driver update, laptop dGPU hand-off and after long tab suspension). GARGANTUA keeps '
      + 'its entire state and rebuilds every GPU resource the moment the browser restores it.',
    'lost.btn': 'RESTORE NOW',
    'lost.waiting': 'Waiting for the driver to restore the context…',
    'lost.failed': 'Recovery failed',

    /* ---- help overlay ---- */
    'help.title': 'KEYBOARD & POINTER',
    'help.close': 'CLOSE',
    'help.camera': 'CAMERA',
    'help.debug': 'DEBUG VIEWS',
    'help.ui': 'INTERFACE',
    'help.auto': 'SCREENSHOT AUTOMATION',
    'help.drag': 'Orbit (left / one finger)',
    'help.wheel': 'Dolly in & out',
    'help.presets': 'Photon ring / Cinematic / Beaming / Polar',
    'help.cycle': 'Next / previous view preset',
    'help.arrows': 'Cycle view presets',
    'help.cine': 'Cinematic camera loop (84 s)',
    'help.hud': 'Hide / show the whole HUD',
    'help.q': 'Cycle quality tier',
    'help.a': 'Toggle automatic quality',
    'help.m': 'Ambient score',
    'help.p': 'Download PNG',
    'help.f': 'Fullscreen',
    'help.r': 'Reset all parameters',
    'help.e': 'Collapse / expand all parameter groups',
    'help.l': 'Switch interface language',
    'help.help': 'This panel',
    'help.shot': 'render one frame, expose it, stop',
    'help.t': 'freeze the sim clock at 12 s',
    'help.wh': 'force the output buffer',
    'help.preset': 'jump to a named view',
    'help.uizero': 'hide the HUD before capture',
    'help.note': 'When the frame is ready the page sets <code>window.__GARGANTUA_READY__ = true</code>, '
      + 'dispatches a <code>gargantua:shot</code> event and puts a PNG data URL in '
      + '<code>window.__GARGANTUA_SHOT__</code>.',
  },

  zh: {
    'panel.params': '参数',
    'panel.reset': '重置',
    'panel.telemetry': '遥测',
    'panel.live': '实时',
    'panel.view': '视角',
    'panel.render': '渲染',
    'panel.debug': '调试视图',

    'brand.sub': '史瓦西黑洞光线追踪',
    'ui.hide': '隐藏界面',
    'ui.hideTitle': '隐藏界面（H）',
    'ui.show': '显示界面',
    'ui.langTitle': 'Switch to English (L)',
    'ui.collapseAll': '全部收起',
    'ui.expandAll': '全部展开',
    'ui.collapseAllTitle': '收起所有参数分组，让画面铺满视野（E）',
    'ui.resetTitle': '把所有参数恢复为默认值（R）',

    'foot.collapse': '收起全部分组',
    'foot.hide': '隐藏界面',

    'btn.quality.standard': '标准',
    'btn.quality.high': '高',
    'btn.quality.cinematic': '电影级',
    'btn.auto': '自动',
    'btn.cinema': '运镜',
    'btn.cinemaOn': '◉ 循环',
    'btn.music': '音乐',
    'btn.musicOn': '♪ 开',
    'btn.png': '截图',
    'btn.full': '全屏',
    'btn.keys': '快捷键',

    'view.title.ring': '侧视 —— 光子环与高阶像（1）',
    'view.title.classic': '《星际穿越》构图（2）',
    'view.title.isco': '近距离，极强多普勒增亮（3）',
    'view.title.polar': '接近正面俯视，完整盘面（4）',

    'render.title.standard': '低功耗档（Q 循环切换）',
    'render.title.high': '默认档',
    'render.title.cinematic': '最高画质档',
    'render.title.auto': '自动切换画质档（A）',
    'render.title.cinema': '电影运镜循环（C）',
    'render.title.music': '环境音乐（M）',
    'render.title.png': '下载当前视角的 PNG（P）',
    'render.title.full': '全屏（F）',
    'render.title.keys': '快捷键说明（?）',

    'const.horizon': '事件视界',
    'const.photon': '光子球',
    'const.shadow': '阴影半径',
    'const.isco': '最内稳定轨道',

    'stat.fps': '帧率',
    'stat.buffer': '缓冲区',
    'stat.scale': '缩放 · DPR',
    'stat.tier': '画质档',
    'stat.steps': '步数/光线',
    'stat.view': '视角',
    'stat.cam': '相机 r/θ/φ',
    'stat.fov': '视场 · 滚转',
    'stat.mode': '模式',
    'stat.freeOrbit': '自由视角',

    'cine.title': '运镜循环进度',

    'toast.reset': '所有参数已重置',
    'toast.quality': '画质 —— {v}',
    'toast.autoOn': '自动画质 —— 开',
    'toast.autoOff': '自动画质 —— 关',
    'toast.cineOn': '电影运镜 —— 开',
    'toast.cineOff': '电影运镜 —— 关',
    'toast.musicOn': '环境音乐 —— 开',
    'toast.musicOff': '环境音乐 —— 关',
    'toast.audioBlocked': '音频被浏览器拦截 —— 请先点击页面',
    'toast.debug': '调试 {n} —— {v}',
    'toast.view': '视角 —— {v}',
    'toast.paramReset': '{v} 已重置',
    'toast.pngSaved': 'PNG 已保存',
    'toast.pngFailed': 'PNG 保存失败 —— 见控制台',
    'toast.fsBlocked': '全屏被浏览器拦截',
    'toast.shotReady': '截图就绪 —— window.__GARGANTUA_SHOT__',
    'toast.ctxRestored': 'GPU 上下文已恢复',
    'toast.langSwitched': '界面语言 —— English',
    'toast.collapsed': '全部参数已收起 —— 按 E 恢复',
    'toast.expanded': '全部参数已展开',
    'toast.groupCollapsed': '{v} 已收起',
    'toast.groupExpanded': '{v} 已展开',

    /* Only the phases main.js can reach; see the note in the English table. */
    'boot.done': '就绪',
    'boot.captured': '画面已捕获',
    'boot.probe': '正在检测 WebGL2…',
    'boot.compile': '正在编译测地线积分器…',
    'boot.build': '正在构建相机与界面…',

    'fatal.webgl2.title': '无法使用 WEBGL2',
    'fatal.webgl2.body': 'GARGANTUA 需要在 WebGL2 片元着色器中积分零测地线，而当前浏览器或驱动'
      + '没有提供 WebGL2 上下文。请使用较新的 Chrome / Edge / Firefox / Safari 15+，并确认已开启硬件加速。',
    'fatal.ctx.title': '上下文创建失败',
    'fatal.shader.title': '着色器编译失败',
    'fatal.startup.title': '启动失败',
    'fatal.js.title': '需要启用 JAVASCRIPT',
    'fatal.js.body': 'GARGANTUA 在片元着色器中积分零测地线，因此需要 JavaScript 与 WebGL2。',

    'lost.title': 'GPU 上下文丢失',
    'lost.body': '显卡驱动回收了 WebGL 上下文（常见于驱动重置、驱动更新、笔记本独显切换，'
      + '或标签页长时间挂起）。GARGANTUA 会保留全部状态，并在浏览器恢复上下文的瞬间重建所有 GPU 资源。',
    'lost.btn': '立即恢复',
    'lost.waiting': '正在等待驱动恢复上下文…',
    'lost.failed': '恢复失败',

    'help.title': '键盘与鼠标',
    'help.close': '关闭',
    'help.camera': '相机',
    'help.debug': '调试视图',
    'help.ui': '界面',
    'help.auto': '截图自动化',
    'help.drag': '环绕（左键 / 单指拖动）',
    'help.wheel': '推拉镜头',
    'help.presets': '光子环 / 电影感 / 相对论喷流 / 极轴俯视',
    'help.cycle': '下一个 / 上一个视角预设',
    'help.arrows': '循环切换视角预设',
    'help.cine': '电影运镜循环（84 秒）',
    'help.hud': '隐藏 / 显示整个界面',
    'help.q': '循环切换画质档',
    'help.a': '开关自动画质',
    'help.m': '环境音乐',
    'help.p': '下载 PNG',
    'help.f': '全屏',
    'help.r': '重置所有参数',
    'help.e': '收起 / 展开所有参数分组',
    'help.l': '切换界面语言',
    'help.help': '本面板',
    'help.shot': '渲染一帧、导出、停止',
    'help.t': '把模拟时钟冻结在 12 秒',
    'help.wh': '强制指定输出分辨率',
    'help.preset': '跳转到指定视角',
    'help.uizero': '截图前隐藏界面',
    'help.note': '画面就绪后，页面会设置 <code>window.__GARGANTUA_READY__ = true</code>，'
      + '派发 <code>gargantua:shot</code> 事件，并把 PNG data URL 写入 '
      + '<code>window.__GARGANTUA_SHOT__</code>。',
  },
};

/**
 * Translate a key, with `{name}` interpolation.
 * Falls back to English, then to the key itself, so a missing string is visible
 * rather than blank.
 */
export function t(key, vars) {
  const lang = state.lang === 'zh' ? 'zh' : 'en';
  let s = DICT[lang][key];
  if (s === undefined) s = DICT.en[key];
  if (s === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

export const isZh = () => state.lang === 'zh';

/** The right field from a config entry that carries both languages. */
export function labelOf(entry) {
  if (!entry) return '';
  return isZh() && entry.zh ? entry.zh : entry.label;
}

export function hintOf(entry) {
  if (!entry) return '';
  return isZh() && entry.zhHint ? entry.zhHint : (entry.hint || '');
}

/** Group headings, keyed by group id. */
export function groupLabel(id) {
  const g = PARAM_GROUPS.find((x) => x.id === id);
  return g ? labelOf(g) : id;
}

export function paramLabel(def) { return labelOf(def); }
export function tierLabel(id) { return labelOf(QUALITY_TIERS[id]); }
export function presetLabel(id) {
  const p = VIEW_PRESETS.find((x) => x.id === id);
  return p ? labelOf(p) : id;
}
export function debugLabel(id) {
  const m = DEBUG_MODES.find((x) => x.id === id);
  return m ? labelOf(m) : String(id);
}

/**
 * Apply the current language to the static DOM.
 *
 * `data-i18n="key"`          replaces textContent
 * `data-i18n-title="key"`    replaces the title attribute
 * `data-i18n-html="key"`     replaces innerHTML (for strings carrying markup)
 * `data-i18n-aria="key"`     replaces aria-label
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  document.documentElement.lang = isZh() ? 'zh-CN' : 'en';
  document.documentElement.dataset.lang = isZh() ? 'zh' : 'en';
  /* the document title is part of the interface too */
  document.title = isZh()
    ? 'GARGANTUA —— 史瓦西黑洞实时光线追踪'
    : 'GARGANTUA — Schwarzschild Black Hole Raytracer';
}

/** Every key that exists in English but not in Chinese, for the validator. */
export function missingTranslations() {
  const out = [];
  for (const k of Object.keys(DICT.en)) if (DICT.zh[k] === undefined) out.push(k);
  for (const d of PARAM_DEFS) if (!d.zh) out.push('param:' + d.key);
  for (const g of PARAM_GROUPS) if (!g.zh) out.push('group:' + g.id);
  for (const p of VIEW_PRESETS) if (!p.zh) out.push('preset:' + p.id);
  for (const m of DEBUG_MODES) if (!m.zh) out.push('debug:' + m.id);
  return out;
}

export const DICTIONARIES = DICT;
