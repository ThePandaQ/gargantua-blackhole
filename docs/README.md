# GARGANTUA — Schwarzschild Black Hole Raytracer

**Live: <https://thepandaq.github.io/gargantua-blackhole/>**

A full-screen, real-time black hole. Every pixel traces a null geodesic of the
Schwarzschild metric backwards from the camera, integrated with classical RK4 in
a fragment shader. There is no black sphere, no ring mesh, no texture, no video
and no screenshot anywhere in the render path — the shadow, the photon ring, the
Einstein ring, the higher-order images of the accretion disc and the Doppler
beaming all fall out of the integration.

Vanilla HTML/CSS/JavaScript, ES modules, a locally vendored Three.js. **No build
step, no bundler, no CDN.**

---

## 0. Deploy it

The site is already published by GitHub Pages, served from `docs/` on `main`.
Anything in `docs/` is world-readable; everything else in the repository is
source, tests and tooling.

```bash
node tools/build-site.mjs          # stage the deployable site into docs/
                                   #   ...and regenerate tests/harness.html
node tools/build-site.mjs --check  # fail if docs/ or the harness has drifted
git add -A && git commit -m "..." && git push
```

`build-site.mjs` copies an explicit, human-readable manifest — 21 files, 1.5 MB —
rather than globbing the directory. `tests/shots/` (32 MB of captured frames) and
`tools/` stay out on purpose. If you add a file the app loads at runtime, add it
to the `FILES` list; forgetting is the one way to publish a broken site, which is
why `--check` exists and why the manifest is a list rather than a pattern.

It also **generates `tests/harness.html` from `index.html`**, so the acceptance
suite always exercises the shipped markup. That page used to be maintained by
hand and had drifted; now the two cannot disagree, and `--check` fails if they
do.

**Any static host works**, because every path in the project is relative and
there is nothing to build. Netlify, Cloudflare Pages, Vercel, S3, nginx: point it
at `docs/` and you are done. GitHub Pages was chosen because it is free, stable,
needs no CI, and keeps the site and its source in one repository.

### Verify a deployment

```bash
node tools/bootcheck.mjs https://thepandaq.github.io/gargantua-blackhole/
```

Loads the live URL in a real browser and reports the boot state, every console
message, every exception and every failed request. Run it after a deploy, or
after any change, to answer "is it actually working?" in one command.

> GitHub Pages serves `.js` as `application/javascript`, which ES modules need,
> so **no `_headers` or MIME configuration is required**. It does run Jekyll
> unless told not to, which would mangle files that start with an underscore —
> `docs/.nojekyll` is therefore part of the staged manifest and must stay.

> **If `git push` fails with "Failed to connect to github.com port 443"**, that is
> a network problem rather than a repository problem — the commit is already safe
> locally. Retry when the connection is back; `git log origin/main..HEAD` lists
> what is still waiting to go up.

---

## 1. Run it locally

```bash
cd D:\DSH\003
node serve.mjs 8099          # or: npm start
# -> http://127.0.0.1:8099/
```

**Open the `http://` URL. Do not double-click `index.html`.**

ES modules cannot be loaded from `file://` — the browser treats the origin as
`null` and blocks the request, so `src/main.js` never executes. If you do open
the file directly, the page now detects it and tells you exactly what to do
instead of spinning forever. Any static server works; `serve.mjs` exists only to
set the correct MIME types for `.js`/`.mjs` and to disable caching during
development. `npx serve .`, `python -m http.server 8099` or VS Code Live Server
will do just as well.

> **Requires WebGL2** and the `EXT_color_buffer_float` (or
> `EXT_color_buffer_half_float`) extension. If either is missing the page says so
> in plain language instead of showing a black screen. A stall that is not a
> `file://` problem is reported after 15 seconds, pointing at the console.

### Quality tiers

`STANDARD` (laptop / integrated GPU), `HIGH` (default, discrete GPU),
`CINEMATIC` (heavy GPU and stills). `AUTO` switches between them with hysteresis
and simultaneously scales the render buffer between 50 % and 100 % — that second
loop is what keeps a Retina display interactive.

---

## 2. The physics

Geometrised units throughout: **Schwarzschild radius `Rs = 1`, `c = G = 1`**, so
`M = 1/2`.

| quantity | value |
|---|---|
| event horizon | `r = 1.000 Rs` |
| photon sphere | `r = 1.500 Rs` |
| critical impact parameter | `b = 3√3/2 = 2.598076 Rs` |
| ISCO (default disc truncation) | `r = 3.000 Rs` |

### The integrator

A null geodesic obeys the exact Binet-type equation

```
d²u/dφ² + u = 3 M u²          u = 1/r
```

which we rewrite as a central-force problem in the ray's own orbital plane. With
`H = |r × v|` the conserved specific angular momentum (equal to the impact
parameter `b`, since `|v| = 1` at infinity):

```
d²r/dλ² = −(3/2) Rs H² r / r⁵
```

i.e. a purely **attractive `1/r⁴`** term. RK4 in an affine parameter `λ`, with an
adaptive step

```
step = a · r · sqrt(r / b)          (≈1.2·dλ for a circular null orbit)
```

plus two hard limits: inside the disc annulus the step never exceeds a fraction
of the distance to the disc plane (so a grazing ray cannot tunnel through the
sheet), and in the strong field it is capped near the horizon. That last limit is
load-bearing — without it, rays whose impact parameter sits just above `b_crit`
get walked across the horizon instead of winding back out, and the shadow grows
by ~20 %. It was caught by the acceptance suite.

Nothing is approximated: no weak-field expansion, no screen-space fudge.

### What you actually see

* **Shadow and photon ring** — rays with `b < b_crit` terminate on the horizon.
  The apparent half-angle from a finite observer radius `r₀` is

  ```
  sin²θ = (b² / r₀²)(1 − Rs/r₀)
  ```

  verified to 0 % against an independent RK4 solution by
  `node tools/shadow-theory.mjs`, and reproduced by the renderer to within 0.7 %
  at 27 Rs, 2.8 % at 15 Rs and 5.5 % at 8.4 Rs (see §6).
* **Multiple disc crossings** — a ray may cross the equatorial plane up to
  `uDiskCrossings` times (3 / 5 / 7 by tier), composited front-to-back with
  proper transmittance. That is where the secondary image under the shadow and
  the doubled arcs come from.
* **Doppler beaming and gravitational redshift** — for every crossing the
  emitter is a Keplerian circular orbit with
  `Ω = sqrt(M/r³)`, `v = sqrt(M/(r−Rs))`, and the exact transfer function

  ```
  g = E_obs / E_emit = sqrt(1 − Rs/r) / (γ (1 − β·n̂))
  I_obs = g⁴ I_emit                     (Liouville)
  ```

  which produces the one-sided brightening of a near edge-on disc. The
  `Doppler Boost` and `Grav. Redshift` sliders dial the two factors
  independently.
* **Blackbody colour** — the observed temperature `T_obs = T_emit · g` is mapped
  through an analytic Planck locus, so the approaching side is blue-white and the
  receding side orange-red without any hard-coded gradient.
* **Turbulence** — the disc density is fBm plus a ridged multifractal, sampled in
  a frame advected by each hotspot's own Keplerian `Ω·t`, so the pattern is
  sheared into trailing spiral filaments rather than rotating rigidly.
* **Background** — three star layers with a steep luminosity function and
  blackbody spectral classes, a Milky Way band with ridged dust lanes and a
  galactic bulge, and nebulae. All procedural, all sampled along the **bent** ray
  direction, which is what makes the Einstein ring of background stars real
  lensing and not a decoration.

---

## 3. Interface

**Two languages.** English and Simplified Chinese, switchable with the `中文` /
`EN` button in the top-right or the `L` key, persisted, and also settable by URL:
`?lang=zh`. Everything is translated — the 21 parameter labels, the four group
headings, the view presets, the ten debug views, all telemetry rows, the toasts,
the help overlay, the startup and context-loss messages, and the boot guard.
`node tools/i18n-audit.mjs` enforces that: a missing key, a key that exists in
one language only, a placeholder that differs between languages, or a config
entry with no Chinese label all fail the suite.

**Foldable parameter groups.** Each group header is a toggle, and `E` (or the
button in the panel header) folds them all at once — the point being that you can
dial in a look and then give the render the whole screen while keeping every
readout. A folded group keeps its header and slider count, so the panel stays a
usable index: open 562 px, folded 160 px. The folding state persists, and
`?collapse=1` folds everything from a link.

**HUD** — telemetry (frame time, buffer size, scale, tier, steps/ray, camera,
mode), 21 live sliders, 4 view presets, 3 quality tiers, 10 debug views.

| key | action |
|---|---|
| `1` `2` `3` `4` | photon ring / cinematic / beaming / polar sweep |
| `V` `N` · `←` `→` | cycle view presets |
| `C` | cinematic camera loop (84 s, 7 keyframed shots, seamless) |
| `0`–`9` | debug view |
| `H` | hide the whole HUD |
| `E` | fold / unfold every parameter group |
| `L` | switch interface language |
| `Q` | cycle quality tier · `A` toggle auto |
| `M` | ambient score · `P` download PNG · `F` fullscreen |
| `R` | reset every parameter · `?` keyboard reference |
| drag / wheel / pinch | orbit and dolly (OrbitControls, damped) |

### The 21 parameters

| group | parameter | range | default |
|---|---|---|---|
| **Accretion Geometry** | `diskInner` Disc Inner Edge | 1.5 – 6 Rs | 3.00 |
| | `diskOuter` Disc Outer Edge | 6 – 34 Rs | 19.00 |
| | `diskThickness` Disc Thickness | 0.01 – 0.40 | 0.085 |
| | `diskDensity` Disc Density | 0 – 8 | 3.40 |
| | `diskSlices` Disc Turbulence | 1 – 6 | 4 |
| | `diskSpin` Orbital Speed | 0 – 2.5 | 1.00 |
| **Matter & Relativity** | `diskTemp` Disc Temperature | 1200 – 30000 K | 10500 |
| | `diskBright` Disc Brightness | 0 – 6 | 1.55 |
| | `doppler` Doppler Boost | 0 – 1 | 1.00 |
| | `redshift` Grav. Redshift | 0 – 1 | 1.00 |
| | `turbulence` Turbulence | 0 – 1 | 0.72 |
| | `flowSpeed` Flow Animation | 0 – 2 | 1.00 |
| **Deep Sky** | `starDensity` Star Density | 0 – 2 | 0.85 |
| | `starBright` Star Brightness | 0 – 5 | 1.35 |
| | `milkyWay` Milky Way | 0 – 3 | 1.00 |
| | `nebula` Nebula Glow | 0 – 2 | 0.42 |
| | `skyRotation` Sky Rotation | 0 – 360° | 34.0 |
| **Optics & Grade** | `exposure` Exposure | 0.05 – 4 | 1.00 |
| | `bloom` Bloom | 0 – 2 | 0.62 |
| | `bloomThreshold` Bloom Threshold | 0 – 4 | 1.05 |
| | `dispersion` Chromatic Disp. | 0 – 1 | 0.28 |

Double-click a slider to reset it. Every slider is also a URL parameter, so any
look is deep-linkable and reproducible.

### Debug views

| | view | shows |
|---|---|---|
| `0` | Final composite | the graded frame |
| `1` | Raw HDR, false colour | pre-tonemap log₂ luminance |
| `2` | Integration cost | RK4 steps per ray |
| `3` | Deflection angle | total light bending, degrees |
| `4` | Impact parameter | `b/b_crit` with the capture mask; edge is exactly 1 |
| `5` | Doppler factor | `δ = 1/(γ(1−β·n̂))` at the disc |
| `6` | Gravitational shift | `√(1−Rs/r)` at emission |
| `7` | Disc temperature | observed blackbody `T` (K) |
| `8` | Disc crossings | crossings per ray (red = captured) |
| `9` | Lensed sky only | disc suppressed, pure lensing |

---

## 4. Rendering pipeline

```
pass 1  scene        RK4 null-geodesic integration          -> RGBA16F
pass 2  prefilter    soft-knee bright pass
pass 3  downsample   13-tap pyramid, N mips (4/5/6 by tier)
pass 4  upsample     9-tap tent pyramid, accumulated upward
pass 5  composite    exposure · bloom · dispersion · ACES ·
                     vignette · grain · dither · sRGB encode
```

All five passes are hand-written **GLSL ES 3.00** programs driving one fullscreen
triangle generated from `gl_VertexID` — no VBOs, no attributes, nothing to bind.
Three.js owns the context, the clock and OrbitControls; it never draws.

Details that matter:

* **RGBA16F everywhere**, so the shadow can be genuinely black next to a disc
  whose inner rim is four orders of magnitude brighter.
* **The alpha channel of the HDR buffer is a ray-termination code**
  (`1` captured, `0.4` escaped, `0.05` absorbed by the disc, `0` budget
  exhausted). That is what lets the test suite measure the shadow in ray space,
  entirely independently of exposure, grading and palette.
* **Grain is multiplicative, not additive.** A constant additive grain puts a
  ~0.07 floor across the frame and lifts the event horizon off pure black.
* **Debug AOVs bypass bloom** and carry an inverse transfer so the palette
  reaches the screen unchanged rather than being gamma-lifted into grey.

---

## 5. Automation & robustness

### Screenshot interface

```
index.html?shot=1&ui=0&cinematic=0&t=12&w=3840&h=2160&preset=ring&quality=cinematic
```

| parameter | meaning |
|---|---|
| `shot=1` | render one deterministic frame, expose it, stop advancing |
| `t=<s>` | freeze the simulation clock (seconds) |
| `w`, `h` | force the output buffer size |
| `preset=` | `ring` · `classic` · `isco` · `polar` |
| `ui=0` | hide the HUD before capture |
| `cinematic=0` | disable the autonomous camera |
| `animate=0` | freeze the simulation clock entirely |
| `debug=<0-9>` | pick a debug view; **otherwise a shot always renders view 0** |
| `lang=en\|zh` | interface language |
| `collapse=1` | fold every parameter group |

A capture request never inherits the diagnostic view someone left switched on in
`localStorage`, and it enables `preserveDrawingBuffer` so `toDataURL()` cannot
race the compositor. `?shot=1` is meant to be reproducible from a cold profile.

When the frame is ready the page sets `window.__GARGANTUA_READY__ = true`, stores
a PNG data URL in `window.__GARGANTUA_SHOT__`, publishes
`window.__GARGANTUA_META__` and dispatches a `gargantua:shot` event.

Any of the 21 parameters can also be passed directly, e.g.
`?diskTemp=18000&diskInner=4&exposure=1.4`.

### Scripted control

```js
window.GARGANTUA.setParam('diskSpin', 1.8);
window.GARGANTUA.preset('isco');
window.GARGANTUA.setQuality('cinematic');
window.GARGANTUA.setDebug(5);
window.GARGANTUA.step(performance.now());   // render exactly one frame
window.GARGANTUA.pauseLoop();
window.GARGANTUA.probe(64);                 // HDR sample for tests
window.GARGANTUA.readSceneHDR();            // full RGBA16F readback
```

### Robustness

* **`file://` guard** — an inline classic script (which runs even when the
  modules are exactly what failed) detects the `file://` protocol and explains
  the problem, the command to run and the URL to open, in English and Chinese.
  `file://` is the single most likely way to arrive at a blank screen here,
  because browsers block ES modules from disk origins and report it only in the
  console.
* **Boot-stall watchdog** — if the app has not finished starting after 15 s the
  same panel appears and points at the console, instead of an endless spinner.
* **WebGL2 probe before anything else**, then float-target support; both fail to
  a readable overlay, never to a black screen.
* **Context loss** — `webglcontextlost` is intercepted, an overlay explains what
  happened, and `webglcontextrestored` rebuilds the renderer, every render target
  and all five programs, then restarts the loop. GPU objects belonging to the
  dead context are dropped rather than deleted through the new one, which would
  flood the console with `INVALID_OPERATION`.
* **State persistence** — all 21 parameters, the debug view, the quality tier,
  the HUD flags and the camera pose are stored in `localStorage` under
  `gargantua.schwarzschild.v1`, debounced so slider drags do not thrash it. URL
  parameters override the stored state, so a link always wins. A `?shot=` capture
  additionally forces the debug view back to 0 unless the URL says otherwise, so
  a shared still can never inherit someone's diagnostic view.
* **Mobile & Retina** — DPR is capped per tier (1.0 / 1.5 / 2.0), the HUD
  reflows to one scrollable column below 720 px, and touch is handled.

---

## 6. Tests

Four independent layers, all runnable from the command line. Everything below was
executed on the machine that produced this project: **Chrome 153, ANGLE/D3D11,
AMD Radeon RX 6800 XT**.

```bash
node tools/validate.mjs       # 59 static checks: GLSL structure, uniform wiring, project invariants
node tools/i18n-audit.mjs     # translation completeness, parity, placeholders, orphans
node tools/checkimports.mjs   # 81 import edges incl. importmap prefix resolution
node tools/shadow-theory.mjs  # independent RK4 verification of the shadow geometry
node tools/glslcheck.mjs      # compiles every shader on the real driver
node tools/bootcheck.mjs <url>  # does it actually open? boot state, console, failed requests
node tools/acceptance.mjs     # 120 in-page checks + console/exception capture
node tools/acceptance.mjs --shots   # ...plus the screenshot gallery
node tools/imgstat.mjs        # objective grade statistics for the captures
node tools/shot.mjs <url> <out.png> # screenshot any URL, DOM included
node tools/build-site.mjs     # stage docs/ and regenerate the harness page
```

`tools/acceptance.mjs` speaks the Chrome DevTools Protocol directly over a raw
WebSocket (`node:net`, no dependencies) because `chrome --dump-dom` fires before
the shaders finish compiling and `--headless` starves `requestAnimationFrame`.
Frames are therefore driven through `GARGANTUA.step()`.

### Result

```
59/59   static validation
81/81   import edges resolve
 ok     shadow geometry cross-check (0.00e+0 % worst deviation)
 6/6    shaders compile on ANGLE/D3D11
 ok     interface fully translated (i18n audit)
120/120 in-page acceptance checks
  0     browser console errors / exceptions / warnings
15/15   screenshots written
```

The acceptance suite's centrepiece is a set of **physics** assertions, not
smoke tests:

| check | measured | expected |
|---|---|---|
| shadow apparent radius, `classic` (`r₀ = 27`) | 5.456° | 5.418° |
| shadow apparent radius, `ring` (`r₀ = 15`) | 9.900° | 9.633° |
| shadow apparent radius, `isco` (`r₀ = 13.5`) | 10.984° | 10.672° |
| shadow circularity (4 axes, `ring`) | 0.052° spread | isotropic |
| ray outcomes, `ring` (edge-on) | 13.8 % horizon · 30.6 % disc · 55.6 % sky | all three present |
| rays exhausting the step budget | 0.000 % | 0 % |
| captured fraction, disc on vs off | 13.32 % vs 13.32 % | identical |
| disc evolution over 14 s | 12.96 % drift | ≫ float floor |
| drift with `flowSpeed = 0` over 20 s | 0.000 % | bit-exact |
| zeroing every light source | mean L 0.0061 | ≈ 0 |

The shadow-radius figures are compared against
`sin²θ = (b²/r₀²)(1 − Rs/r₀)`, which `tools/shadow-theory.mjs` independently
confirms is exact by integrating the geodesic equation for each candidate impact
parameter and bisecting on the escape boundary — so the test cannot be wrong in
the same way as the renderer.

### Defects the suite found (all fixed)

1. `src/render/config.js` — wrong relative import; every module failed to load.
2. Shaders compiled as GLSL ES 1.00 — `gl_VertexID` and bitwise operators need an
   explicit `#version 300 es`.
3. `gl_FragColor` does not exist in ES 3.00; `varying` is a reserved word.
4. `texture2D` → `texture` throughout the post pipeline.
5. `starLayer` declared `float` but returned a `vec3` — a hard compile error.
6. A braceless `for` loop whose body swallowed the following statement.
7. Unrealised WebGL textures bound directly (`bindTexture` on a plain JS object).
8. The sky was ~30× too bright, washing out the shadow.
9. The probe left a render target bound, so every later frame drew into a 64×64
   buffer.
10. `readPixels` into a `Float32Array` on an RGBA16F target silently returns
    zeros; it needs `Uint16Array` plus explicit half-float decoding.
11. Near-horizon step size grew when the disc was hidden, letting rays tunnel
    across the horizon and inflating the shadow by ~20 %.
12. `flowSpeed = 0` left the disc pattern drifting, because only the advection
    term was scaled and not the slow restructure term.
13. Grain and dither were additive, putting a ~0.07 floor on the frame and
    lifting the event horizon off black.
14. Debug AOVs were gamma-lifted into flat grey, and smeared by bloom.
15. Context recovery left the paused RAF loop stopped, and deleted GL objects
    through the wrong context.
16. The sky carried an undocumented time drift, so no frame was ever
    reproducible even with the clock frozen.
17. The camera rig was never truly static: with the drift zeroed the roll
    smoothing still called `applyRoll()` every frame and rotated the right/up
    vectors by ~0.2°.
18. Ray-termination codes mislabelled the disc — a single crossing of a
    moderately thick disc leaves transmittance ≈ 3 × 10⁻³, above the 1.5 × 10⁻³
    cut, so disc-stopped rays were reported as untouched sky.
19. `shot=` inherited the persisted debug view, so one person leaving `9`
    selected poisoned every later capture through `localStorage`.
20. `canvas.toDataURL()` raced the compositor — with the WebGL default of
    `preserveDrawingBuffer: false` the drawing buffer is cleared once the frame
    has been composited, so the documented capture interface usually won that
    race and occasionally did not.
21. **Opening `index.html` from disk produced an endless "compiling geodesic
    integrator…" spinner.** Browsers refuse to load ES modules over `file://`
    (the origin is `null`), so `src/main.js` never executed and the only clue was
    a CORS line in a console most people never open. An inline *classic* script —
    which still runs when the modules are exactly what failed — now detects the
    protocol and prints the fix, in English and Chinese. A 15-second watchdog
    covers every other way boot can stall.

---

## 7. Layout

```
index.html              markup: canvas, HUD, overlays, importmap
style.css               instrument-panel chrome; grid HUD; responsive
serve.mjs               zero-dependency static server
package.json            scripts only — there are no dependencies
src/
  main.js               orchestration, uniforms, loop, capture, recovery
  config.js             the 21 parameters, tiers, presets, debug modes, shots
  state.js              persistence, URL overrides, event bus
  shaders/
    common.js           shared GLSL: hashes, noise, colour science
    geodesic.js         the RK4 Schwarzschild integrator + the disc transfer
    scene.js            main pass: sky, disc, debug AOVs, termination code
    post.js             fullscreen vertex, bloom pyramid, composite
  render/
    pipeline.js         5 GLSL ES 3.00 programs, RGBA16F targets, probe/readback
    governor.js         auto-tier hysteresis + resolution scaler
  camera/rig.js         OrbitControls, cinematic loop, presets, roll drift
  ui/hud.js             21 sliders, telemetry, hotkeys, toasts
  audio/ambient.js      synthesised D-flat ambient score (see §8)
vendor/three/           Three.js r160.1 + OrbitControls (MIT, licence included)
tools/
  validate.mjs          GLSL/project static validator
  checkimports.mjs      import graph resolver
  glslcheck.mjs         real-driver shader compilation
  shadow-theory.mjs     independent geodesic-integration cross-check
  acceptance.mjs        CDP driver: 94 checks + screenshot gallery
  probe.mjs             ad-hoc live-DOM probe
tests/
  harness.html/.js      the in-page acceptance battery
  shots/                14 captured frames
```

---

## 8. Ambient score

`src/audio/ambient.js` **synthesises** the ambient piece with the Web Audio API:
a sub-bass pair around 34 Hz, an open-fifth pad in D Dorian, band-passed brown
noise whose centre frequency breathes at 0.021 Hz, and a sparse generative bell
melody through a convolution reverb. It ships as source, so there is no audio
file to fetch, nothing to stream and nothing that can 404. `M` toggles it; the
browser's autoplay policy means the first toggle may need a click on the page.

There is deliberately **no binary audio asset**. If you want to drop a loop in
instead, put it at `assets/music/ambient.ogg` and load it with the same
`AudioContext` — the gain chain and toggle are already in place.

## 9. Licence

Project code: MIT. Three.js r160.1 is vendored under `vendor/three/` with its own
MIT licence. No other third-party assets are included.
