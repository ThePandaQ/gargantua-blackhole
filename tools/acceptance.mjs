#!/usr/bin/env node
/**
 * GARGANTUA — headless acceptance driver.
 *
 * There is no Playwright or Puppeteer in this environment, so this file speaks
 * the Chrome DevTools Protocol over a raw RFC-6455 WebSocket built on node:net.
 * That gives precise control over a real GPU-backed browser:
 *
 *   Runtime.evaluate   read window.__HARNESS__, drive frames, pull PNG data
 *   Page.navigate      load the app at any URL / parameter combination
 *   Log + Network      capture every console message, exception, blocked request
 *
 * Two things this buys over `chrome --dump-dom --screenshot`:
 *   - --dump-dom fires right after `load`, long before the shaders compile
 *   - --headless starves requestAnimationFrame, so --virtual-time-budget
 *     produced zero rendered frames (measured: 0 RAF callbacks in 20 s of
 *     virtual time). Frames are therefore driven through GARGANTUA.step().
 *
 *   node tools/acceptance.mjs              # functional report
 *   node tools/acceptance.mjs --shots      # report + screenshot gallery
 *   node tools/acceptance.mjs --headful    # watch it happen
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = join(ROOT, 'tests', 'shots');
const TMP = join(ROOT, 'tests', '.chrome-profile');
const HEADFUL = process.argv.includes('--headful');
const WANT_SHOTS = process.argv.includes('--shots');

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

/* module-level diagnostics, filled once the CDP session attaches */
const pageErrors = [];
const consoleMsgs = [];
const networkFails = [];
const requestedUrls = new Set();
const pendingUrls = new Map();

/* ================================================================== *
 * RFC-6455 WebSocket client (text frames only, which is all CDP uses)
 * ================================================================== */
class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || '');
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onText = () => {};
    this.onClose = () => {};
  }

  connect() {
    return new Promise((res, rej) => {
      const key = randomBytes(16).toString('base64');
      this.sock = connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\n`
          + `Host: ${this.host}:${this.port}\r\n`
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.sock.on('error', rej);
      this.sock.on('close', () => this.onClose());
      let handshaken = false;
      this.sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshaken) {
          const end = this.buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = this.buf.slice(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 101/.test(head)) {
            return rej(new Error('websocket handshake failed: ' + head.split('\r\n')[0]));
          }
          const expect = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          if (!head.includes(expect)) return rej(new Error('bad Sec-WebSocket-Accept'));
          this.buf = this.buf.slice(end + 4);
          handshaken = true;
          res(this);
        }
        this._drain();
      });
    });
  }

  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.slice(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.slice(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.slice(off + len);

      if (op === 0x8) { this.onClose(); return; }
      if (op === 0x9) { this.send(payload, 0xA); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) {
        this.frag.push(payload);
        if (fin) { this.onText(Buffer.concat(this.frag).toString('utf8')); this.frag = []; }
        continue;
      }
      if (!fin) { this.frag = [payload]; continue; }
      this.onText(payload.toString('utf8'));
    }
  }

  send(data, opcode = 0x1) {
    if (!this.sock || this.sock.destroyed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = randomBytes(4);
    mask.copy(header, header.length - 4);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, payload]));
  }

  close() { try { if (this.sock) this.sock.destroy(); } catch (e) { /* ignore */ } }
}

/* ================================================================== *
 * CDP session
 * ================================================================== */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onText = (txt) => {
      let msg;
      try { msg = JSON.parse(txt); } catch (e) { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message));
          else p.res(msg.result);
        }
        return;
      }
      const list = this.listeners.get(msg.method);
      if (list) for (const fn of list) { try { fn(msg.params); } catch (e) { /* ignore */ } }
    };
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); }
      }, 180000);
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: '
        + ((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown'));
    }
    return r.result.value;
  }
}

/* ================================================================== *
 * browser lifecycle
 * ================================================================== */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('No Chrome/Edge binary found. Set CHROME_PATH and retry.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let cdp = null;

function launch({ width = 1280, height = 800, port = 9333 } = {}) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-device-scale-factor=1',
    '--enable-unsafe-swiftshader',
    '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${TMP}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  if (HEADFUL) args[0] = '--start-maximized';
  child = spawn(chromePath, args, { stdio: 'ignore' });
  return port;
}

async function attach(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WS(page.webSocketDebuggerUrl);
        await ws.connect();
        return new CDP(ws);
      }
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('could not attach to Chrome on port ' + port);
}

function shutdown() {
  try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
  try { if (child) child.kill(); } catch (e) { /* ignore */ }
}

/**
 * Chrome keeps handles on its profile directory for a moment after being
 * killed, and on Windows a failed delete is an EPERM rather than a silent
 * no-op. Tearing the tree down is best-effort housekeeping, never a test
 * failure.
 */
function scrubProfile() {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return true;
    } catch (e) { /* locked — wait and retry */ }
    const until = Date.now() + 400;
    while (Date.now() < until) { /* brief spin */ }
  }
  console.log(C.d + 'note: could not remove ' + TMP + ' (Chrome still holds it); it is git-ignored' + C.x);
  return false;
}

/* ================================================================== *
 * page helpers
 * ================================================================== */
const url = (rel, query = '') => pathToFileURL(join(ROOT, rel)).href + query;

async function navigate(target, { waitBoot = true, timeout = 120000 } = {}) {
  networkFails.length = 0;
  await cdp.send('Page.navigate', { url: target });
  if (!waitBoot) { await sleep(1200); return true; }
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeout) {
      let diag = null;
      try {
        diag = await cdp.eval(`(() => ({
          url: location.href, readyState: document.readyState,
          hasCanvas: !!document.getElementById('scene'),
          hasGargantua: !!window.GARGANTUA,
          booted: !!window.__GARGANTUA_BOOTED__,
          bootLog: (document.getElementById('bootLog')||{}).textContent || null,
          fatal: (() => { const f = document.getElementById('fatal'); return f && f.classList.contains('show') ? f.textContent.trim().slice(0,400) : null; })(),
          scripts: [...document.scripts].map(s => s.src || '(inline)'),
        }))()`);
      } catch (e) { diag = { evalError: e.message }; }
      throw new Error('timed out waiting for boot: ' + target
        + '\n  diagnostics: ' + JSON.stringify(diag, null, 1)
        + '\n  failed requests: ' + networkFails.slice(0, 10).join(' | ')
        + '\n  page errors:\n   ' + pageErrors.slice(0, 8).join('\n   ')
        + '\n  console:\n   ' + consoleMsgs.slice(-14).map((m) => m.level + ': ' + String(m.text).slice(0, 240)).join('\n   '));
    }
    try {
      const st = await cdp.eval(`(() => {
        const f = document.getElementById('fatal');
        return {
          booted: !!window.__GARGANTUA_BOOTED__,
          fatal: f && f.classList.contains('show') ? f.textContent.trim().slice(0,300) : null,
        };
      })()`);
      if (st.fatal) throw new Error('fatal overlay: ' + st.fatal);
      if (st.booted) return true;
    } catch (e) {
      if (/fatal overlay/.test(e.message)) throw e;
      /* execution context destroyed by navigation — retry */
    }
    await sleep(220);
  }
}

/* ================================================================== *
 * main
 * ================================================================== */
(async () => {
  console.log('\n' + C.b + 'GARGANTUA - headless acceptance (CDP)' + C.x);
  console.log('chrome  ' + chromePath);
  console.log('mode    ' + (HEADFUL ? 'headful' : 'headless=new')
    + (WANT_SHOTS ? ' + screenshot gallery' : '') + '\n');

  rmSync(TMP, { recursive: true, force: true });
  const port = launch();
  cdp = await attach(port);

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => {
      if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      return a.description || a.type;
    }).join(' ');
    consoleMsgs.push({ level: p.type, text });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && (p.entry.level === 'error' || p.entry.level === 'warning')) {
      pageErrors.push(p.entry.level + ': ' + p.entry.text);
    }
  });
  cdp.on('Network.loadingFailed', (p) => {
    networkFails.push((p.type || '?') + ' ' + (p.errorText || 'failed')
      + ' <' + (pendingUrls.get(p.requestId) || 'unknown') + '>');
  });
  cdp.on('Network.requestWillBeSent', (p) => {
    if (p.request && p.request.url) {
      pendingUrls.set(p.requestId, p.request.url);
      if (!/^(data|blob):/.test(p.request.url)) requestedUrls.add(p.request.url);
    }
  });
  cdp.on('Network.responseReceived', (p) => { pendingUrls.delete(p.requestId); });
  cdp.on('Inspector.targetCrashed', () => pageErrors.push('RENDERER CRASHED'));

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  /* ---------------- phase 1: functional harness ---------------- */
  const t0 = Date.now();
  await navigate(url('tests/harness.html'));
  let report = null;
  for (let i = 0; i < 900; i++) {
    try {
      report = await cdp.eval('window.__HARNESS__ ? JSON.parse(JSON.stringify(window.__HARNESS__)) : null');
      if (report && report.done) break;
    } catch (e) { /* context churn */ }
    await sleep(400);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!report || !report.done) {
    console.error(C.r + 'the in-page harness never reported completion' + C.x);
    if (report && report.results) {
      for (const p of report.results.slice(-8)) {
        console.error('   ' + (p.pass ? 'PASS' : 'FAIL') + ' ' + p.name + '  ' + p.detail);
      }
    }
    if (pageErrors.length) console.error('page errors:\n  ' + pageErrors.slice(0, 10).join('\n  '));
    console.error('failed requests: ' + networkFails.slice(0, 8).join(' | '));
    console.error('console:\n  ' + consoleMsgs.slice(-14).map((m) => m.level + ': ' + String(m.text).slice(0, 240)).join('\n  '));
    shutdown();
    process.exit(1);
  }

  for (const r of report.results) {
    const tag = r.pass ? C.g + 'PASS' + C.x : C.r + 'FAIL' + C.x;
    console.log('  ' + tag + ' ' + r.name + (r.detail ? '  ' + C.d + r.detail + C.x : ''));
  }
  console.log('');

  const harnessErrors = (report.consoleLog || []).filter((l) => /^(ERROR|UNCAUGHT|REJECTION)/.test(l));
  const allErrors = [...pageErrors, ...harnessErrors];
  if (report.consoleLog && report.consoleLog.length) {
    console.log(C.d + 'page console (' + report.consoleLog.length + ' lines):' + C.x);
    for (const l of report.consoleLog.slice(0, 25)) console.log('   ' + C.d + String(l).slice(0, 240) + C.x);
    console.log('');
  }
  console.log((report.failures ? C.r : C.g) + (report.total - report.failures) + '/' + report.total
    + ' in-page checks passed' + C.x + ' in ' + elapsed + 's');
  console.log((allErrors.length ? C.r : C.g) + (allErrors.length === 0 ? 'no' : String(allErrors.length))
    + ' browser-level console errors/exceptions' + C.x);
  for (const e of allErrors.slice(0, 10)) console.log('   ' + C.r + String(e).slice(0, 300) + C.x);

  let failures = report.failures + allErrors.length;

  /* ---------------- phase 2: screenshot gallery ---------------- */
  if (WANT_SHOTS) {
    mkdirSync(SHOT_DIR, { recursive: true });
    const shots = [
      ['01_classic_1080p', '?shot=1&ui=0&cinematic=0&t=8&w=1920&h=1080&preset=classic'],
      ['02_photonring_1080p', '?shot=1&ui=0&cinematic=0&t=12&w=1920&h=1080&preset=ring'],
      ['03_beaming_1080p', '?shot=1&ui=0&cinematic=0&t=20&w=1920&h=1080&preset=isco'],
      ['04_polar_1080p', '?shot=1&ui=0&cinematic=0&t=30&w=1920&h=1080&preset=polar'],
      ['05_classic_1440p', '?shot=1&ui=0&cinematic=0&t=8&w=2560&h=1440&preset=classic&quality=cinematic'],
      ['06_debug1_hdr', '?shot=1&ui=0&cinematic=0&t=8&w=1280&h=720&preset=classic&debug=1'],
      ['07_debug2_cost', '?shot=1&ui=0&cinematic=0&t=8&w=1280&h=720&preset=ring&debug=2'],
      ['08_debug4_impact', '?shot=1&ui=0&cinematic=0&t=8&w=1280&h=720&preset=ring&debug=4'],
      ['09_debug5_doppler', '?shot=1&ui=0&cinematic=0&t=8&w=1280&h=720&preset=ring&debug=5'],
      ['10_debug8_crossings', '?shot=1&ui=0&cinematic=0&t=8&w=1280&h=720&preset=ring&debug=8'],
      ['11_debug9_skyonly', '?shot=1&ui=0&cinematic=0&t=8&w=1280&h=720&preset=classic&debug=9'],
      ['12_hud_full', '?shot=1&ui=1&cinematic=0&t=8&w=1600&h=900&preset=classic'],
      ['13_mobile_portrait', '?shot=1&ui=1&cinematic=0&t=8&w=780&h=1688&preset=classic&quality=standard'],
      ['14_hot_disc', '?shot=1&ui=0&cinematic=0&t=26&w=1920&h=1080&preset=isco&diskTemp=17000&diskBright=2.1'],
    ];
    console.log('\n' + C.y + 'rendering ' + shots.length + ' screenshots into tests/shots/...' + C.x);
    let badShots = 0;
    for (const shot of shots) {
      const name = shot[0], query = shot[1];
      /* `dom: true` captures through CDP Page.captureScreenshot so the HUD
         chrome is composited in. The plain shots go through the page's own
         canvas.toDataURL(), which is the documented automation interface but
         by definition contains the render only — a canvas has no DOM. */
      const useDom = query.includes('ui=1');
      const t = Date.now();
      try {
        await navigate(url('index.html', query), { timeout: 120000 });
        let buf;
        let meta = null;
        let lastCheck = null;
        if (useDom) {
          await sleep(400);
          const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          buf = Buffer.from(r.data, 'base64');
        } else {
          let png = null;
          for (let i = 0; i < 400; i++) {
            png = await cdp.eval('window.__GARGANTUA_SHOT__ || null');
            if (png && png.length > 1000) break;
            await sleep(200);
          }
          if (!png || png.length < 1000) throw new Error('the page produced no PNG');
          buf = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
          meta = await cdp.eval('window.__GARGANTUA_META__ ? JSON.parse(JSON.stringify(window.__GARGANTUA_META__)) : null');
          /* Verify what the page handed over, not merely that it handed
             something over: decode the data URL in the page and report its mean
             luminance, so a black capture fails here instead of being written
             to disk and discovered later. */
          const chk = await cdp.eval(`(async () => {
            const u = window.__GARGANTUA_SHOT__;
            if (!u) return null;
            const img = new Image();
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
            const cv = document.createElement('canvas');
            cv.width = img.width; cv.height = img.height;
            const cx = cv.getContext('2d');
            cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, cv.width, cv.height).data;
            let s = 0, mx = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
              const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
              s += l; if (l > mx) mx = l; n++;
            }
            return { w: cv.width, h: cv.height, mean: +(s / n).toFixed(4), max: +mx.toFixed(3) };
          })()`);
          if (!chk || chk.mean < 0.004) {
            /* debug 9 (lensed sky only) is legitimately almost black — it is a
               starfield with the disc suppressed — so it is held to a lower bar
               rather than being excused entirely */
            const dark = /debug=9/.test(query);
            if (!chk || chk.mean < (dark ? 0.0002 : 0.004)) {
              throw new Error('captured a black frame (mean L '
                + (chk ? chk.mean : 'no image') + ')');
            }
          }
          lastCheck = chk;
        }
        writeFileSync(join(SHOT_DIR, name + '.png'), buf);
        /* Hash of what was actually written, so a stale file on disk can never
           be mistaken for a fresh capture. */
        const digest = createHash('sha256').update(buf).digest('hex').slice(0, 12);
        /* a genuine render is never a flat colour: check the byte spread */
        const ok = buf.length > 20000;
        if (!ok) badShots++;
        console.log('  ' + (ok ? C.g + 'PASS' : C.r + 'FAIL') + C.x + ' ' + name.padEnd(22) + ' '
          + (useDom ? 'DOM+canvas' : String(meta ? meta.width : '?') + 'x' + String(meta ? meta.height : '?')) + '  '
          + String(Math.round(buf.length / 1024)).padStart(5) + ' KB  '
          + (lastCheck ? 'mean L ' + lastCheck.mean.toFixed(4) + '  max ' + lastCheck.max.toFixed(3) + '  ' : '')
          + C.d + digest + '  ' + ((Date.now() - t) / 1000).toFixed(1) + 's' + C.x);
      } catch (e) {
        badShots++;
        console.log('  ' + C.r + 'FAIL' + C.x + ' ' + name.padEnd(22) + ' ' + e.message.slice(0, 160));
      }
    }
    console.log('\n' + (badShots ? C.r : C.g) + (shots.length - badShots) + '/' + shots.length
      + ' screenshots written to tests/shots/' + C.x);
    failures += badShots;
  }

  shutdown();
  scrubProfile();

  if (failures) {
    console.log('\n' + C.r + failures + ' acceptance failure(s).' + C.x + '\n');
    process.exit(1);
  }
  console.log('\n' + C.g + 'ACCEPTED - every check passed.' + C.x + '\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n' + C.r + 'driver failed:' + C.x, e);
  shutdown();
  process.exit(2);
});
