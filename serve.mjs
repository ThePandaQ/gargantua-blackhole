#!/usr/bin/env node
/**
 * GARGANTUA — dependency-free static server.
 *
 *   node serve.mjs            -> http://127.0.0.1:8099
 *   node serve.mjs 9000       -> custom port
 *   node serve.mjs 9000 0.0.0.0
 *
 * Nothing is bundled or transpiled: the browser loads the ES modules directly,
 * which is exactly what `python -m http.server` or nginx would do. This server
 * exists only to add the correct MIME types for .mjs/.js and to disable caching
 * during development.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8099);
const HOST = process.argv[3] || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const safe = normalize(pathname).replace(/^([/\\])+/, '');
    const full = join(ROOT, safe);
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403).end('403 forbidden');
      return;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      res.writeHead(302, { Location: pathname.replace(/\/?$/, '/') + 'index.html' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store, must-revalidate',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    createReadStream(full).pipe(res);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GARGANTUA  ->  http://${HOST}:${PORT}/`);
  console.log(`serving    ${ROOT}`);
  console.log('Ctrl+C to stop.');
});
