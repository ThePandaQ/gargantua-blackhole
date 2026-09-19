#!/usr/bin/env node
/**
 * GARGANTUA — import graph checker.
 *
 * The browser reports a bad relative import as a bare `net::ERR_FILE_NOT_FOUND`
 * on a "Script" request, with no indication of which module asked for it. That
 * cost real debugging time, so this resolves every static import in the project
 * against the filesystem before the browser ever sees it.
 *
 *   node tools/checkimports.mjs
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.chrome-profile' || e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else if (/\.(m?js)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/* three's own bundle is 1.2 MB of upstream code — checking it would only
   produce false positives about its own optional imports */
const files = walk(ROOT).filter((f) => !f.includes(join('vendor', 'three')));
let problems = 0;
let edges = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const specs = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);

  for (const spec of specs) {
    edges++;
    /* non-relative specifiers are resolved by the importmap pass below */
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    const p = !existsSync(target) && existsSync(target + '.js') ? target + '.js' : target;
    const good = existsSync(p) && statSync(p).isFile();
    if (!good) {
      problems++;
      console.log(`${C.r}FAIL${C.x} ${relative(ROOT, file)}`);
      console.log(`     -> "${spec}"  resolved to ${relative(ROOT, p)}  ${C.r}(missing)${C.x}`);
    }
  }
}

/* every file the importmap points at must exist */
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mapBlock = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
const IMPORTS = mapBlock ? (JSON.parse(mapBlock[1]).imports || {}) : {};

/**
 * Browser importmap resolution, including trailing-slash prefix mappings:
 *   "three"          -> exact match
 *   "three/addons/"  -> prefix match, remainder is appended
 */
function resolveImportMap(spec) {
  if (Object.prototype.hasOwnProperty.call(IMPORTS, spec)) return { target: IMPORTS[spec], key: spec };
  for (const [key, value] of Object.entries(IMPORTS)) {
    if (!key.endsWith('/')) continue;
    if (spec.startsWith(key)) return { target: value + spec.slice(key.length), key };
  }
  return null;
}

for (const [k, v] of Object.entries(IMPORTS)) {
  const p = resolve(ROOT, v.replace(/^\.\//, ''));
  const ok = existsSync(p);
  if (!ok) problems++;
  console.log(`${ok ? C.g + 'PASS' : C.r + 'FAIL'}${C.x} importmap "${k}" -> ${v} ${ok ? '' : C.r + '(missing)' + C.x}`);
}

/* re-resolve the bare specifiers now that the map is known */
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const specs = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const spec of specs) {
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    const mapped = resolveImportMap(spec);
    if (!mapped) {
      problems++;
      console.log(`${C.r}FAIL${C.x} ${relative(ROOT, file)} -> "${spec}" is not in the importmap`);
      continue;
    }
    const target = resolve(ROOT, mapped.target.replace(/^\.\//, ''));
    const ok = existsSync(target);
    if (!ok) problems++;
    console.log(`${ok ? C.g + 'PASS' : C.r + 'FAIL'}${C.x} ${relative(ROOT, file)} -> "${spec}" -> ${relative(ROOT, target)}${ok ? '' : C.r + ' (missing)' + C.x}`);
  }
}

/* the browser can only load .js/.mjs as modules over a static server */
const nonJs = files.filter((f) => !/\.(m?js)$/.test(f));
void nonJs;

console.log('');
console.log(`${edges} import edges checked across ${files.length} modules`);
if (problems) {
  console.log(`${C.r}${problems} unresolved import(s).${C.x}\n`);
  process.exit(1);
}
console.log(`${C.g}every import resolves.${C.x}\n`);
