#!/usr/bin/env node
/**
 * Image statistics for the captured frames — used to judge the grade
 * objectively instead of by eye.
 *
 *   node tools/imgstat.mjs tests/shots/*.png
 *
 * PNG decoding is done with node:zlib; no image library is needed because the
 * captures are 8-bit RGBA/RGB non-interlaced PNGs written by Chrome.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, basename } from 'node:path';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('only 8-bit non-interlaced supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('unsupported colour type ' + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

function stats(file) {
  const img = decodePNG(readFileSync(file));
  const { w, h, channels, data } = img;
  const n = w * h;
  let sum = 0, sum2 = 0, max = 0, dark = 0, hot = 0, sat = 0;
  const bins = new Array(16).fill(0);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += l; sum2 += l * l;
    if (l > max) max = l;
    if (l < 0.02) dark++;
    if (l > 0.92) hot++;
    if (r > 250 && g > 250 && b > 250) sat++;
    bins[Math.min(15, (l * 16) | 0)]++;
  }
  const mean = sum / n;
  return {
    file: basename(file), w, h,
    mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
    max, darkPct: (dark / n) * 100, hotPct: (hot / n) * 100, satPct: (sat / n) * 100,
    bins,
  };
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(process.cwd(), 'tests', 'shots')).filter((f) => f.endsWith('.png'))
    .map((f) => join(process.cwd(), 'tests', 'shots', f));

console.log('\n\x1b[1mGARGANTUA — captured frame statistics\x1b[0m\n');
console.log('  file                       size        mean   std    max   <2%   >92%  pure-white');
console.log('  ' + '-'.repeat(86));
for (const f of files) {
  try {
    const s = stats(f);
    console.log('  ' + s.file.padEnd(24) + (s.w + 'x' + s.h).padEnd(12)
      + s.mean.toFixed(4).padEnd(7) + s.std.toFixed(4).padEnd(7)
      + s.max.toFixed(3).padEnd(7)
      + (s.darkPct.toFixed(1) + '%').padEnd(6)
      + (s.hotPct.toFixed(2) + '%').padEnd(7)
      + s.satPct.toFixed(2) + '%');
  } catch (e) {
    console.log('  ' + basename(f).padEnd(24) + 'ERROR ' + e.message);
  }
}
console.log('');
