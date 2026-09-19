#!/usr/bin/env node
/**
 * Load the app over HTTP in a real browser and report exactly how far boot got.
 * Prints every console message, every exception and every failed request.
 *
 *   node tools/bootcheck.mjs http://127.0.0.1:8099/
 *   node tools/bootcheck.mjs file:///D:/DSH/003/index.html
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'tests', '.chrome-boot');
const target = process.argv[2] || 'http://127.0.0.1:8099/';

class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || '');
    this.buf = Buffer.alloc(0); this.frags = []; this.onText = () => {};
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
const PORT = 9391;

rmSync(TMP, { recursive: true, force: true });
/* deliberately WITHOUT --allow-file-access-from-files when the target is http,
   so the test matches what a normal browser tab does */
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

const console_ = [];
const errors = [];
const failed = [];

try {
  let t = null;
  for (let i = 0; i < 100 && !t; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* wait */ }
    if (!t) await sleep(200);
  }
  const ws = new WS(t.webSocketDebuggerUrl);
  await ws.connect();
  let id = 0;
  const pending = new Map();
  const reqUrls = new Map();
  ws.onText = (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      console_.push(m.params.type + ': ' + (m.params.args || []).map((a) =>
        a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value))
          : (a.description || a.type)).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry) {
      const en = m.params.entry;
      if (en.level === 'error') errors.push('LOG ' + en.text);
    }
    if (m.method === 'Network.requestWillBeSent' && m.params.request) {
      reqUrls.set(m.params.requestId, m.params.request.url);
    }
    if (m.method === 'Network.loadingFailed') {
      failed.push((m.params.type || '?') + ' ' + m.params.errorText + ' <' + (reqUrls.get(m.params.requestId) || '?') + '>');
    }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      return { evalError: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Network.enable');
  console.log('\nloading ' + target + '\n');
  await send('Page.navigate', { url: target });

  for (let i = 0; i < 60; i++) {
    const b = await evaluate('!!window.__GARGANTUA_BOOTED__');
    if (b === true) break;
    await sleep(250);
  }
  await sleep(500);

  const state = await evaluate(`(() => {
    const bl = document.getElementById('bootLog');
    const f = document.getElementById('fatal');
    const boot = document.getElementById('boot');
    return {
      readyState: document.readyState,
      booted: !!window.__GARGANTUA_BOOTED__,
      bootLogText: bl ? bl.textContent : null,
      bootBarWidth: (document.getElementById('bootBar') || {}).style ? document.getElementById('bootBar').style.width : null,
      bootDisplay: boot ? getComputedStyle(boot).display : null,
      fatalShown: f ? f.classList.contains('show') : null,
      fatalText: f ? f.textContent.trim().slice(0, 500) : null,
      hasGargantua: !!window.GARGANTUA,
      scripts: [...document.scripts].map((s) => s.src || '(inline)'),
      canvasSize: (() => { const c = document.getElementById('scene'); return c ? [c.width, c.height] : null; })(),
    };
  })()`);

  console.log('--- page state ---');
  console.log(JSON.stringify(state, null, 2));
  console.log('\n--- failed requests (' + failed.length + ') ---');
  for (const f of failed.slice(0, 20)) console.log('  ' + f);
  console.log('\n--- console (' + console_.length + ') ---');
  for (const c of console_.slice(0, 30)) console.log('  ' + String(c).slice(0, 300));
  console.log('\n--- exceptions (' + errors.length + ') ---');
  for (const e of errors.slice(0, 20)) console.log('  ' + String(e).slice(0, 500));
  console.log('');
} catch (e) {
  console.error('bootcheck failed:', e.message);
  process.exitCode = 2;
} finally {
  try { child.kill(); } catch (e) { /* ignore */ }
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch (e) { /* ignore */ }
}
process.exit(process.exitCode || 0);
