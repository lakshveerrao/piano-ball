/* Generative music driven by what the dog is doing with the ball (see motion.js):
 *
 *   still / idle  -> silence (sounding notes are damped)
 *   rolling       -> tin tin tin: a metal chime every quarter turn, faster roll = faster + higher
 *   thrown        -> rising chimes in the air, a bright cluster on landing (louder for harder hits)
 *   biting        -> piano: each chomp plays a note (velocity = bite strength), harder chewing =
 *                    denser melody, twisting the ball raises the register, plus bass and chords
 *
 * Every pitch comes from the selected scale and strong beats snap to chord tones, so the
 * result stays consonant whatever the dog does. */
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  /* ------------------------------------------------------------------ theory */

  const SCALES = {
    majorPent:  { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    minorPent:  { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    yo:         { name: 'Japanese Yo',      steps: [0, 2, 5, 7, 9] },
    major:      { name: 'Major',            steps: [0, 2, 4, 5, 7, 9, 11] },
    minor:      { name: 'Natural minor',    steps: [0, 2, 3, 5, 7, 8, 10] },
    dorian:     { name: 'Dorian',           steps: [0, 2, 3, 5, 7, 9, 10] },
    lydian:     { name: 'Lydian',           steps: [0, 2, 4, 6, 7, 9, 11] },
    mixolydian: { name: 'Mixolydian',       steps: [0, 2, 4, 5, 7, 9, 10] },
  };

  // Heptatonic scales: scale-degree roots, triads stacked in thirds.
  const DEGREE_PROGRESSIONS = {
    major: [0, 4, 5, 3],        // I  V  vi IV
    minor: [0, 5, 2, 6],        // i  VI III VII
    dorian: [0, 3, 6, 3],       // i  IV VII IV
    lydian: [0, 1, 4, 1],       // I  II V  II
    mixolydian: [0, 6, 3, 0],   // I  VII IV I
  };
  // Pentatonic scales: explicit chord shapes (semitones above the key), all inside the scale.
  const PC_PROGRESSIONS = {
    majorPent: [[0, 4, 7], [9, 0, 4], [2, 7, 9], [7, 2, 4]],
    minorPent: [[0, 3, 7], [3, 7, 10], [5, 10, 0], [10, 3, 5]],
    yo:        [[2, 5, 9], [0, 5, 9], [7, 0, 2], [0, 7, 2]],
  };

  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  function scalePcs(scale, key) {
    return SCALES[scale].steps.map((s) => (s + key) % 12);
  }

  /** All MIDI notes of the scale in [lo, hi]. */
  function scaleNotes(scale, key, lo, hi) {
    const pcs = new Set(scalePcs(scale, key));
    const out = [];
    for (let m = lo; m <= hi; m++) if (pcs.has(((m % 12) + 12) % 12)) out.push(m);
    return out;
  }

  /** Chords of the progression as pitch-class arrays, root first. */
  function progression(scale, key) {
    if (PC_PROGRESSIONS[scale]) return PC_PROGRESSIONS[scale].map((c) => c.map((s) => (s + key) % 12));
    const steps = SCALES[scale].steps, L = steps.length;
    return DEGREE_PROGRESSIONS[scale].map((d) => [0, 2, 4, 6].map((k) => (steps[(d + k) % L] + key) % 12));
  }

  /** Place pitch classes as a close voicing inside [lo, lo+12). */
  function voice(pcs, lo) {
    return pcs.map((pc) => lo + ((((pc - lo) % 12) + 12) % 12)).sort((a, b) => a - b);
  }

  function nearestOf(list, m) {
    let best = list[0];
    for (const x of list) if (Math.abs(x - m) < Math.abs(best - m)) best = x;
    return best;
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ------------------------------------------------------------------ composer */

  class Composer {
    constructor(piano, motion, opts = {}) {
      this.piano = piano;
      this.motion = motion;
      this.settings = { scale: 'majorPent', key: 0, tempo: 92, sensitivity: 1 };
      this.random = opts.random || Math.random;
      this.running = false;
      this.step = 0;
      this.nextTime = 0;
      this.chordIdx = 0;
      this.melody = 67;
      this.repeat = 0;
      this.mode = 'still';
      this.biteBar = false;       // bass/chord already played for this biting bar
      this.lastBiteAt = -10;      // audio time biting was last seen
      this.damped = true;
      this.tinPhase = 0;          // degrees rolled since the last "tin"
      this.tinIdx = 0;
      this.tinDir = 1;
      this.lastTinAt = -10;
      this.lastAirAt = -10;
      this.lastImpactAt = -1;
      this.lastChordPush = -1;
      this._rebuild();
    }

    set(opts) {
      Object.assign(this.settings, opts);
      this._rebuild();
    }

    _rebuild() {
      const { scale, key } = this.settings;
      this.pcs = new Set(scalePcs(scale, key));
      this.notes = scaleNotes(scale, key, 36, 98);
      this.melodyNotes = this.notes.filter((m) => m >= 55 && m <= 91);
      this.tinNotes = this.notes.filter((m) => m >= 76 && m <= 96);
      this.chords = progression(scale, key);
      this.chordIdx %= this.chords.length;
      this.melody = nearestOf(this.melodyNotes, this.melody);
      this.tinIdx = clamp(this.tinIdx, 0, this.tinNotes.length - 1);
    }

    get chord() { return this.chords[this.chordIdx]; }
    get stepDur() { return 60 / this.settings.tempo / 4; }   // one 16th

    start() {
      if (this.running) return;
      this.running = true;
      this.nextTime = this.piano.ctx.currentTime + 0.08;
      this._lastTinUpdate = this.piano.ctx.currentTime;
      this._timer = setInterval(() => this._schedule(), 25);
    }

    stop() {
      this.running = false;
      clearInterval(this._timer);
    }

    _schedule() {
      const ctx = this.piano.ctx;
      if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;  // tab was asleep
      while (this.nextTime < ctx.currentTime + 0.12) {
        this.tick(this.step, this.nextTime);
        this.nextTime += this.stepDur;
        this.step++;
      }
      const now = ctx.currentTime;
      this.tin(Math.min(0.1, now - this._lastTinUpdate), now + 0.03);
      this._lastTinUpdate = now;
    }

    _chordTones(lo, hi, useSeventh = false) {
      const pcs = new Set(useSeventh ? this.chord : this.chord.slice(0, 3));
      return this.notes.filter((m) => m >= lo && m <= hi && pcs.has(m % 12));
    }

    _play(m, v, t, d) {
      this.piano.play(m, clamp(v, 0.03, 1), t, d);
    }

    /* ------------------------------------------------ piano: only while the dog bites */

    /** One 16th-note step. Public so tests can drive it deterministically. */
    tick(step, t) {
      const c = this.motion.controls(this.settings.sensitivity);
      this.piano.pan = c.pan;
      this.mode = c.mode;
      const s16 = step % 16, sd = this.stepDur, rnd = this.random;
      const jitter = () => (rnd() - 0.5) * 0.008;

      if (c.mode !== 'biting') {
        this.biteBar = false;
        // resting (or done biting for a moment): damp the strings so the ball goes quiet
        const quietFor = t - this.lastBiteAt;
        const calm = c.mode === 'still' || c.mode === 'idle';
        if (!this.damped && quietFor > (calm ? 0.3 : 0.8)) {
          this.piano.releaseAll(c.mode === 'still' ? 0.25 : 0.4);
          this.damped = true;
        }
        return;
      }
      this.lastBiteAt = t;
      this.damped = false;
      const act = c.bite;

      // harmony moves every bar while the biting goes on
      if (s16 === 0 && this.biteBar && this.lastChordPush < step - 8) this.chordIdx = (this.chordIdx + 1) % this.chords.length;

      // left hand: bass + chord when a bite starts and on each new bar
      if (!this.biteBar || s16 === 0) {
        this.biteBar = true;
        const bass = nearestOf(this._chordTones(36, 52).filter((m) => m % 12 === this.chord[0]), 43);
        this._play(bass, 0.28 + 0.3 * act, t, sd * 15);
        voice(this.chord.slice(0, 3), 55).forEach((m, i) => this._play(m, 0.2 + 0.25 * act, t + 0.018 * i + jitter(), sd * 14));
      }
      if (s16 === 8 && act > 0.4) {
        const fifth = this._chordTones(40, 57).filter((m) => m % 12 === this.chord[2 % this.chord.length]);
        if (fifth.length) this._play(nearestOf(fifth, 48), 0.22 + 0.2 * act, t + jitter(), sd * 7);
      }

      // right hand: harder chewing -> more notes; twisting the ball -> higher
      let every, prob;
      if (act < 0.3) { every = 4; prob = 0.45 + act; }
      else if (act < 0.65) { every = 2; prob = 0.5 + 0.4 * act; }
      else { every = 1; prob = 0.55 + 0.35 * act; }
      if (s16 % every !== 0) return;
      const strong = s16 % 4 === 0;
      if (rnd() > prob + (strong ? 0.2 : 0)) return;
      const note = this._nextMelody(62 + c.spin * 24, strong);
      const vel = 0.3 + 0.45 * act + (strong ? 0.07 : 0) + rnd() * 0.05;
      this._play(note, vel, t + jitter(), sd * every * 1.5);
    }

    _nextMelody(center, strong) {
      const rnd = this.random;
      let idx = this.melodyNotes.indexOf(this.melody);
      if (idx < 0) idx = this.melodyNotes.indexOf(nearestOf(this.melodyNotes, center));
      const pull = clamp((center - this.melody) / 8, -1, 1);
      const r = rnd() * 2 - 1 + pull * 0.8;
      let move = r > 0.55 ? 2 : r > 0.05 ? 1 : r > -0.45 ? -1 : -2;
      if (this.repeat < 1 && Math.abs(r) < 0.08) move = 0;
      idx = clamp(idx + move, 0, this.melodyNotes.length - 1);
      let note = this.melodyNotes[idx];
      const sounding = this.chord.slice(0, 3);
      if (strong) {
        note = nearestOf(this._chordTones(55, 91), note);                 // chord tones on the beat
      } else if (this.chord.length > 3 && sounding.some((pc) => (note - pc + 12) % 12 === 1)) {
        // heptatonic scales: avoid a note a semitone above a chord tone (the classic clash)
        note = this.melodyNotes[clamp(idx + (move >= 0 ? 1 : -1), 0, this.melodyNotes.length - 1)];
        if (sounding.some((pc) => (note - pc + 12) % 12 === 1)) note = nearestOf(this._chordTones(55, 91), note);
      }
      this.repeat = note === this.melody ? this.repeat + 1 : 0;
      this.melody = note;
      return note;
    }

    /** A single bite/chomp: one piano note (a dyad for hard bites), louder the harder the bite. */
    chomp(g) {
      if (!this.running) return;
      const t = this.piano.ctx.currentTime + 0.004;
      g *= this.settings.sensitivity;
      const vel = 0.3 + 0.7 * clamp((g - 0.4) / 2.2, 0, 1);
      this.lastBiteAt = t;
      this.damped = false;
      const note = this._nextMelody(this.melody + (this.random() < 0.5 ? 2 : -2), true);
      this._play(note, vel, t, 0.9);
      if (vel > 0.65) {
        const below = this._chordTones(note - 9, note - 3);
        if (below.length) this._play(below[below.length - 1], vel * 0.75, t + 0.012, 0.9);
      }
    }

    /* ------------------------------------------------ "tin tin tin": rolling and throws */

    _nextTin(center) {
      const n = this.tinNotes.length;
      // a little up-and-down figure, like a music box turning
      if (this.random() < 0.15) this.tinDir = -this.tinDir;
      const target = this.tinNotes.indexOf(nearestOf(this.tinNotes, center));
      if (Math.abs(this.tinIdx - target) > 3) this.tinDir = Math.sign(target - this.tinIdx);
      this.tinIdx += this.tinDir;
      if (this.tinIdx <= 0 || this.tinIdx >= n - 1) { this.tinIdx = clamp(this.tinIdx, 0, n - 1); this.tinDir = -this.tinDir; }
      return this.tinNotes[this.tinIdx];
    }

    /** Called every scheduler pass: one "tin" per quarter turn while rolling, fast rising tins in the air. */
    tin(dt, when) {
      const c = this.motion.controls(this.settings.sensitivity);
      if (c.mode === 'airborne') {
        this.lastAirAt = when;
        if (when - this.lastTinAt >= 0.075) {
          this.tinIdx = Math.min(this.tinNotes.length - 1, this.tinIdx + 1);
          this.piano.chime(this.tinNotes[this.tinIdx], 0.35 + 0.3 * c.spin, when);
          this.lastTinAt = when;
        }
        return;
      }
      if (c.mode !== 'rolling') { this.tinPhase = 0; return; }
      this.tinPhase += c.spinDps * this.settings.sensitivity * dt;
      const minGap = 1 / 16;                                         // at most 16 tins a second
      // schedule every tin that is due, spaced out (the timer can run late in a throttled tab)
      while (this.tinPhase >= 90) {
        const at = Math.max(when, this.lastTinAt + minGap);
        if (at > when + 0.15) { this.tinPhase = 90; break; }
        this.tinPhase -= 90;
        this.piano.chime(this._nextTin(80 + c.spin * 14), 0.3 + 0.5 * c.spin + this.random() * 0.06, at);
        this.lastTinAt = at;
      }
    }

    /* ------------------------------------------------ impacts from the ball */

    impact(g) {
      if (!this.running) return;
      const t = this.piano.ctx.currentTime + 0.004;
      if (t - this.lastImpactAt < 0.06) return;
      this.lastImpactAt = t;
      g *= this.settings.sensitivity;
      const vel = 0.3 + 0.7 * clamp(Math.log(g / 1.5) / Math.log(14 / 1.5), 0, 1);
      const mode = this.motion.controls(this.settings.sensitivity).mode;

      if (mode === 'biting' && t - this.lastAirAt > 0.5) {
        // a hard chomp or a thump while chewing: strummed piano accent
        if (g >= 6 && this.lastChordPush < this.step - 4) {
          this.chordIdx = (this.chordIdx + 1) % this.chords.length;
          this.lastChordPush = this.step;
        }
        this.lastBiteAt = t;
        this.damped = false;
        const top = clamp(this.melody + 5, 64, 91);
        const tones = this._chordTones(top - 12 - Math.round(vel * 10), top).slice(-(2 + Math.round(vel * 3)));
        tones.forEach((m, i) => this._play(m, vel * (0.85 + 0.15 * (i / tones.length)), t + i * 0.013, 1.2 + vel));
        return;
      }
      // bounce / landing: a bright cluster of tins, bigger for harder hits
      const count = 1 + Math.round(vel * 3);
      const top = this.tinNotes.indexOf(nearestOf(this.tinNotes, 84 + vel * 10));
      for (let i = 0; i < count; i++) {
        const m = this.tinNotes[clamp(top - i * 2, 0, this.tinNotes.length - 1)];
        this.piano.chime(m, vel * (1 - i * 0.12), t + i * 0.022);
      }
      this.lastTinAt = t;
    }

    airborne(start) {
      if (start) this.tinIdx = Math.max(0, this.tinIdx - 4);
    }
  }

  PB.theory = { SCALES, NOTE_NAMES, scalePcs, scaleNotes, progression, voice };
  PB.Composer = Composer;
  if (typeof module !== 'undefined' && module.exports) module.exports = PB;
})(typeof window !== 'undefined' ? window : globalThis);
