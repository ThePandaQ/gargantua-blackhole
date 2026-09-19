# GARGANTUA — test report

Machine-generated summary of the full suite. Re-run everything with:

```bash
cd D:\DSH\003
npm test          # validate + imports + shadow theory + GLSL compile
npm run shots     # CDP acceptance (91 checks) + 14-frame screenshot gallery
```

---

## Environment

| | |
|---|---|
| GPU | AMD Radeon RX 6800 XT (0x73BF) |
| Driver path | ANGLE (AMD, Direct3D11 vs_5_0 ps_5_0) |
| Browser | Chrome 153.0.8010.48, `--headless=new` |
| Context | WebGL 2.0 (OpenGL ES 3.0 Chromium) |
| Extensions | `EXT_color_buffer_float` ✓ `EXT_color_buffer_half_float` ✓ |
| Node | v26.4.0 |
| Date | 2026-09-19 |

---

## 1. Static validation — `tools/validate.mjs`

```
59/59 checks passed
```

GLSL structure (delimiters, preprocessor balance, reserved words, entry point,
stage output) for all six programs; identifier resolution for every called
function; the 21 parameters ↔ `u_*` uniform bijection in both directions;
`MAX_ITER` compile-time bound; importmap and vendor presence; colour-space
pinning. The external-reference check was tightened while fixing the `file://`
defect: it now permits the local `http://127.0.0.1` URL the boot guard has to
print, and still rejects any genuine external dependency.

## 2. Shadow geometry cross-check — `tools/shadow-theory.mjs`

The closed form used by the acceptance suite is verified against an independent
integration of `d²u/dφ² + u = 3Mu²`, shooting each candidate impact parameter
inward from `r = 10⁶` and bisecting on the escape boundary.

```
 r0        numerical b_edge    analytic b_edge     theta_num    theta_analytic   diff
 8.4       2.598076211         2.598076211         16.87599     16.87599         0.00000 %
 15        2.598076211         2.598076211          9.63273      9.63273         0.00000 %
 27        2.598076211         2.598076211          5.41830      5.41830         0.00000 %
 32        2.598076211         2.598076211          4.58346      4.58346         0.00000 %
 60        2.598076211         2.598076211          2.46097      2.46097         0.00000 %
 200       2.598076211         2.598076211          0.74245      0.74245         0.00000 %
 1e4       2.598076211         2.598076211          0.01489      0.01489         0.00000 %

PASS  sin^2(theta) = (b^2/r0^2)(1 - Rs/r0) is exact
```

## 3. Shader compilation — `tools/glslcheck.mjs`

Every program compiled by the real driver, not a linter.

```
PASS fullscreenVert      PASS sceneFrag        PASS prefilterFrag
PASS downsampleFrag      PASS upsampleFrag     PASS compositeFrag
all shaders compile      (sceneFrag: 552 source lines)
```

## 4. Acceptance — `tools/acceptance.mjs`

Chrome DevTools Protocol over a raw `node:net` WebSocket. Frames are driven by
`GARGANTUA.step()` because `--headless` starves `requestAnimationFrame`, and
`--dump-dom` fires before the shaders finish compiling.

```
94/94 in-page checks passed in 8.8s
 0 browser-level console errors / exceptions / warnings
14/14 screenshots written
```

<details>
<summary>Physics assertions (the part that matters)</summary>

| check | measured | expected | verdict |
|---|---|---|---|
| shadow radius, `classic` `r₀=27` | 5.456° | 5.418° | ratio 1.007 |
| shadow radius, `ring` `r₀=15` | 9.900° | 9.633° | ratio 1.028 |
| shadow radius, `isco` `r₀=13.5` | 10.984° | 10.672° | ratio 1.029 |
| circularity, 4 axes × 3 presets | ≤ 0.083° spread | isotropic | pass |
| ray outcomes, `classic` | 2.9 % horizon / 15.7 % disc / 81.4 % sky | all three present | pass |
| ray outcomes, `ring` (edge-on) | 13.8 % horizon / 30.6 % disc | disc ≫ face-on | pass |
| rays exhausting the step budget | 0.000 % | 0 % | pass |
| captured fraction, disc on / off | 13.32 % / 13.32 % | identical | pass |
| capture area vs `b_crit` solid angle | ratios 1.11 / 1.17 / 1.13 | ~1 | pass |
| disc evolution over 14 s | 12.96 % | ≫ floor | 10⁸× the floor |
| drift with `flowSpeed=0`, 20 s | 0.000 % | 0 | bit-exact |
| 40 frames, all inputs pinned | 0.000 % | 0 | bit-exact |
| camera basis across a clock jump | identical to 9 d.p. | identical | bit-exact |
| zeroing all light sources (HDR) | max 0.000, mean 0.0000 | 0 | pass |
| Doppler on/off changes the frame | 0.0641 vs 0.0588 | ≠ | pass |
| exposure response | 0.0913 → 0.1705 | ↑ | pass |
| background responds to sky rotation | 70 % HDR delta | ≠ | pass |
| debug views visually distinct | 10/10 histograms | 10 | pass |

</details>

<details>
<summary>Pipeline, interface and recovery checks</summary>

* 5 GPU programs compiled; HDR target is float (`1016` = `HalfFloatType`);
  bloom pyramid allocated with the tier's mip count.
* Frame is not black (mean L 0.17), has real highlights (max 0.92), is not blown
  out, and 78 % of pixels sit in the bottom two histogram bins.
* All 4 presets, all 3 quality tiers and all 10 debug views render.
* 21 sliders, 10 debug buttons, 4 preset buttons, 3 quality buttons; slider
  labels match the parameter table; moving a slider updates the parameter.
* Telemetry renders live values with no `NaN`/`Infinity`/`undefined`.
* Hotkeys `0-9`, `Q`, `H` all change state, and the HUD DOM follows.
* State persists to `localStorage` including the camera pose.
* Context loss raises the overlay; restore rebuilds all five programs, resumes
  the loop on its own, and the frame is valid again.

</details>

## 5. Screenshot gallery — `tests/shots/`

| file | resolution | capture |
|---|---|---|
| `01_classic_1080p.png` | 1920×1080 | canvas |
| `02_photonring_1080p.png` | 1920×1080 | canvas |
| `03_isco_1080p.png` | 1920×1080 | canvas |
| `04_polar_1080p.png` | 1920×1080 | canvas |
| `05_classic_1440p.png` | 2560×1440 | canvas, cinematic tier |
| `06_debug1_hdr.png` | 1280×720 | AOV |
| `07_debug2_cost.png` | 1280×720 | AOV |
| `08_debug4_impact.png` | 1280×720 | AOV |
| `09_debug5_doppler.png` | 1280×720 | AOV |
| `10_debug8_crossings.png` | 1280×720 | AOV |
| `11_debug9_skyonly.png` | 1280×720 | AOV |
| `12_hud_full.png` | 1264×649 | DOM + canvas |
| `13_mobile_portrait.png` | 1264×649 | DOM + canvas, standard tier |
| `14_hot_disc.png` | 1920×1080 | canvas, 17000 K disc |
| `15_running_from_server.png` | 1440×900 | DOM + canvas, the live app over HTTP |
| `00_file_protocol_notice.png` | 1280×800 | the `file://` guard's explanation |

Renders use the page's own documented `canvas.toDataURL()` path. The two HUD
shots go through `Page.captureScreenshot` instead, because a canvas has no DOM —
`toDataURL()` cannot contain interface chrome, by definition.

Every non-DOM capture is **verified, not assumed**: the driver decodes the data
URL back inside the page and reports its mean luminance, and a frame below the
floor fails the run. The SHA-256 prefix of the bytes actually written is printed
alongside, so a stale file on disk can never be mistaken for a fresh capture.
Both of those checks exist because they caught real black frames that a
size-only test happily passed:

```
01_classic_1080p    1920x1080  4183 KB  mean L 0.0610  max 0.856  d71951914b84
02_photonring_1080p 1920x1080  4174 KB  mean L 0.0620  max 0.865  676d145b93b1
03_beaming_1080p    1920x1080  4023 KB  mean L 0.2050  max 0.857  5b30e2f2558c
04_polar_1080p      1920x1080  4041 KB  mean L 0.0369  max 0.861  4dd2c27664fc
05_classic_1440p    2560x1440  7373 KB  mean L 0.0639  max 0.865  0340edfb7a0c
06_debug1_hdr       1280x720    993 KB  mean L 0.7413  max 0.789  02e6f289c1e0
07_debug2_cost      1280x720     79 KB  mean L 0.0955  max 0.759  22ff36375bb1
08_debug4_impact    1280x720     23 KB  mean L 0.0635  max 0.073  1d77e95da220
09_debug5_doppler   1280x720    271 KB  mean L 0.2651  max 0.758  95764cae212b
10_debug8_crossings 1280x720     32 KB  mean L 0.0914  max 0.736  0f453d85a10e
11_debug9_skyonly   1280x720    132 KB  mean L 0.0009  max 1.000  59c4e21bef88
12_hud_full         DOM+canvas  138 KB                             aa853df65a14
13_mobile_portrait  DOM+canvas  110 KB                             c3c7a7a68b91
14_hot_disc         1920x1080  4094 KB  mean L 0.2018  max 0.875  d62eb47a449e
```

`11_debug9_skyonly` is legitimately near-black — it is a starfield with the disc
suppressed — so it is held to a lower floor rather than being excused.

`node tools/imgstat.mjs` decodes the PNGs with `node:zlib` and reports the grade
objectively:

| frame | mean L | std | max L | < 2 % | pure white |
|---|---|---|---|---|---|
| `01_classic_1080p` | 0.061 | 0.087 | 0.856 | 26.1 % | 0.00 % |
| `02_photonring_1080p` | 0.062 | 0.115 | 0.865 | 48.9 % | 0.00 % |
| `03_beaming_1080p` | 0.205 | 0.151 | 0.857 | 9.9 % | 0.00 % |
| `04_polar_1080p` | 0.037 | 0.073 | 0.861 | 56.5 % | 0.00 % |
| `05_classic_1440p` | 0.064 | 0.091 | 0.865 | 25.8 % | 0.00 % |
| `14_hot_disc` | 0.202 | 0.151 | 0.875 | 10.4 % | 0.00 % |
| `11_debug9_skyonly` | 0.0009 | 0.024 | 1.000 | 99.7 % | 0.04 % |

The beauty frames carry no clipped pixels at all while still reaching 0.87 peak
luminance, which is the signature of a properly exposed HDR frame rather than a
blown one. The sky-only AOV is 99.7 % black with a handful of saturated star
cores, exactly as a starfield should measure.

## 6. Defects found and fixed

Twenty-one, all found by the suite or by a user, and all fixed. The ones worth
naming:

* **Near-horizon step size.** With the disc hidden the step limiter relaxed, and
  rays with `b` marginally above `b_crit` were walked across the horizon instead
  of winding back out — the shadow grew ~20 %. Caught by the
  "captured fraction is independent of the disc" assertion, which is a pure
  conservation statement and cannot be satisfied by a broken integrator.
* **`flowSpeed = 0` did not freeze the pattern.** Only the advection phase was
  scaled; the slow restructure term kept running off the unscaled clock.
* **Sky radiance ~30× too high**, washing the shadow out to mid-grey.
* **The sky carried an undocumented time drift**, so nothing was ever
  reproducible even with the clock frozen.
* **The camera rig was never truly static.** With the drift zeroed the roll
  smoothing still called `applyRoll()` every frame and rotated the right/up
  vectors by ~0.2° — invisible to the eye, fatal to a reproducibility test.
* **Ray-termination codes mislabelled the disc.** A single crossing leaves
  transmittance ≈ 3 × 10⁻³, above the 1.5 × 10⁻³ cut, so every disc-stopped ray
  was reported as untouched sky.
* **`shot=` inherited the persisted debug view.** Leaving debug 9 selected wrote
  `debug: 9` to `localStorage`, and every later capture loaded it — two frames in
  the gallery came out black through a completely different code path. The
  capture path now forces `debug = 0` unless the URL says otherwise.
* **`canvas.toDataURL()` raced the compositor.** With the WebGL default
  (`preserveDrawingBuffer: false`) the drawing buffer is cleared once the
  compositor has taken the frame, so the documented capture interface usually won
  that race and occasionally did not. In the automation path only, the buffer is
  now preserved.

The rest were load failures, GLSL ES 3.00 migration errors, a texture bound
before three.js realised it, a probe that left a render target bound,
`readPixels` into the wrong typed array, additive grain lifting the black point,
gamma-lifted debug palettes, and a context recovery that left the loop stopped.
The two capture defects above were found *only* because the driver started
verifying the pixels it received instead of the file size it wrote.

### The one a user found first

Opening `index.html` from disk hung on "compiling geodesic integrator…" forever.
Reproduced with `tools/bootcheck.mjs`, which loads a URL in a real browser and
reports the boot state, every console line, every exception and every failed
request:

```
loading file:///D:/DSH/003/index.html
  "booted": false,
  "bootLogText": "compiling geodesic integrator…",
  "hasGargantua": false,
--- failed requests (1) ---
  Script net::ERR_FAILED <file:///D:/DSH/003/src/main.js>
--- exceptions (2) ---
  Access to script at 'file:///D:/DSH/003/src/main.js' from origin 'null' has
  been blocked by CORS policy...
```

Browsers refuse to load ES modules from `file://`, so `src/main.js` never ran —
and every diagnostic I had built lived *inside* that module, so none of them
could fire. The fix is an inline **classic** script, which runs precisely when
the modules are what failed: it detects the protocol, explains the problem and
prints the command and URL, in English and Chinese. A 15-second watchdog covers
the other ways boot can stall.

`tools/bootcheck.mjs` is now part of the kit, because "does it open?" deserves a
one-command answer:

```
node tools/bootcheck.mjs http://127.0.0.1:8099/
  "booted": true,  "bootLogText": "ready",  failed requests (0), exceptions (0)

node tools/bootcheck.mjs file:///D:/DSH/003/index.html
  "booted": false, "bootLogText": "startup halted"   <- and the user is told why
```

## 7. Known limitations

* At the closest preset (`r₀ = 13.5`) the measured shadow radius runs 2.9 %
  large; at `r₀ = 27` it is 0.7 %. The half-pixel boundary bias is corrected for;
  the remainder is the step limiter being most conservative where the observer
  sits closest to the photon sphere.
* The capture-area test carries a wide band (ratio 0.85–1.45) on purpose: it is
  the coarse integrated cross-check. The sharp statement of the same physics is
  the shadow-edge measurement, held to 7 %.
* The ambient score is synthesised, not a recording. See `assets/music/README.md`
  for how to swap in a file.
* No frame-rate figure is claimed here: the suite runs under `--headless=new`
  with software-scheduled frames, which is not representative. The quality
  governor and resolution scaler exist precisely so that the real frame rate is
  handled on whatever GPU is present.
