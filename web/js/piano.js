/* Real-time piano synthesis with the Web Audio API, no samples.
 * Each note: two slightly detuned oscillators (a piano's paired strings) with a hammer-shaped
 * harmonic spectrum that brightens with velocity, a low-pass that closes as the note decays
 * (the defining piano timbre change), two-stage amplitude decay, and a short hammer thump.
 * Master: dynamics compressor + synthetic hall reverb, so nothing ever clips or sounds harsh. */
(function (PB) {
  'use strict';

  const MAX_VOICES = 32;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  class Piano {
    constructor(ctx) {
      this.ctx = ctx;
      this.voices = [];
      this.pan = 0;
      this.onNote = () => {};

      this.input = ctx.createGain();
      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._impulse(3.2, 2.4);
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -20;
      this.comp.knee.value = 18;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.25;
      this.master = ctx.createGain();
      this.tone = ctx.createBiquadFilter();       // gentle top-end roll-off
      this.tone.type = 'lowshelf';
      this.tone.frequency.value = 180;
      this.tone.gain.value = 2;

      this.input.connect(this.dry);
      this.input.connect(this.reverb);
      this.reverb.connect(this.wet);
      this.dry.connect(this.comp);
      this.wet.connect(this.comp);
      this.comp.connect(this.tone);
      this.tone.connect(this.master);
      this.master.connect(ctx.destination);

      this.setVolume(0.7);
      this.setReverb(0.3);
      this._waves = [0, 1, 2, 3].map((b) => this._wave(b / 3));
      this._noise = this._noiseBuffer();
    }

    setVolume(v) { this.master.gain.setTargetAtTime(Math.pow(v, 1.6) * 1.4, this.ctx.currentTime, 0.05); }
    setReverb(v) {
      this.wet.gain.setTargetAtTime(v * 0.9, this.ctx.currentTime, 0.05);
      this.dry.gain.setTargetAtTime(1 - v * 0.35, this.ctx.currentTime, 0.05);
    }

    /** Harmonic spectrum for brightness 0..1 (soft .. hard strike). */
    _wave(bright) {
      const N = 24;
      const real = new Float32Array(N + 1), imag = new Float32Array(N + 1);
      const tilt = 2.3 - 1.25 * bright;
      for (let n = 1; n <= N; n++) {
        let a = 1 / Math.pow(n, tilt);
        // hammer strikes ~1/8 along the string: harmonics near multiples of 8 are weak
        a *= 0.35 + 0.65 * Math.abs(Math.sin((Math.PI * n) / 8));
        if (n === 2) a *= 1.25;
        imag[n] = a;
      }
      return this.ctx.createPeriodicWave(real, imag);
    }

    _noiseBuffer() {
      const len = Math.floor(this.ctx.sampleRate * 0.08);
      const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      return b;
    }

    _impulse(seconds, decay) {
      const rate = this.ctx.sampleRate, len = Math.floor(rate * seconds);
      const b = this.ctx.createBuffer(2, len, rate);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          // darker tail: low-passed noise whose cutoff falls over time
          const k = 0.55 - 0.45 * t;
          lp += k * ((Math.random() * 2 - 1) - lp);
          d[i] = lp * Math.pow(1 - t, decay) * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
        }
      }
      return b;
    }

    /**
     * Play a note.
     * @param midi      MIDI note number
     * @param velocity  0..1
     * @param when      AudioContext time (defaults to now)
     * @param duration  seconds until the damper falls (undefined = let it ring out)
     */
    play(midi, velocity, when, duration) {
      const ctx = this.ctx;
      const t = Math.max(when || 0, ctx.currentTime + 0.002);
      velocity = Math.max(0.02, Math.min(1, velocity));
      const f = mtof(midi);
      if (f > 5000 || f < 25) return;

      this._steal(t);
      const reg = (midi - 60) / 12;                            // octaves from middle C
      const ring = Math.max(0.6, Math.min(9, 3.2 * Math.pow(0.52, reg)));   // low notes ring longer
      const peak = 0.2 * Math.pow(velocity, 1.5) * (1 - 0.1 * reg);

      const out = ctx.createGain();
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-0.8, Math.min(0.8, (midi - 64) / 36 + this.pan));
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.Q.value = 0.4;
      const bright0 = Math.min(16000, f * (2.5 + 16 * velocity * velocity) + 400);
      lpf.frequency.setValueAtTime(bright0, t);
      lpf.frequency.setTargetAtTime(Math.min(bright0, f * 2.2 + 250), t + 0.01, ring * 0.25);

      const env = out.gain;
      env.setValueAtTime(0, t);
      env.linearRampToValueAtTime(peak, t + 0.003);
      env.setTargetAtTime(peak * 0.45, t + 0.003, 0.09);       // prompt sound
      env.setTargetAtTime(0, t + 0.2, ring * 0.45);            // aftersound

      const wave = this._waves[Math.min(3, Math.floor(velocity * 3.99))];
      const detune = 0.6 + 1.6 * Math.random();
      const oscs = [-detune, detune].map((c) => {
        const o = ctx.createOscillator();
        o.setPeriodicWave(wave);
        o.frequency.value = f;
        o.detune.value = c;
        o.connect(lpf);
        return o;
      });

      // hammer thump
      const hn = ctx.createBufferSource();
      hn.buffer = this._noise;
      const hf = ctx.createBiquadFilter();
      hf.type = 'bandpass';
      hf.frequency.value = Math.min(6000, f * 3 + 800);
      hf.Q.value = 0.9;
      const hg = ctx.createGain();
      hg.gain.value = 0.9 * peak * velocity;
      hn.connect(hf); hf.connect(hg); hg.connect(out);

      lpf.connect(out);
      out.connect(pan);
      pan.connect(this.input);

      const voice = { midi, t, out, oscs, end: t + ring * 3.2, released: false };
      oscs.forEach((o) => { o.start(t); o.stop(voice.end + 0.05); });
      hn.start(t);
      if (duration != null) this._release(voice, t + Math.max(0.05, duration));
      oscs[0].onended = () => {
        out.disconnect();
        const i = this.voices.indexOf(voice);
        if (i >= 0) this.voices.splice(i, 1);
      };
      this.voices.push(voice);
      this.onNote(midi, velocity, t);
      return voice;
    }

    /**
     * "Tin": a small struck metal bar (glockenspiel-like). Inharmonic partials of a free bar,
     * a hard click on the attack and a short ring, bright but soft enough never to be shrill.
     */
    chime(midi, velocity, when) {
      const ctx = this.ctx;
      const t = Math.max(when || 0, ctx.currentTime + 0.002);
      velocity = Math.max(0.05, Math.min(1, velocity));
      const f = mtof(midi);
      if (f > 4500) return;
      this.chimes = (this.chimes || []).filter((c) => c.end > ctx.currentTime);
      if (this.chimes.length >= 24) return;              // a roll can't pile up endlessly

      const out = ctx.createGain();
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-0.7, Math.min(0.7, (midi - 86) / 14 + this.pan + (Math.random() - 0.5) * 0.3));
      const level = 0.11 * Math.pow(velocity, 1.3);
      const ring = 0.9 - (midi - 84) * 0.02;             // higher bars ring shorter
      const partials = [[1, 1, ring], [2.756, 0.42 * (0.5 + velocity), ring * 0.4], [5.404, 0.2 * velocity, ring * 0.18], [8.933, 0.1 * velocity, ring * 0.1]];
      let end = t;
      for (const [ratio, amp, decay] of partials) {
        if (f * ratio > 16000) continue;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f * ratio;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level * amp, t + 0.0015);
        g.gain.setTargetAtTime(0, t + 0.0015, decay / 3);
        o.connect(g); g.connect(out);
        o.start(t);
        o.stop(t + decay * 2.4);
        end = Math.max(end, t + decay * 2.4);
      }
      // the "t" of "tin": a very short bright click
      const hn = ctx.createBufferSource();
      hn.buffer = this._noise;
      const hf = ctx.createBiquadFilter();
      hf.type = 'highpass';
      hf.frequency.value = 5000;
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(level * 0.5, t);
      hg.gain.setTargetAtTime(0, t, 0.004);
      hn.connect(hf); hf.connect(hg); hg.connect(out);
      hn.start(t);
      hn.stop(t + 0.05);

      out.connect(pan);
      pan.connect(this.input);
      this.chimes.push({ end });
      setTimeout(() => out.disconnect(), (end - ctx.currentTime + 0.3) * 1000);
      this.onNote(midi, velocity, t);
    }

    _release(v, when, tau = 0.11) {
      if (v.released) return;
      v.released = true;
      v.out.gain.cancelScheduledValues(when);
      v.out.gain.setTargetAtTime(0, when, tau);
      v.end = Math.min(v.end, when + tau * 7);
      v.oscs.forEach((o) => { try { o.stop(v.end + 0.05); } catch (e) {} });
    }

    /** Re-striking a sounding key damps it first; beyond MAX_VOICES the oldest note is damped. */
    _steal(t) {
      const live = this.voices.filter((v) => !v.released || v.end > t);
      if (live.length >= MAX_VOICES) {
        const oldest = live.reduce((a, b) => (a.t < b.t ? a : b));
        this._release(oldest, t, 0.03);
      }
    }

    releaseAll(tau = 0.2) {
      const t = this.ctx.currentTime;
      this.voices.forEach((v) => this._release(v, t, tau));
    }
  }

  PB.Piano = Piano;
  PB.mtof = mtof;
})(window.PB = window.PB || {});
