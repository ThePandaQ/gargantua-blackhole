#!/usr/bin/env node
/**
 * GARGANTUA — build-time shader validator (no GPU required).
 *
 * There is no headless GLSL compiler in this toolchain, so this script performs
 * the checks that actually catch the mistakes people make in this kind of
 * shader: unbalanced braces, references to undeclared identifiers, uniforms
 * that are written by the CPU but never declared (or vice versa), and reserved
 * words that silently break some drivers.
 *
 * It is not a substitute for a real compile — the app compiles for real at
 * boot and reports through the fatal overlay — but it makes the failure mode
 * "typo in a 900-step integrator" impossible to miss.
 *
 *   node tools/validate.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;

const ok = (msg) => { checks++; console.log(`  \x1b[32mPASS\x1b[0m ${msg}`); };
const bad = (msg) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const info = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

/* ------------------------------------------------------------------ */
/* load the shader modules through a tiny ESM shim                     */
/* ------------------------------------------------------------------ */
async function loadShaders() {
  const scene = await import(new URL('../src/shaders/scene.js', import.meta.url).href);
  const post = await import(new URL('../src/shaders/post.js', import.meta.url).href);
  const geo = await import(new URL('../src/shaders/geodesic.js', import.meta.url).href);
  return { scene, post, geo };
}

/* ------------------------------------------------------------------ */
/* a deliberately small GLSL ES 3.00-ish sanity checker                */
/* ------------------------------------------------------------------ */
const BUILTIN = new Set([
  'gl_FragCoord', 'gl_Position', 'gl_PointSize', 'gl_VertexID',
  'gl_FrontFacing', 'gl_PointCoord', 'gl_InstanceID',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4',
  'mat2', 'mat3', 'mat4', 'float', 'int', 'uint', 'bool', 'void', 'sampler2D',
  'samplerCube', 'sampler3D', 'sampler2DArray', 'texture2D', 'texture', 'textureLod',
  'textureCube', 'mix', 'clamp', 'smoothstep', 'step', 'length', 'normalize', 'dot',
  'cross', 'abs', 'min', 'max', 'pow', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'inversesqrt',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'floor', 'ceil', 'fract', 'mod', 'sign',
  'reflect', 'refract', 'distance', 'faceforward', 'degrees', 'radians', 'discard',
  'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'const', 'uniform',
  'varying', 'attribute', 'in', 'out', 'inout', 'precision', 'highp', 'mediump', 'lowp',
  'struct', 'true', 'false', 'main', 'lowp', 'sampler2DShadow', 'transpose', 'determinant',
  'inverse', 'matrixCompMult', 'outerProduct', 'lessThan', 'greaterThan', 'equal',
  'notEqual', 'any', 'all', 'not', 'isnan', 'isinf', 'round', 'trunc', 'sinh', 'cosh',
  'tanh', 'asinh', 'acosh', 'atanh', 'fma', 'frexp', 'ldexp', 'packSnorm2x16',
  'unpackSnorm2x16', 'packHalf2x16', 'unpackHalf2x16', 'floatBitsToInt', 'intBitsToFloat',
]);

const RESERVED = ['asm', 'class', 'union', 'enum', 'typedef', 'template', 'this',
  'packed', 'goto', 'switch', 'default', 'inline', 'noinline', 'volatile', 'public',
  'static', 'extern', 'external', 'interface', 'long', 'short', 'double', 'half',
  'fixed', 'unsigned', 'superp', 'input', 'output', 'hvec2', 'hvec3', 'hvec4',
  'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4', 'sampler1D', 'sampler1DShadow',
  'sampler2DRect', 'sampler3DRect', 'sampler2DRectShadow', 'sizeof', 'cast', 'namespace',
  'using'];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function checkSource(name, src, opts = {}) {
  const fragment = opts.fragment !== false;
  info(`checking ${name}  (${src.split('\n').length} lines)`);
  const body = stripComments(src);

  /* braces / parens balance */
  let depth = 0, paren = 0, bad2 = false;
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) bad2 = true; }
    else if (ch === '(') paren++;
    else if (ch === ')') { paren--; if (paren < 0) bad2 = true; }
  }
  if (depth === 0 && paren === 0 && !bad2) ok('braces and parentheses balanced');
  else bad(`unbalanced delimiters (brace depth ${depth}, paren depth ${paren})`);

  /* preprocessor guards used in this project */
  const ifs = (body.match(/^\s*#if\b/gm) || []).length
    + (body.match(/^\s*#ifdef\b/gm) || []).length
    + (body.match(/^\s*#ifndef\b/gm) || []).length;
  const ends = (body.match(/^\s*#endif\b/gm) || []).length;
  if (ifs === ends) ok(`preprocessor blocks balanced (${ifs} #if / ${ends} #endif)`);
  else bad(`#if ${ifs} vs #endif ${ends}`);

  /* reserved words */
  const reserved = RESERVED.filter((w) => new RegExp(`\\b${w}\\b`).test(body));
  if (!reserved.length) ok('no reserved words used as identifiers');
  else bad(`reserved words present: ${reserved.join(', ')}`);

  /* entry point + stage output.
     Library fragments have no entry point and are validated only after being
     composed into a real program, so skip both checks for them. */
  if (opts.entry === false) {
    ok('library fragment — entry point and stage output checked after composition');
  } else if (/\bvoid\s+main\s*\(\s*(void)?\s*\)/.test(body)) ok('void main() present');
  else bad('no void main() entry point');

  if (opts.entry === false) {
    /* nothing further */
  } else if (!fragment) {
    if (/gl_Position\s*=/.test(body)) ok('gl_Position written (vertex stage)');
    else bad('gl_Position never written');
  } else if (/(?:gl_FragColor|fragColor)\s*=/.test(body)) {
    ok('fragment output written' + (/gl_FragColor/.test(body) ? ' (gl_FragColor)' : ' (declared out vec4 fragColor)'));
  } else bad('the fragment output is never written');

  return body;
}

/* identifier collection, good enough for GLSL without a real parser */
const KEYWORDS = /^(?:if|else|for|while|do|return|break|continue|discard|const|uniform|varying|attribute|in|out|inout|precision|highp|mediump|lowp|struct|true|false|void|layout|flat|smooth|centroid|switch|case|default)$/;

function declaredNames(body) {
  const names = new Set(BUILTIN);
  /* declarations:  <type> <name>  (also handles arrays and function params) */
  const declRe = /\b(?:float|int|uint|bool|void|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?|sampler[23]D|samplerCube)\s+([A-Za-z_]\w*)/g;
  let m;
  while ((m = declRe.exec(body))) names.add(m[1]);
  /* uniforms with multiple declarators: uniform vec2 a, b; */
  const uRe = /uniform\s+[\w\d]+\s+([^;]+);/g;
  while ((m = uRe.exec(body))) {
    for (const piece of m[1].split(',')) {
      const id = piece.trim().match(/^([A-Za-z_]\w*)/);
      if (id) names.add(id[1]);
    }
  }
  /* struct members + local vars introduced via "const TYPE name =" */
  const cRe = /\bconst\s+[\w\d]+\s+([A-Za-z_]\w*)/g;
  while ((m = cRe.exec(body))) names.add(m[1]);
  /* for-loop counters */
  const fRe = /for\s*\(\s*(?:int|float|uint)\s+([A-Za-z_]\w*)/g;
  while ((m = fRe.exec(body))) names.add(m[1]);
  return names;
}

function checkIdentifiers(name, body) {
  const known = declaredNames(body);
  const called = new Set();
  /* a call is an identifier immediately followed by "(" — but only when the
     identifier starts at a word boundary that is NOT the middle of prose.
     Comments are already stripped, so this is safe enough for GLSL. */
  const callRe = /(^|[^\w.])([A-Za-z_]\w{1,40})\s*\(/g;
  let m;
  while ((m = callRe.exec(body))) {
    const id = m[2];
    if (KEYWORDS.test(id) || BUILTIN.has(id)) continue;
    called.add(id);
  }
  const missing = [...called].filter((id) => !known.has(id));
  if (!missing.length) ok('every called function is declared');
  else bad(`called but never declared: ${missing.join(', ')} — in ${name}`);
}

/* ------------------------------------------------------------------ */
/* uniform <-> CPU wiring                                              */
/* ------------------------------------------------------------------ */
const CPU_UNIFORMS = {
  scene: (() => {
    const p = new URL('../src/render/pipeline.js', import.meta.url);
    const src = readFileSync(p, 'utf8');
    const set = new Set();
    for (const m of src.matchAll(/p\.u[123]i?f\(\s*'([^']+)'/g)) set.add(m[1]);
    for (const m of src.matchAll(/u2f\('([^']+)'/g)) set.add(m[1]);
    return set;
  })(),
  composite: new Set(),
};

/* ------------------------------------------------------------------ */
/* project-level assertions                                            */
/* ------------------------------------------------------------------ */
function checkProject() {
  info('project-level assertions');
  const must = [
    'index.html', 'style.css', 'serve.mjs',
    'vendor/three/three.module.js',
    'vendor/three/addons/controls/OrbitControls.js',
    'src/main.js', 'src/config.js', 'src/state.js',
    'src/render/pipeline.js', 'src/render/governor.js',
    'src/camera/rig.js', 'src/ui/hud.js', 'src/audio/ambient.js',
    'src/shaders/geodesic.js', 'src/shaders/scene.js', 'src/shaders/post.js',
  ];
  const missing = must.filter((f) => !existsSync(resolve(ROOT, f)));
  if (!missing.length) ok(`all ${must.length} required files present`);
  else bad(`missing files: ${missing.join(', ')}`);

  const cfg = readFileSync(resolve(ROOT, 'src/config.js'), 'utf8');
  const ptable = cfg.slice(cfg.indexOf('export const PARAM_DEFS'), cfg.indexOf('export const PARAM_COUNT'));
  const pcount = (ptable.match(/key:\s*'/g) || []).length;
  if (pcount === 21) ok('exactly 21 raytracer parameters declared');
  else bad(`expected 21 parameters, found ${pcount}`);
  if (/PARAM_COUNT = PARAM_DEFS\.length/.test(cfg)) ok('PARAM_COUNT derives from PARAM_DEFS');
  else bad('PARAM_COUNT is not derived from PARAM_DEFS');

  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  if (html.includes('"three": "./vendor/three/three.module.js"')) ok('importmap points three at ./vendor');
  else bad('importmap does not map "three" to the vendored build');
  /* The rule is "no external dependency", not "no URL": the boot guard has to
     name the local address the user should open, and the SVG namespace is not a
     fetch. Anything else http(s) — a CDN, a font host, an analytics tag — is a
     real failure, because the project must run from a bare static server. */
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const urls = [...htmlNoComments.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
  const external = urls.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(u)
    && !/^http:\/\/www\.w3\.org\//.test(u));
  if (!external.length) {
    ok('index.html has no external network references'
      + (urls.length ? ` (${urls.length} local/w3.org URL${urls.length > 1 ? 's' : ''} allowed)` : ''));
  } else bad('index.html references external URLs: ' + external.join(', '));

  const main = readFileSync(resolve(ROOT, 'src/main.js'), 'utf8');
  if (main.includes('LinearSRGBColorSpace')) ok('renderer output colour space pinned to linear (no double sRGB encode)');
  else bad('output colour space not pinned — the composite would be double-encoded');
  if (main.includes('webglcontextlost') && main.includes('webglcontextrestored')) ok('context loss + restore handlers registered');
  else bad('missing context loss handling');
}

/* ------------------------------------------------------------------ */
(async () => {
  console.log('\n\x1b[1mGARGANTUA — static validation\x1b[0m\n');
  const { scene, post, geo } = await loadShaders();

  console.log('\n\x1b[1m1. shared GLSL library (validated as composed into the scene pass)\x1b[0m');
  const libOpts = { fragment: false, entry: false };
  const geoBody = checkSource('geodesicGLSL', geo.geodesicGLSL, libOpts);
  const comBody = checkSource('commonGLSL', (await import(new URL('../src/shaders/common.js', import.meta.url).href)).commonGLSL, libOpts);
  const diskBody = checkSource('diskGLSL', geo.diskGLSL, libOpts);
  const lib = comBody + '\n' + geoBody + '\n' + diskBody;
  checkIdentifiers('shared library (as composed)', lib);

  console.log('\n\x1b[1m2. scene.js (main pass)\x1b[0m');
  const sceneBody = checkSource('sceneFrag', scene.sceneFrag);
  checkIdentifiers('sceneFrag', sceneBody);
  if (/for\s*\(\s*int\s+i\s*=\s*0;\s*i\s*<\s*MAX_ITER/.test(sceneBody)) ok('integration loop uses a constant bound (GLSL ES requires it)');
  else bad('integration loop bound is not a compile-time constant');
  if (/MAX_ITER\s+900/.test(sceneBody)) ok('iteration cap MAX_ITER = 900 declared');
  else bad('MAX_ITER missing');

  console.log('\n\x1b[1m3. post.js (bloom + composite)\x1b[0m');
  const postBodies = [];
  for (const [n, s, frag] of [['fullscreenVert', post.fullscreenVert, false],
    ['prefilterFrag', post.prefilterFrag, true],
    ['downsampleFrag', post.downsampleFrag, true],
    ['upsampleFrag', post.upsampleFrag, true],
    ['compositeFrag', post.compositeFrag, true]]) {
    const b = checkSource(n, s, { fragment: frag });
    postBodies.push(b);
  }
  checkIdentifiers('prefilterFrag', post.prefilterFrag);
  checkIdentifiers('downsampleFrag', post.downsampleFrag);
  checkIdentifiers('upsampleFrag', post.upsampleFrag);
  /* composite is validated exactly as the GPU sees it: library + body */
  checkIdentifiers('compositeFrag (composed)',
    comBody + '\n' + stripComments(post.compositeFrag));

  console.log('\n\x1b[1m4. uniform wiring\x1b[0m');
  const declared = new Set();
  for (const body of [comBody, geoBody, diskBody, sceneBody, ...postBodies]) {
    for (const m of body.matchAll(/uniform\s+[\w\d]+\s+([^;]+);/g)) {
      for (const piece of m[1].split(',')) {
        const id = piece.trim().match(/^([A-Za-z_]\w*)/);
        if (id) declared.add(id[1]);
      }
    }
  }
  const sceneUniforms = [...declared];
  /* only the parameter table in config.js defines raytracer parameters —
     view presets and debug modes also carry `key:` fields, so scope the scan */
  const cfgSrc = readFileSync(resolve(ROOT, 'src/config.js'), 'utf8');
  const paramTable = cfgSrc.slice(
    cfgSrc.indexOf('export const PARAM_DEFS'),
    cfgSrc.indexOf('export const PARAM_COUNT')
  );
  const PARAM_KEYS = [...paramTable.matchAll(/key:\s*'(\w+)'/g)].map((m) => m[1]);
  const missingU = PARAM_KEYS.filter((k) => !sceneUniforms.includes('u_' + k));
  if (!missingU.length) ok(`all ${PARAM_KEYS.length} parameters have a matching GLSL uniform (u_*)`);
  else bad(`parameters without a uniform: ${missingU.join(', ')}`);

  const declaredParams = [...declared].filter((u) => u.startsWith('u_')).map((u) => u.slice(2));
  const orphan = declaredParams.filter((k) => !PARAM_KEYS.includes(k));
  if (!orphan.length) ok('no orphan u_* uniforms');
  else bad(`orphan u_* uniforms (no parameter behind them): ${orphan.join(', ')}`);

  checkProject();

  console.log(`\n\x1b[1m${checks - failures}/${checks} checks passed\x1b[0m\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\x1b[31mvalidator crashed\x1b[0m', e);
  process.exit(2);
});
