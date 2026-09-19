/**
 * GARGANTUA — progressive quality governor and HDR adaptation.
 *
 * Two independent loops:
 *   1. AUTO-QUALITY — a slow, hysteretic controller. If the 60-frame median
 *      frame time is far from the 60 fps budget it steps the quality tier
 *      (standard <-> high <-> cinematic) at most once every few seconds.
 *   2. RESOLUTION SCALER — a fast per-frame controller that multiplies the
 *      tier's render scale by [minRes, 1]. This is what keeps a 4K Retina
 *      display interactive on a laptop GPU.
 *
 * Plus an eye-adaptation term that nudges exposure toward the luminance the
 * composition "wants", so a face-on view and an edge-on dive grade similarly.
 */

import { QUALITY_ORDER, QUALITY_TIERS } from '../config.js';

const Q = (s) => QUALITY_TIERS[s] || QUALITY_TIERS.high;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Governor {
  constructor(state, { tier, onTierChange } = {}) {
    this.state = state;
    this.tierOf = tier;
    this.onTierChange = onTierChange || (() => {});
    this.times = [];
    this.median = 16.7;
    this.scale = 1.0;
    this.scaleTarget = 1.0;
    this.adapt = 0;
    this.lastSwitch = 0;
    this.samples = 0;
    this.adaptGain = 0.9;
    this.frozen = false;
  }

  reset() {
    this.times.length = 0;
    this.scale = 1.0;
    this.scaleTarget = 1.0;
    this.adapt = 0;
  }

  /** Median of the last N frame times (ms). */
  push(ms) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 4000) return;
    this.times.push(ms);
    if (this.times.length > 60) this.times.shift();
    this.samples++;
    if (this.times.length >= 12 && this.samples % 10 === 0) {
      const s = [...this.times].sort((a, b) => a - b);
      this.median = s[s.length >> 1];
    }
  }

  /**
   * @param {number} dt     seconds since last frame
   * @param {number} now    seconds since boot
   * @param {number} meanLum scene mean luminance (0 if unavailable)
   */
  update(dt, now, meanLum = 0) {
    if (this.frozen) return this.scale;

    /* ---- fast resolution scaler ---- */
    const want = 16.7 / Math.max(this.median, 1e-3);       // 1.0 == exactly 60 fps
    this.scaleTarget = clamp(Math.pow(want, 0.6), 0.5, 1.0);
    const rate = this.scaleTarget < this.scale ? 3.2 : 0.9; // cut fast, recover slowly
    this.scale += (this.scaleTarget - this.scale) * clamp(dt * rate, 0, 1);
    this.scale = clamp(this.scale, 0.5, 1.0);

    /* ---- slow tier switcher (hysteresis, never during the first 2 s) ---- */
    if (this.state.autoQuality && now > 2.0 && this.times.length >= 40
        && now - this.lastSwitch > 3.5) {
      const idx = QUALITY_ORDER.indexOf(this.state.quality);
      if (this.median > 33 && idx > 0
          && this.scale <= Q(this.state).minRes + 0.06) {
        this.onTierChange(QUALITY_ORDER[idx - 1], 'down');
        this.lastSwitch = now; this.times.length = 0;
      } else if (this.median < 13.5 && idx < QUALITY_ORDER.length - 1
                 && this.scale > 0.97) {
        this.onTierChange(QUALITY_ORDER[idx + 1], 'up');
        this.lastSwitch = now; this.times.length = 0;
      }
    }

    /* ---- eye adaptation ---- */
    if (meanLum > 0) {
      const goal = clamp(0.115 / Math.max(meanLum, 1e-5), 0.42, 2.2);
      this.adapt += (goal - this.adapt) * clamp(dt * 0.55, 0, 1);
    }
    return this.scale;
  }

  get adaptation() {
    return clamp(1 + this.adapt * this.adaptGain * 0.55, 1, 2.2);
  }
}
