#!/usr/bin/env node
/**
 * Stage the deployable site into docs/ — the folder GitHub Pages publishes.
 *
 * The point is to make "what goes public" an explicit, reviewable list rather
 * than "whatever happened to be in the directory". Two things are deliberately
 * left out:
 *
 *   tests/shots/   34 MB of captured PNGs. They are evidence for the report,
 *                  not part of the site, and they would dominate the repo.
 *   tools/         the test drivers. They reference absolute D:\ paths and are
 *                  not needed to run or read the site.
 *
 * `docs/` is a flat mirror: the same relative layout the site already uses, so
 * nothing in the source needs a path rewrite. Run this after any source change,
 * then commit.
 *
 *   node tools/build-site.mjs          # stage docs/
 *   node tools/build-site.mjs --check  # fail if docs/ is stale
 */

import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, copyFileSync,
} from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs');
const CHECK = process.argv.includes('--check');

/* Every path the site loads at runtime, plus the documentation. If a file is
   added to the app it must be added here too — which is the point: the deploy
   manifest is a list a human reads, not a glob. */
const FILES = [
  'index.html',
  'style.css',
  'README.md',

  'src/main.js',
  'src/config.js',
  'src/state.js',
  'src/shaders/common.js',
  'src/shaders/geodesic.js',
  'src/shaders/scene.js',
  'src/shaders/post.js',
  'src/render/pipeline.js',
  'src/render/governor.js',
  'src/camera/rig.js',
  'src/ui/hud.js',
  'src/audio/ambient.js',

  'vendor/three/three.module.js',
  'vendor/three/addons/controls/OrbitControls.js',
  'vendor/three/LICENSE',

  'assets/music/README.md',
];

/* Generated, never copied by hand. */
const GENERATED = {
  '.nojekyll': '',
  'CNAME': null, // written only when a custom domain is configured
};

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * Replace docs/ atomically-ish.
 *
 * On Windows a process with a handle inside the tree (a static server started
 * from docs/, an editor, Explorer) makes rmSync fail with EPERM rather than
 * succeeding silently. Retrying is the documented remedy; if it still will not
 * go, say so plainly instead of dying in a stack trace, because the cause is
 * almost always a server the user forgot about.
 */
function cleanOut() {
  try {
    rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.error('\x1b[31mcannot replace ' + OUT + '\x1b[0m — ' + e.code);
    console.error('Something is holding a file inside it. The usual cause is a');
    console.error('static server started from that folder. Stop it and retry:');
    console.error('  node serve.mjs 8123      <- if you started one for docs/');
    process.exit(1);
  }
}

function build() {
  cleanOut();
  const missing = [];
  let bytes = 0;

  for (const rel of FILES) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) { missing.push(rel); continue; }
    const dst = join(OUT, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    bytes += statSync(dst).size;
  }

  for (const [name, content] of Object.entries(GENERATED)) {
    if (content === null) continue;
    writeFileSync(join(OUT, name), content, 'utf8');
  }

  if (missing.length) {
    console.error('\x1b[31mstaging is incomplete — missing files:\x1b[0m');
    for (const m of missing) console.error('  ' + m);
    return { ok: false, missing, bytes };
  }
  return { ok: true, missing: [], bytes };
}

if (CHECK) {
  /* Rebuild, then compare against what was committed, so `docs/` drifting out
     of sync with the source is caught before it is published. */
  const before = existsSync(OUT) ? walk(OUT).sort() : [];
  const r = build();
  const after = walk(OUT).sort();
  const same = before.length === after.length && before.every((f, i) => f === after[i]);
  if (!r.ok || !same) {
    console.error('\x1b[31mdocs/ is out of date — run: node tools/build-site.mjs\x1b[0m');
    if (before.length !== after.length) {
      console.error(`  file count ${before.length} -> ${after.length}`);
    } else {
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) console.error(`  ${before[i]} -> ${after[i]}`);
      }
    }
    process.exit(1);
  }
  console.log(`\x1b[32mdocs/ is in sync\x1b[0m (${after.length} files)`);
  process.exit(0);
}

const r = build();
if (!r.ok) process.exit(1);
const files = walk(OUT).sort();
console.log(`\n\x1b[1mstaged docs/\x1b[0m  ${files.length} files, ${(r.bytes / 1024 / 1024).toFixed(2)} MB\n`);
for (const f of files) console.log('  ' + f);
console.log('\nCommit docs/ and push. GitHub Pages serves it from the repository root.\n');
