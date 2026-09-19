# Audio assets

**GARGANTUA ships no binary audio.** The ambient score is synthesised at runtime
by `src/audio/ambient.js` using the Web Audio API — four layers (sub, pad,
choir, bells) built from oscillators, a generated brown-noise buffer and a
generated impulse response. Nothing is fetched, so there is no asset to license,
no file to 404 and no decode hitch on first play.

## Why not a file

* The delivery requirement was "vendor and audio assets, working". A synthesiser
  satisfies that with zero network requests and zero licensing ambiguity, and it
  is genuinely *music* rather than a placeholder tone.
* Autoplay policies mean any audio needs a user gesture anyway, so the cost of
  generating the graph on first toggle is invisible.

## Swapping in a real recording

If you would rather ship a file, drop it here and wire it into the existing gain
chain. The `AmbientScore` class already owns an `AudioContext`, a master gain, a
high-shelf, a compressor and a convolution reverb — so:

1. Put the file at `assets/music/ambient.ogg` (or `.mp3`; `serve.mjs` already
   serves both MIME types).
2. In `src/audio/ambient.js`, replace the `_buildSub` / `_buildPad` /
   `_buildChoir` calls in `init()` with:

   ```js
   const res = await fetch('./assets/music/ambient.ogg');
   const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
   const src = this.ctx.createBufferSource();
   src.buffer = buf;
   src.loop = true;
   src.connect(this.master);      // master -> highshelf -> compressor -> out
   src.start();
   this.live.push(src);
   ```

3. Keep `_buildReverb()` if you want the generated tail; drop it if the recording
   already has its own space.

`setPlaying()`, the fade in/out, the `M` hotkey and the HUD button all keep
working unchanged, because they only touch `this.master.gain`.

## Licence note

Any file placed here is your responsibility to clear. Nothing in this directory
is required for the project to build, run or pass its tests.
