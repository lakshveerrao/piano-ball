/* Interprets the raw-ish IMU stream: orientation (Mahony-style complementary filter), spin,
 * and a behaviour classifier that decides what the dog is doing with the ball:
 *
 *   still     resting, ~1 g and no rotation                     -> silence
 *   rolling   steady rotation about one axis                    -> "tin tin tin" chimes
 *   airborne  free fall (thrown)                                -> rising chimes
 *   biting    irregular jolts ("chomps") + back-and-forth twist -> piano
 *   idle      small movements that are none of the above        -> silence
 */
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const DEG = Math.PI / 180;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Classifier thresholds (g, deg/s, seconds). Tuned on the simulator; see tests/core.test.js.
  const TH = {
    stillAcc: 0.08, stillGyro: 12, stillFor: 0.5,
    chompG: 0.45, chompEnd: 0.25, chompGap: 0.12,
    biteJolt: 0.2, biteChomps: 2, biteHold: 0.8,
    rollSpin: 50, rollAxis: 0.6, rollHold: 0.3,
    freefallG: 0.35, freefallFor: 0.06,
  };

  class Motion {
    constructor() {
      this.accelLsb = 2048;
      this.gyroLsb = 16.4;
      this.rate = 250;
      this.q = [1, 0, 0, 0];          // body -> world quaternion (w, x, y, z)
      this.acc = [0, 0, 1];           // g
      this.gyro = [0, 0, 0];          // dps
      this.accMag = 1;
      this.gyroMag = 0;
      this.spin = 0;                  // smoothed |w|, dps (fast attack, slow release)
      this.lastSampleAt = 0;
      this.histLen = 1250;            // 5 s at 250 Hz
      this.histAcc = new Float32Array(this.histLen);
      this.histGyro = new Float32Array(this.histLen);
      this.histPos = 0;
      this.marks = [];

      // behaviour features
      this.t = 0;                     // stream time, s
      this.lpA = [0, 0, 1];
      this.jolt = 0;                  // smoothed high-passed |a|, g
      this.wv = [0, 0, 0];            // smoothed rotation vector, dps
      this.wm = 0;                    // smoothed |w|, dps
      this.axis = 0;                  // |mean w| / mean |w|: 1 = steady roll, ~0 = twisting back and forth
      this.stillTime = 0;
      this.chomps = [];               // times of recent chomps
      this.chompPeak = 0;
      this.lastChompT = -10;
      this.inAir = false;             // from the ball's free-fall events
      this._ffLen = 0;
      this._ffLocal = false;
      this.lastAirEnd = -10;
      this.biteUntil = -10;
      this.rollUntil = -10;
      this.mode = 'still';
      this.onChomp = null;            // (strengthG)
      this.onMode = null;             // (mode, previous)
    }

    configure(status) {
      if (status.accelLsbPerG) this.accelLsb = status.accelLsbPerG;
      if (status.gyroLsbPerDps) this.gyroLsb = status.gyroLsbPerDps;
      if (status.sampleRate) this.rate = status.sampleRate;
    }

    setAirborne(on) {
      if (this.inAir && !on) this.lastAirEnd = this.t;
      this.inAir = on;
      this._classify();
    }

    /** samples: Int16Array of [ax ay az gx gy gz]*n raw counts. */
    ingest(samples, periodUs) {
      const dt = (periodUs || 1e6 / this.rate) / 1e6;
      for (let i = 0; i + 5 < samples.length; i += 6) {
        this.step(
          samples[i] / this.accelLsb, samples[i + 1] / this.accelLsb, samples[i + 2] / this.accelLsb,
          samples[i + 3] / this.gyroLsb, samples[i + 4] / this.gyroLsb, samples[i + 5] / this.gyroLsb, dt);
      }
      this.lastSampleAt = now();
    }

    step(ax, ay, az, gx, gy, gz, dt) {
      this.t += dt;
      this.acc[0] = ax; this.acc[1] = ay; this.acc[2] = az;
      this.gyro[0] = gx; this.gyro[1] = gy; this.gyro[2] = gz;
      const am = Math.hypot(ax, ay, az);
      const gm = Math.hypot(gx, gy, gz);
      this.accMag = am;
      this.gyroMag = gm;

      const kUp = 1 - Math.exp(-dt / 0.06), kDown = 1 - Math.exp(-dt / 0.6);
      this.spin += (gm - this.spin) * (gm > this.spin ? kUp : kDown);

      this._features(ax, ay, az, gx, gy, gz, am, gm, dt);
      this._integrate(ax, ay, az, gx * DEG, gy * DEG, gz * DEG, dt, am);

      this.histAcc[this.histPos] = am;
      this.histGyro[this.histPos] = gm;
      this.histPos = (this.histPos + 1) % this.histLen;
    }

    _features(ax, ay, az, gx, gy, gz, am, gm, dt) {
      // high-passed acceleration: jolts and chomps, with gravity and steady spin removed
      const kLp = 1 - Math.exp(-dt / 0.08);
      const hx = ax - this.lpA[0], hy = ay - this.lpA[1], hz = az - this.lpA[2];
      this.lpA[0] += kLp * hx; this.lpA[1] += kLp * hy; this.lpA[2] += kLp * hz;
      const hp = Math.hypot(hx, hy, hz);
      this.jolt += (hp - this.jolt) * (1 - Math.exp(-dt / (hp > this.jolt ? 0.08 : 0.35)));

      // rotation consistency over ~0.4 s
      const kW = 1 - Math.exp(-dt / 0.4);
      this.wv[0] += kW * (gx - this.wv[0]); this.wv[1] += kW * (gy - this.wv[1]); this.wv[2] += kW * (gz - this.wv[2]);
      this.wm += kW * (gm - this.wm);
      this.axis = this.wm > 5 ? Math.hypot(this.wv[0], this.wv[1], this.wv[2]) / this.wm : 0;

      // stillness
      this.stillTime = Math.abs(am - 1) < TH.stillAcc && gm < TH.stillGyro ? this.stillTime + dt : 0;

      // local free-fall fallback (the firmware also sends events)
      if (am < TH.freefallG) { this._ffLen += dt; if (this._ffLen >= TH.freefallFor) this._ffLocal = true; }
      else if (am > 0.6) { if (this._ffLocal) this.lastAirEnd = this.t; this._ffLocal = false; this._ffLen = 0; }

      // chomps: short spikes in the high-passed signal, not caused by a landing
      const airish = this.inAir || this._ffLocal || this.t - this.lastAirEnd < 0.4;
      if (this.chompPeak > 0) {
        this.chompPeak = Math.max(this.chompPeak, hp);
        if (hp < TH.chompEnd) {
          const strength = this.chompPeak;
          this.chompPeak = 0;
          this.chomps.push(this.t);
          this._classify();
          if (this.onChomp && this.mode === 'biting') this.onChomp(strength);
        }
      } else if (hp > TH.chompG && !airish && this.t - this.lastChompT > TH.chompGap) {
        this.chompPeak = hp;
        this.lastChompT = this.t;
      }
      while (this.chomps.length && this.t - this.chomps[0] > 1.2) this.chomps.shift();

      if ((Math.round(this.t * 1000) % 20) < dt * 1000) this._classify();
    }

    _classify() {
      const t = this.t;
      const air = this.inAir || this._ffLocal;
      const twisting = this.axis < TH.rollAxis;
      if (!air && twisting && (this.chomps.length >= TH.biteChomps || this.jolt > TH.biteJolt)) this.biteUntil = t + TH.biteHold;
      if (!air && this.wm > TH.rollSpin && !twisting) this.rollUntil = t + TH.rollHold;

      let mode;
      if (air) mode = 'airborne';
      else if (this.stillTime > TH.stillFor) mode = 'still';
      else if (t < this.rollUntil && this.axis >= TH.rollAxis) mode = 'rolling';
      else if (t < this.biteUntil) mode = 'biting';
      else if (t < this.rollUntil) mode = 'rolling';
      else mode = 'idle';
      if (mode !== this.mode) {
        const prev = this.mode;
        this.mode = mode;
        if (this.onMode) this.onMode(mode, prev);
      }
    }

    _integrate(ax, ay, az, gx, gy, gz, dt, am) {
      let [w, x, y, z] = this.q;
      // Accelerometer correction only when it measures mostly gravity (not during bounces/throws).
      if (am > 0.7 && am < 1.3) {
        const inv = 1 / am; ax *= inv; ay *= inv; az *= inv;
        const vx = 2 * (x * z - w * y), vy = 2 * (w * x + y * z), vz = w * w - x * x - y * y + z * z;
        const ex = ay * vz - az * vy, ey = az * vx - ax * vz, ez = ax * vy - ay * vx;
        const kp = 2.0;
        gx += kp * ex; gy += kp * ey; gz += kp * ez;
      }
      const hdt = 0.5 * dt;
      const nw = w + (-x * gx - y * gy - z * gz) * hdt;
      const nx = x + (w * gx + y * gz - z * gy) * hdt;
      const ny = y + (w * gy - x * gz + z * gx) * hdt;
      const nz = z + (w * gz + x * gy - y * gx) * hdt;
      const n = 1 / Math.hypot(nw, nx, ny, nz);
      this.q[0] = nw * n; this.q[1] = nx * n; this.q[2] = ny * n; this.q[3] = nz * n;
    }

    markImpact(g) {
      this.marks.push({ pos: this.histPos, g, t: now() });
      if (this.marks.length > 40) this.marks.shift();
    }

    /** Rotate a body-frame vector into the world frame. */
    rotate(v) {
      const [w, x, y, z] = this.q;
      const [vx, vy, vz] = v;
      const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
      return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
    }

    /** Musical controls. `sensitivity` ~0.4..2.5. */
    controls(sensitivity = 1) {
      const fresh = now() - this.lastSampleAt < 500;
      const spin = fresh ? Math.min(1, (this.spin * sensitivity) / 900) : 0;       // 900 dps = 2.5 rev/s
      const bite = fresh ? Math.min(1, (this.jolt * sensitivity) / 0.7 * 0.6 + this.chomps.length * 0.12) : 0;
      const pan = fresh ? Math.max(-0.5, Math.min(0.5, this.acc[0] * 0.5)) : 0;
      return { mode: fresh ? this.mode : 'still', spin, spinDps: fresh ? this.spin : 0, bite, pan, fresh };
    }
  }

  PB.Motion = Motion;
  PB.MOTION_THRESHOLDS = TH;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Motion, TH };
})(typeof window !== 'undefined' ? window : globalThis);
