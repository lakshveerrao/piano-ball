/* Virtual Piano Ball: a small physics model that produces the exact binary stream the real
 * firmware sends (250 Hz raw IMU counts, impact / free-fall events, 1 Hz status). Used by the
 * in-browser demo mode and by tools/mock_ball.js. Includes a JS port of firmware/main/motion.c. */
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol || (typeof require !== 'undefined' ? require('./protocol.js') : null);

  const RATE = 250, DT = 1 / RATE, ACC_LSB = 2048, GYRO_LSB = 16.4;
  const RAD = 180 / Math.PI;
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.8;

  function qmul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
  }
  /** Rotate world vector v into the body frame of orientation q (body->world). */
  function toBody(q, v) {
    const c = [q[0], -q[1], -q[2], -q[3]];
    const r = qmul(qmul(c, [0, v[0], v[1], v[2]]), q);
    return [r[1], r[2], r[3]];
  }

  /* ---- port of firmware motion.c (impact + free fall), fed with g units ---- */
  class Detector {
    constructor() {
      this.threshold = 2.5;
      this.lp = null; this.inImpact = false; this.imp = null; this.age = 0;
      this.reported = false; this.refractoryUntil = 0; this.ffLen = 0; this.inFF = false; this.ffStart = 0;
    }
    process(index, a, emit) {
      const mag = Math.hypot(a[0], a[1], a[2]);
      if (!this.lp) this.lp = a.slice();
      const hp = [a[0] - this.lp[0], a[1] - this.lp[1], a[2] - this.lp[2]];
      const hpm = Math.hypot(hp[0], hp[1], hp[2]);
      if (!this.inImpact) for (let i = 0; i < 3; i++) this.lp[i] += 0.05 * (a[i] - this.lp[i]);
      if (!this.inImpact && hpm > this.threshold && index >= this.refractoryUntil) {
        this.inImpact = true; this.reported = false; this.age = 0;
        this.imp = { index, peakG: 0, dir: [0, 0, 1], duration: 0 };
      }
      if (this.inImpact) {
        this.age++;
        if (hpm > this.threshold) this.imp.duration++;
        if (hpm > this.imp.peakG) { this.imp.peakG = hpm; this.imp.dir = hp.map((x) => x / hpm); }
        const falling = hpm < this.threshold * 0.5;
        if (!this.reported && (falling || this.age > 3)) { emit('impact', this.imp); this.reported = true; }
        if (falling) { this.inImpact = false; this.refractoryUntil = index + 20; this.lp = a.slice(); }
      }
      if (mag < 0.35) {
        this.ffLen++;
        if (!this.inFF && this.ffLen >= 15) { this.inFF = true; this.ffStart = index - this.ffLen + 1; emit('ffstart', { index: this.ffStart }); }
      } else if (mag > 0.6) {
        if (this.inFF) emit('ffend', { index: this.ffStart, durationMs: Math.round(((index - this.ffStart) * 1000) / RATE) });
        this.inFF = false; this.ffLen = 0;
      }
    }
  }

  class SimBall {
    constructor(onFrame) {
      this.onFrame = onFrame || (() => {});
      this.q = [1, 0, 0, 0];
      this.w = [0, 0, 0];          // world angular velocity, rad/s
      this.z = 0; this.vz = 0;     // height (m) and vertical speed for throws/bounces
      this.airborne = false;
      this.pulses = [];            // pending impact force pulses [{n, g, dir}]
      this.index = 0; this.seq = 0; this.t = 0;
      this.batch = [];
      this.detector = new Detector();
      this.config = { impactThresholdG: 2.5, sleepAfterS: 60 };
      this.auto = false; this.autoNext = 0;
      this.stillT = 0; this.state = 0;   // like the firmware: drowsy (no sample stream) after 10 s still
      this._lastStatus = -1;
    }

    /* ---- interactions ---- */
    spin(axis, dps) {
      const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      for (let i = 0; i < 3; i++) this.w[i] = this.w[i] * 0.3 + (axis[i] / n) * (dps / RAD);
    }
    bounce(g = 4) {
      const a = Math.random() * Math.PI * 2, tilt = 0.35;
      this.pulses.push({ n: 3, g, dir: [Math.cos(a) * tilt, Math.sin(a) * tilt, 1] });
      this.spin([Math.random() - 0.5, Math.random() - 0.5, 0], 120 + g * 40);
    }
    /** A dog chewing: irregular chomps (0.6-2.4 g) and head-shake twisting back and forth. */
    bite(seconds = 2 + Math.random() * 2) {
      if (this.airborne) return;
      this.biteUntil = this.t + seconds;
      this.nextChomp = this.t;
      this.twistAxis = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
      this.twistAmp = 120 + Math.random() * 180;
      this.twistHz = 2 + Math.random() * 2;
    }
    throw(height = 0.6) {
      if (this.airborne) return;
      this.pulses.push({ n: 2, g: 3, dir: [0, 0, 1] });
      this.vz = Math.sqrt(2 * 9.81 * height);
      this.airborne = true;
      this.spin([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], 300 + Math.random() * 500);
    }

    /* ---- physics + sensor model, one 4 ms sample ---- */
    _sample() {
      let acc;
      if (this.airborne) {
        this.vz -= 9.81 * DT; this.z += this.vz * DT;
        acc = [gauss() * 0.02, gauss() * 0.02, gauss() * 0.02];     // free fall: ~0 g
        if (this.z <= 0) {
          this.z = 0;
          const speed = -this.vz;
          this.vz = speed * 0.45;                                   // bounce back up, a bit
          this.airborne = this.vz > 1.0;
          this.pulses.push({ n: 3, g: Math.min(15, 1.2 + speed * 2.2), dir: [gauss() * 0.3, gauss() * 0.3, 1] });
        }
      } else if (this.t < (this.biteUntil || 0)) {
        // in the dog's mouth: jostled, twisted back and forth, squeezed by each chomp
        acc = [0, 0, 1].map((g) => g + gauss() * 0.06);
        const n = Math.hypot(...this.twistAxis) || 1;
        const w = (this.twistAmp / RAD) * Math.sin(2 * Math.PI * this.twistHz * this.t);
        for (let i = 0; i < 3; i++) this.w[i] = (this.twistAxis[i] / n) * w;
        if (this.t >= this.nextChomp) {
          const a = Math.random() * Math.PI * 2;
          this.pulses.push({ n: 3, g: 0.6 + Math.random() * 1.8, dir: [Math.cos(a), Math.sin(a), Math.random() - 0.5] });
          this.nextChomp = this.t + 0.18 + Math.random() * 0.3;
        }
        if (this.t + DT >= this.biteUntil) this.w = [0, 0, 0];   // dropped
      } else {
        const rolling = Math.hypot(this.w[0], this.w[1]);
        // rolling on the floor: gravity plus small bumps that grow with speed
        acc = [0, 0, 1].map((g) => g + gauss() * (0.012 + rolling * 0.004));
        const damp = Math.exp(-DT * 0.9);
        for (let i = 0; i < 3; i++) this.w[i] *= damp;
      }
      if (this.pulses.length) {
        const p = this.pulses[0];
        const shape = p.n === 3 ? 1 : p.n === 2 ? 0.8 : 0.35;
        for (let i = 0; i < 3; i++) acc[i] += p.dir[i] * p.g * shape;
        if (--p.n <= 0) this.pulses.shift();
      }
      // integrate orientation
      const wm = Math.hypot(this.w[0], this.w[1], this.w[2]);
      if (wm > 1e-6) {
        const h = (wm * DT) / 2, s = Math.sin(h) / wm;
        this.q = qmul([Math.cos(h), this.w[0] * s, this.w[1] * s, this.w[2] * s], this.q);
        const n = Math.hypot(...this.q); this.q = this.q.map((x) => x / n);
      }
      const ab = toBody(this.q, acc);
      const gb = toBody(this.q, this.w).map((x) => x * RAD + gauss() * 0.15);
      const clampI = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
      const raw = [...ab.map((x) => clampI(x * ACC_LSB)), ...gb.map((x) => clampI(x * GYRO_LSB))];

      this.detector.threshold = this.config.impactThresholdG;
      this.detector.process(this.index, raw.slice(0, 3).map((x) => x / ACC_LSB), (kind, e) => {
        if (kind === 'impact') this.onFrame(P.encodeImpact({ seq: this.seq++, index: e.index, peakG: e.peakG, dir: e.dir, duration: e.duration }));
        else this.onFrame(P.encodeFreefall({ seq: this.seq++, index: e.index, start: kind === 'ffstart', durationMs: e.durationMs || 0 }));
      });
      const still = wm < 8 / RAD && !this.airborne && !this.pulses.length && this.t >= (this.biteUntil || 0);
      this.stillT = still ? this.stillT + DT : 0;
      const state = this.stillT > 10 ? 1 : 0;
      if (state !== this.state) { this.state = state; this._lastStatus = -1; this.batch = []; }
      if (state === 0) this.batch.push(...raw);
      this.index++;
      if (this.batch.length === 5 * 6) {
        this.onFrame(P.encodeImu({ seq: this.seq++, firstIndex: this.index - 5, state, samples: this.batch }));
        this.batch = [];
      }
    }

    /** Advance simulated time by `seconds` (call from a timer). */
    advance(seconds) {
      const n = Math.round(seconds * RATE);
      for (let i = 0; i < n; i++) {
        this._sample();
        this.t += DT;
        if (this.auto) this._autoPlay();
        if (Math.floor(this.t) !== this._lastStatus) {
          this._lastStatus = Math.floor(this.t);
          this.onFrame(P.encodeStatus({
            seq: this.seq++, state: this.state, uptimeMs: this.t * 1000, batteryMv: 3950 - Math.floor(this.t / 60), batteryPct: 78,
            rssi: -52, impactThresholdG: this.config.impactThresholdG, sleepAfterS: this.config.sleepAfterS,
          }));
        }
      }
    }

    /** A dog playing fetch, roughly. */
    _autoPlay() {
      if (this.t < this.autoNext) return;
      const r = Math.random();
      let busy = 1.5 + Math.random() * 2;
      if (r < 0.25) this.spin([Math.random() - 0.5, Math.random() - 0.5, 0], 200 + Math.random() * 900);
      else if (r < 0.45) { const s = 2 + Math.random() * 3; this.bite(s); busy = s + 0.5; }
      else if (r < 0.6) this.throw(0.3 + Math.random() * 0.8);
      else if (r < 0.75) { this.bounce(3); this.spin([1, Math.random(), 0], 500); }
      else busy = 3 + Math.random() * 3;                 // rest: silence
      this.autoNext = this.t + busy;
    }
  }

  PB.SimBall = SimBall;
  PB.SimDetector = Detector;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SimBall, Detector };
})(typeof window !== 'undefined' ? window : globalThis);
