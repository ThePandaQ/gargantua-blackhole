#!/usr/bin/env node
/**
 * Compile every shader through a real WebGL2 driver and print the raw logs.
 * Works without the full acceptance harness, which makes shader iteration fast.
 *
 *   node tools/glslcheck.mjs
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'tests', '.chrome-glsl');

class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || '');
    this.buf = Buffer.alloc(0); this.frag = [];
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
      if (!fin) { this.frag.push(p); continue; }
      this.onText(Buffer.concat(this.frag.length ? [...this.frag, p] : [p]).toString('utf8'));
      this.frag = [];
    }
  }
  send(data, op = 0x1) {
    if (!this.sock || this.sock.destroyed) return;
    const p = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const n = p.length;
    let h;
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
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));

rmSync(TMP, { recursive: true, force: true });
const PORT = 9355;
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  '--window-size=800,600', 'about:blank'], { stdio: 'ignore' });

let cdp = null;
const pageErrors = [];
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
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
    }
    if (m.method === 'Log.entryAdded' && m.params.entry
        && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) {
      pageErrors.push(m.params.entry.level + ': ' + m.params.entry.text);
    }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Log.enable');
  await send('Runtime.enable');
  await send('Page.enable');
  pageErrors.length = 0;
  await send('Page.navigate', { url: pathToFileURL(join(ROOT, 'tests', 'glslcompile.html')).href });

  let probe = null;
  for (let i = 0; i < 150; i++) {
    const r = await send('Runtime.evaluate', {
      expression: 'window.__PROBE__ ? JSON.parse(JSON.stringify(window.__PROBE__)) : null',
      returnByValue: true,
    });
    if (r.result && r.result.exceptionDetails) {
      console.error('page exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      break;
    }
    probe = r.result && r.result.result && r.result.result.value;
    if (probe && probe.done) break;
    await sleep(200);
  }

  if (!probe) {
    console.error('probe never reported');
    for (const e of pageErrors.slice(0, 8)) console.error('  ' + e);
    process.exitCode = 2;
  } else {
    let bad = 0;
    for (const r of probe.results) {
      console.log(`${r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${r.name}`);
      if (!r.ok) { bad++; console.log('     ' + r.log.split('\n').join('\n     ')); }
    }
    console.log(`\nsceneFrag source lines: ${probe.sceneLines}`);
    console.log(bad ? `\x1b[31m${bad} shader(s) failed to compile\x1b[0m\n` : '\x1b[32mall shaders compile\x1b[0m\n');
    process.exitCode = bad ? 1 : 0;
  }
} catch (e) {
  console.error('glslcheck failed:', e.message);
  process.exitCode = 2;
} finally {
  try { child.kill(); } catch (e) { /* ignore */ }
  /* Chrome can hold file handles on its profile for a moment after SIGKILL;
     a failure to delete the scratch profile is not a test failure */
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); }
  catch (e) { /* ignore */ }
}
process.exit(process.exitCode || 0);
