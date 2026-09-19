#!/usr/bin/env node
/**
 * Load the app at a URL and print live state from the page.
 *
 *   node tools/probe.mjs "?cam=13.5,80,300,48"
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'tests', '.chrome-probe');
/* Accept either a query string ("?lang=zh") or a full URL, so the same tool can
   inspect the local server and the deployed site. */
const arg = process.argv[2] || '';
const URL_ARG = /^https?:\/\//i.test(arg);
const query = URL_ARG ? '' : arg;

class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || '');
    this.buf = Buffer.alloc(0); this.frags = [];
    this.onText = () => {};
  }
  connect() {
    return new Promise((res, rej) => {
      const key = randomBytes(16).toString('base64');
      this.sock = connect(this.port, this.host, () => {
        this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n`
          + `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n`
          + 'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      this.sock.on('error', rej);
      let done = false;
      this.sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!done) {
          const e = this.buf.indexOf('\r\n\r\n');
          if (e < 0) return;
          const head = this.buf.slice(0, e).toString('latin1');
          if (!/101/.test(head)) return rej(new Error(head.split('\r\n')[0]));
          const want = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          if (!head.includes(want)) return rej(new Error('bad accept'));
          this.buf = this.buf.slice(e + 4); done = true; res(this);
        }
        this.drain();
      });
    });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.slice(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      const p = Buffer.from(this.buf.slice(off, off + len));
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      this.buf = this.buf.slice(off + len);
      if (op === 0x9) { this.send(p, 0xA); continue; }
      if (op === 0xA) continue;
      if (!fin) { this.frags.push(p); continue; }
      this.onText(Buffer.concat(this.frags.length ? [...this.frags, p] : [p]).toString('utf8'));
      this.frags = [];
    }
  }
  send(data, op = 0x1) {
    if (!this.sock || this.sock.destroyed) return;
    const p = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const n = p.length; let h;
    if (n < 126) { h = Buffer.alloc(6); h[1] = 0x80 | n; }
    else if (n < 65536) { h = Buffer.alloc(8); h[1] = 0x80 | 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(14); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); }
    h[0] = 0x80 | op;
    const m = randomBytes(4); m.copy(h, h.length - 4);
    for (let i = 0; i < n; i++) p[i] ^= m[i & 3];
    this.sock.write(Buffer.concat([h, p]));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = [process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find((p) => existsSync(p));
const PORT = 9381;

const EXPR = [
  '(async () => {',
  '  const G = window.GARGANTUA;',
  '  if (!G) return { app: false };',
  '  const c = G.rig.camera;',
  '  const r = c.position.length();',
  '  const hdr = G.readSceneHDR();',
  '  const aov = (() => { G.setDebug(8); const p = G.probe(96); G.setDebug(0); return p; })();',
  '  let crossingHist = null;',
  '  if (aov) {',
  '    const h = new Array(9).fill(0);',
  '    for (let i = 0; i < aov.f32.length; i += 4) {',
  '      const v = aov.f32[i] * 255;',
  '      h[v > 200 ? 8 : Math.min(7, Math.round(v / 32))]++;',
  '    }',
  '    crossingHist = h;',
  '  }',
  '  let captured = 0, escaped = 0, stopped = 0, exhausted = 0, skyMax = 0, n = 0;',
  '  let discSum = 0, discMax = 0, discN = 0, skySum = 0, skyN = 0;',
  '  const alphaBins = {};',
  '  if (hdr) {',
  '    const f = hdr.f32;',
  '    for (let i = 0; i < f.length; i += 4) {',
  '      const a = f[i + 3];',
  '      if (a > 0.7) captured++; else if (a > 0.3) escaped++;',
  '      else if (a > 0.02) stopped++; else exhausted++;',
  '      const key = a.toFixed(3);',
  '      alphaBins[key] = (alphaBins[key] || 0) + 1;',
  '      const l = 0.2126 * f[i] + 0.7152 * f[i + 1] + 0.0722 * f[i + 2];',
  '      if (a > 0.3) { skySum += l; skyN++; if (l > skyMax) skyMax = l; }',
  '      if (a < 0.1) { discSum += l; discN++; if (l > discMax) discMax = l; }',
  '      n++;',
  '    }',
  '  }',
  '  return {',
  '    search: location.search,',
  '    cameraPos: c.position.toArray().map((x) => +x.toFixed(4)),',
  '    radius: +r.toFixed(4),',
  '    thetaDeg: +(Math.acos(c.position.y / r) * 180 / Math.PI).toFixed(2),',
  '    phiDeg: +(Math.atan2(c.position.x, c.position.z) * 180 / Math.PI).toFixed(2),',
  '    fov: +c.fov.toFixed(2),',
  '    shot: !!window.__GARGANTUA_SHOT__,',
  '    diskOuter: G.state.params.diskOuter,',
  '    diskBright: G.state.params.diskBright,',
  '    exposure: G.state.params.exposure,',
  '    diskTemp: G.state.params.diskTemp,',
  '    buffer: G.info.buffer,',
  '    frames: G.info.frames,',
  '    pngLen: (window.__GARGANTUA_SHOT__ || "").length,',
  '    png: await (async () => {',
  '      const url = window.__GARGANTUA_SHOT__;',
  '      if (!url) return null;',
  '      const img = new Image();',
  '      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });',
  '      const cv = document.createElement("canvas");',
  '      cv.width = img.width; cv.height = img.height;',
  '      const cx = cv.getContext("2d");',
  '      cx.drawImage(img, 0, 0);',
  '      const d = cx.getImageData(0, 0, cv.width, cv.height).data;',
  '      let sum = 0, max = 0, n2 = 0;',
  '      for (let i = 0; i < d.length; i += 4) {',
  '        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;',
  '        sum += l; if (l > max) max = l; n2++;',
  '      }',
  '      return { w: cv.width, h: cv.height, mean: +(sum / n2).toFixed(4), max: +max.toFixed(3) };',
  '    })(),',
  '    capturedPct: +((captured / n) * 100).toFixed(2),',
  '    escapedPct: +((escaped / n) * 100).toFixed(2),',
  '    stoppedPct: +((stopped / n) * 100).toFixed(2),',
  '    exhaustedPct: +((exhausted / n) * 100).toFixed(2),',
  '    skyMax: +skyMax.toFixed(3),',
  '    skyMean: +(skySum / Math.max(skyN, 1)).toFixed(4),',
  '    discMean: +(discSum / Math.max(discN, 1)).toFixed(4),',
  '    discMax: +discMax.toFixed(3),',
  '    discFlux: +((discSum / Math.max(n, 1)) * 1000).toFixed(2),',
  '    alphaBins,',
  '    crossingHist,',
  '  };',
  '})()',
].join('\n');

rmSync(TMP, { recursive: true, force: true });
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });

try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* wait */ }
    if (!target) await sleep(200);
  }
  const ws = new WS(target.webSocketDebuggerUrl);
  await ws.connect();
  let id = 0;
  const pending = new Map();
  ws.onText = (t) => {
    const m = JSON.parse(t);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      return { evalError: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', {
    url: URL_ARG ? arg : pathToFileURL(join(ROOT, 'index.html')).href + query,
  });

  for (let i = 0; i < 250; i++) {
    if (await evaluate('!!window.__GARGANTUA_BOOTED__') === true) break;
    await sleep(200);
  }
  await sleep(1600);
  console.log(JSON.stringify(await evaluate(EXPR), null, 2));
} catch (e) {
  console.error('probe failed:', e.message);
  process.exitCode = 2;
} finally {
  try { child.kill(); } catch (e) { /* ignore */ }
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch (e) { /* ignore */ }
}
process.exit(process.exitCode || 0);
