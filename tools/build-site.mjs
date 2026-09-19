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
  'src/i18n/index.js',
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
 * Regenerate tests/harness.html from index.html.
 *
 * The harness has to load the app with the real markup, so its page is a copy of
 * index.html with a relative importmap and one extra module. Hand-maintaining
 * that copy is how it drifted: when the HUD gained folding and a language
 * button, the harness page kept the old markup and its interface checks began
 * crashing on elements that were never there.
 *
 * Generating it makes that class of drift impossible — the two cannot disagree.
 */
function syncHarness() {
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const out = join(ROOT, 'tests', 'harness.html');

  /* index.html's importmap is relative to the project root; from tests/ it
     needs one more level */
  const map = src.match(/<script type="importmap">[\s\S]*?<\/script>/);
  if (!map) throw new Error('index.html has no importmap to mirror');
  const testMap = map[0]
    .replace('"three": "./vendor/three/three.module.js"', '"three": "../vendor/three/three.module.js"')
    .replace('"three/addons/": "./vendor/three/addons/"', '"three/addons/": "../vendor/three/addons/"');

  const generated = src
    /* our importmap replaces theirs, and moves to the head where it must be */
    .replace(/<script type="importmap">[\s\S]*?<\/script>\n?/, '')
    .replace('<link rel="stylesheet" href="./style.css" />',
      testMap + '\n<link rel="stylesheet" href="../style.css" />')
    .replace(/<script type="module" src="\.\/src\/main\.js"><\/script>/,
      '<script type="module" src="../src/main.js"></script>\n'
      + '<script type="module" src="./harness.js"></script>')
    .replace('<title>GARGANTUA — Schwarzschild Black Hole Raytracer</title>',
      '<title>GARGANTUA — acceptance harness</title>')
    .replace('<html lang="en" data-lang="en">', '<html lang="en" data-lang="en" data-harness="1">');

  /* injected so a reader of the generated file knows not to edit it */
  const banner = '<!--\n  GENERATED FILE — do not edit.\n'
    + '  Produced from index.html by tools/build-site.mjs so the acceptance\n'
    + '  harness always exercises the shipped markup. Edit index.html instead.\n-->\n';

  const next = banner + generated;
  const prev = existsSync(out) ? readFileSync(out, 'utf8') : null;
  if (prev === next) return false;
  writeFileSync(out, next, 'utf8');
  return true;
}

/* Report harness drift without writing, so --check can fail on it. */
function harnessIsStale() {
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const out = join(ROOT, 'tests', 'harness.html');
  if (!existsSync(out)) return true;
  const before = readFileSync(out, 'utf8');
  const changed = syncHarness();
  if (changed) writeFileSync(out, before, 'utf8');
  return changed;
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
  const staleHarness = harnessIsStale();
  const before = existsSync(OUT) ? walk(OUT).sort() : [];
  const r = build();
  const after = walk(OUT).sort();
  const same = before.length === after.length && before.every((f, i) => f === after[i]);
  if (staleHarness) {
    console.error('\x1b[31mtests/harness.html is out of date — run: node tools/build-site.mjs\x1b[0m');
  }
  if (!r.ok || !same || staleHarness) {
    if (!same) {
      console.error('\x1b[31mdocs/ is out of date — run: node tools/build-site.mjs\x1b[0m');
      if (before.length !== after.length) {
        console.error(`  file count ${before.length} -> ${after.length}`);
      } else {
        for (let i = 0; i < before.length; i++) {
          if (before[i] !== after[i]) console.error(`  ${before[i]} -> ${after[i]}`);
        }
      }
    }
    process.exit(1);
  }
  console.log(`\x1b[32mdocs/ is in sync and tests/harness.html matches index.html\x1b[0m (${after.length} files)`);
  process.exit(0);
}

const r = build();
if (!r.ok) process.exit(1);
const synced = syncHarness();
const files = walk(OUT).sort();
console.log(`\n\x1b[1mstaged docs/\x1b[0m  ${files.length} files, ${(r.bytes / 1024 / 1024).toFixed(2)} MB`);
if (synced) console.log('\x1b[1msynced tests/harness.html from index.html\x1b[0m');
for (const f of files) console.log('  ' + f);
console.log('\nCommit docs/ and push. GitHub Pages serves it from the repository root.\n');
