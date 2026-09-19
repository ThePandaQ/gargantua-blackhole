#!/usr/bin/env node
/**
 * GARGANTUA — interface translation audit.
 *
 * A translation layer fails quietly: a missing key renders as the key itself, or
 * as English, and nobody notices until a user does. This checks the three things
 * that actually go wrong:
 *
 *   1. a data-i18n key referenced in index.html that no dictionary defines
 *   2. a key defined in English but not in Chinese (or vice versa)
 *   3. a parameter, group, preset or debug mode with no Chinese label
 *
 *   node tools/i18n-audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

let failures = 0;
const ok = (m) => console.log(`  ${C.g}PASS${C.x} ${m}`);
const bad = (m) => { failures++; console.log(`  ${C.r}FAIL${C.x} ${m}`); };

const { DICTIONARIES, missingTranslations } = await import(
  new URL('../src/i18n/index.js', import.meta.url).href
);
const EN = DICTIONARIES.en;
const ZH = DICTIONARIES.zh;

console.log('\n\x1b[1mGARGANTUA — i18n audit\x1b[0m\n');

/* ---- 1. every data-i18n key in the markup must exist ---- */
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-html|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
const missingInMarkup = [...used].filter((k) => EN[k] === undefined);
if (!missingInMarkup.length) ok(`all ${used.size} data-i18n keys in index.html are defined`);
else bad('index.html references undefined keys: ' + missingInMarkup.join(', '));

/* ---- 2. dictionary parity ---- */
const enKeys = Object.keys(EN);
const zhKeys = Object.keys(ZH);
const noZh = enKeys.filter((k) => ZH[k] === undefined);
const noEn = zhKeys.filter((k) => EN[k] === undefined);
if (!noZh.length) ok(`every English key has a Chinese translation (${enKeys.length} keys)`);
else bad('missing Chinese: ' + noZh.join(', '));
if (!noEn.length) ok('no Chinese-only keys');
else bad('Chinese keys with no English counterpart: ' + noEn.join(', '));

/* ---- 3. config entries carry both languages ---- */
const structural = missingTranslations().filter((k) => !k.startsWith('param:') || true);
const labels = structural.filter((k) => /^(param|group|preset|debug):/.test(k));
if (!labels.length) ok('every parameter, group, preset and debug mode has a Chinese label');
else bad('untranslated config entries: ' + labels.join(', '));

/* ---- 4. interpolation placeholders must match between languages ---- */
const placeholder = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const mismatch = [];
for (const k of enKeys) {
  if (ZH[k] === undefined) continue;
  if (placeholder(EN[k]) !== placeholder(ZH[k])) {
    mismatch.push(`${k} (en: ${placeholder(EN[k]) || '-'} / zh: ${placeholder(ZH[k]) || '-'})`);
  }
}
if (!mismatch.length) ok('every {placeholder} matches across languages');
else bad('placeholder mismatch: ' + mismatch.join('; '));

/* ---- 5. keys defined but never referenced anywhere ---- */
const jsFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') walk(p); }
    else if (/\.(m?js)$/.test(e.name)) jsFiles.push(p);
  }
}(join(ROOT, 'src')));

const haystack = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n') + html;
/* Quote the key. A plain substring test also matches a key inside a longer one
   (`ui.lang` inside `ui.langTitle`), which made whole families look used. */
const referenced = (k) => haystack.includes(`'${k}'`) || haystack.includes(`"${k}"`)
  || haystack.includes('`' + k + '`')
  || haystack.includes(`data-i18n="${k}"`)
  || haystack.includes(`data-i18n-title="${k}"`)
  || haystack.includes(`data-i18n-html="${k}"`)
  || haystack.includes(`data-i18n-aria="${k}"`);
const unused = enKeys.filter((k) => !referenced(k));

/* Some families are composed at runtime — t('boot.' + phase), t('toast.' + kind)
   — so a key with no literal reference is still live if its prefix is being
   concatenated. Report the two cases separately: only a key that is neither
   literal nor composed can never be looked up at all. */
const prefixes = new Set();
for (const m of haystack.matchAll(/['"`]([a-z]+)\.['"`]?\s*\+/g)) prefixes.add(m[1] + '.');
const composed = (k) => {
  const dot = k.indexOf('.');
  return dot > 0 && prefixes.has(k.slice(0, dot + 1));
};
const orphans = unused.filter((k) => !composed(k));
const dynamic = unused.filter(composed);
if (!orphans.length) {
  const fams = [...new Set(dynamic.map((k) => k.split('.')[0] + '.'))];
  ok(`every dictionary key is reachable${dynamic.length
    ? ` (${dynamic.length} composed at runtime: ${fams.join(' ')}${C.x})` : ''}`);
} else {
  bad('keys nothing can ever look up: ' + orphans.join(', '));
}

/* ---- 6. the strings the user sees must not be identical in both languages ---- */
const untranslated = enKeys.filter((k) => ZH[k] !== undefined && ZH[k] === EN[k]
  && !/^[A-Z0-9 .·—/&%()-]+$/.test(EN[k]) && EN[k].length > 3);
if (!untranslated.length) ok('no string is accidentally left in English');
else console.log(`  ${C.y}note${C.x} identical in both: ${C.d}${untranslated.join(', ')}${C.x}`);

console.log('');
if (failures) {
  console.log(`${C.r}${failures} i18n problem(s).${C.x}\n`);
  process.exit(1);
}
console.log(`${C.g}interface is fully translated.${C.x}\n`);
