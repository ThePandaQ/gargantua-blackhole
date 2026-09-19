#!/usr/bin/env node
/**
 * Screenshot any URL, DOM included.
 *
 *   node tools/shot.mjs <url> <out.png> [width] [height] [waitMs]
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'tests', '.chrome-shot');
const target = process.argv[2];
const out = process.argv[3] || join(ROOT, 'tests', 'shots', 'shot.png');
const W = Number(process.argv[4] || 1280);
const H = Number(process.argv[5] || 800);
const WAIT = Number(process.argv[6] || 4000);

if (!target) { console.error('usage: node tools/shot.mjs <url> <out.png> [w] [h] [waitMs]'); process.exit(2); }

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
const PORT = 9395;

rmSync(TMP, { recursive: true, force: true });
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

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
  ws.onText = (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: target });
  await sleep(WAIT);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(r.result.data, 'base64');
  writeFileSync(out, buf);
  console.log('wrote ' + out + '  (' + W + 'x' + H + ', ' + Math.round(buf.length / 1024) + ' KB)');
} catch (e) {
  console.error('shot failed:', e.message);
  process.exitCode = 2;
} finally {
  try { child.kill(); } catch (e) { /* ignore */ }
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch (e) { /* ignore */ }
}
process.exit(process.exitCode || 0);
