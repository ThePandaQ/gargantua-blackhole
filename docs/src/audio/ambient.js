/**
 * GARGANTUA — optional ambient score.
 *
 * The piece is *synthesised*, not sampled: it ships as source code, so there is
 * no binary asset to fetch and nothing that can 404. Four layers are stacked in
 * one master chain:
 *
 *   1. SUB    two detuned sines near 34 Hz plus a fifth, slow tremolo
 *   2. PAD    an open fifth around D2, filtered saw pair, ~20 s filter drift
 *   3. CHOIR  brown noise through a band-pass that breathes at 0.021 Hz
 *   4. BELLS  a sparse generative melody in D Dorian into a convolution reverb
 *
 * Signal graph (all inside the AudioContext):
 *
 *   sub -> subLP -\
 *   pad -> padLP --+-> master(gain) -> highshelf -> compressor -> destination
 *   choir --------/                       ^
 *   bells -> pan -+-> reverb(conv) -------+
 */

const ROOT = 73.42;                         // D2
const DORIAN = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 19, 21, 22];

export class AmbientScore {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.playing = false;
    this.error = null;
    this.master = null;
    this.reverb = null;
    this.live = [];                          // oscillators / sources / gains to tear down
    this.nextBell = 0;
    this.volume = 0.5;
  }

  get state() { return !this.ready ? 'uninitialised' : this.ctx.state; }

  async init() {
    if (this.ready) return true;
    if (this.error) return false;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API unavailable');
      const ctx = new AC({ latencyHint: 'playback' });
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = 0.0001;
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf'; shelf.frequency.value = 4200; shelf.gain.value = -6;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 22; comp.ratio.value = 5;
      comp.attack.value = 0.05; comp.release.value = 0.6;
      master.connect(shelf); shelf.connect(comp); comp.connect(ctx.destination);
      this.master = master;

      this._buildSub();
      this._buildPad();
      this._buildChoir();
      this._buildReverb();

      this.ready = true;
      return true;
    } catch (e) {
      this.error = e;
      this.ready = false;
      return false;
    }
  }

  /* ------------------------------------------------------------ builders */
  _track(node) { this.live.push(node); return node; }

  _osc(type, freq, dest, gain, detune = 0) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = ctx.createGain(); g.gain.value = gain;
    o.connect(g); g.connect(dest);
    o.start();
    this._track(o); this._track(g);
    return o;
  }

  _lfo(freq, depth, param, offset = null) {
    const ctx = this.ctx;
    const l = ctx.createOscillator();
    l.type = 'sine'; l.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = depth;
    if (offset !== null) {
      const o = ctx.createConstantSource(); o.offset.value = offset;
      o.connect(param); o.start(); this._track(o);
    }
    l.connect(g); g.connect(param);
    l.start();
    this._track(l); this._track(g);
    return l;
  }

  _buildSub() {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 190; lp.Q.value = 0.7;
    lp.connect(this.master);
    this._osc('sine', 34.0, lp, 0.80);
    this._osc('sine', 34.35, lp, 0.52, 6.0);
    this._osc('sine', 51.90, lp, 0.20, -4.0);          // fifth
    this._lfo(0.043, 0.10, lp.gain, 0.24);
  }

  _buildPad() {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 620; lp.Q.value = 1.3;
    const pan = ctx.createStereoPanner(); pan.pan.value = -0.18;
    lp.connect(pan); pan.connect(this.master);
    this._lfo(0.019, 260, lp.frequency, 640);
    [0, 7, 12, 10, 15].forEach((semi, i) => {
      const f = ROOT * Math.pow(2, semi / 12) * (i === 3 ? 2 : 1);
      this._osc('sawtooth', f, lp, 0.030 / (1 + i * 0.24), (i - 2) * 7);
    });
  }

  _buildChoir() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 480; bp.Q.value = 2.6;
    const g = ctx.createGain(); g.gain.value = 0.28;
    const pan = ctx.createStereoPanner(); pan.pan.value = 0.22;
    src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(this.master);
    src.start();
    this._lfo(0.021, 210, bp.frequency, 500);
    this._lfo(0.037, 0.09, g.gain, 0.30);
    this._track(src); this._track(bp); this._track(g); this._track(pan);
  }

  _buildReverb() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 3.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.7);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.60;
    conv.connect(wet); wet.connect(this.master);
    this.reverb = conv;
    this._track(conv); this._track(wet);
  }

  /* ------------------------------------------------- generative melody */
  _scheduleBells(now) {
    const ctx = this.ctx;
    let guard = 0;
    while (this.nextBell < now + 2.0 && guard++ < 4) {
      const t = Math.max(this.nextBell, now + 0.05);
      const semi = DORIAN[(Math.random() * DORIAN.length) | 0];
      const oct = Math.random() < 0.32 ? 2 : 1;
      const f = ROOT * 4 * Math.pow(2, semi / 12) * oct;
      const o = ctx.createOscillator();
      o.type = Math.random() < 0.5 ? 'sine' : 'triangle';
      o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.004);
      const g = ctx.createGain();
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.8;
      const dur = 3.4 + Math.random() * 4.6;
      const amp = 0.05 + Math.random() * 0.045;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(pan);
      pan.connect(this.reverb);
      pan.connect(this.master);
      o.start(t); o.stop(t + dur + 0.25);
      o.onended = () => { try { o.disconnect(); g.disconnect(); pan.disconnect(); } catch (e) { /* ignore */ } };
      this.nextBell = t + 2.6 + Math.random() * 7.5;
    }
  }

  /* --------------------------------------------------------------- api */
  async setPlaying(on) {
    if (on) {
      if (!this.ready && !(await this.init())) return false;
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (e) { /* needs a gesture */ }
      }
      if (this.ctx.state !== 'running') return false;
      this.playing = true;
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 2.2);
      this.nextBell = this.ctx.currentTime + 1.4;
      return true;
    }
    this.playing = false;
    if (this.ready && this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.9);
    }
    return true;
  }

  async toggle() { return this.setPlaying(!this.playing); }

  tick() {
    if (!this.playing || !this.ready) return;
    if (this.ctx.state !== 'running') return;
    this._scheduleBells(this.ctx.currentTime);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ready && this.playing) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.35);
    }
  }

  dispose() {
    try {
      if (this.playing) this.setPlaying(false);
      this.live.forEach((n) => {
        try { if (n.stop) n.stop(); } catch (e) { /* ignore */ }
        try { n.disconnect(); } catch (e) { /* ignore */ }
      });
      this.live = [];
      if (this.ctx) this.ctx.close();
    } catch (e) { /* ignore */ }
    this.ready = false;
    this.playing = false;
  }
}
