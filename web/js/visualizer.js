/* Canvas visualiser: the ball in 3D (orientation from the IMU), impact ripples, 5-second
 * traces of |a| and |w|, and a keyboard whose keys light and release note particles in
 * sync with the audio clock. */
(function (PB) {
  'use strict';

  const LO = 36, HI = 96;                       // keyboard range C2..C7
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const PAWS = [[0.55, -0.55, 0.63], [-0.6, -0.45, -0.66], [0.2, 0.9, 0.38], [-0.7, 0.62, 0.35], [0.1, -0.2, -0.97], [0.75, 0.3, -0.58]];

  class Visualizer {
    constructor(canvas, motion) {
      this.canvas = canvas;
      this.g = canvas.getContext('2d');
      this.motion = motion;
      this.audioCtx = null;
      this.scalePcs = new Set();
      this.pending = [];                        // notes scheduled in the future
      this.keyGlow = new Float32Array(128);
      this.particles = [];
      this.ripples = [];
      this.inAir = false;
      this.lift = 0;
      this.live = false;
      this.mode = 'still';
      this.onSpinGesture = null;               // (axis[3], dps) demo-mode drag
      this.onTapGesture = null;                // () demo-mode tap
      this._readTheme();
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this._readTheme());
      new MutationObserver(() => this._readTheme()).observe(document.documentElement, { attributes: true });
      this._bindPointer();
      const loop = () => { this._frame(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    _readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      this.c = {
        bg: v('--canvas'), ink: v('--ink'), dim: v('--ink-3'), line: v('--line'),
        accent: v('--accent'), accent2: v('--accent-2'), acc: v('--trace-acc'), gyro: v('--trace-gyro'),
        white: v('--key-white'), black: v('--key-black'),
      };
    }

    note(midi, velocity, when) { this.pending.push({ midi, velocity, when }); }
    impact(g) {
      this.ripples.push({ t: performance.now(), g });
      this.motion.markImpact(g);
    }
    chomp(g) { this.ripples.push({ t: performance.now(), g: g * 0.8, bite: true }); }

    _layout() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      const keyH = Math.max(34, Math.min(56, h * 0.12));
      const traceH = Math.max(48, Math.min(90, h * 0.18));
      const top = h - keyH - traceH - 10;
      const r = Math.max(40, Math.min(w * 0.3, top * 0.36));
      return { dpr, w, h, keyH, traceH, keyY: h - keyH, traceY: h - keyH - traceH - 6, cx: w / 2, cy: top * 0.52, r };
    }

    _frame() {
      const L = (this.L = this._layout());
      const g = this.g;
      g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      g.clearRect(0, 0, L.w, L.h);

      const now = this.audioCtx ? this.audioCtx.currentTime : 0;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const n = this.pending[i];
        if (n.when <= now + 0.01) {
          this.pending.splice(i, 1);
          this.keyGlow[n.midi] = Math.max(this.keyGlow[n.midi], 0.4 + n.velocity * 0.6);
          this._spawn(n, L);
        }
      }
      if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);

      this._drawBall(L);
      this._drawParticles(L);
      this._drawTraces(L);
      this._drawKeys(L);
      this._drawMode(L);
      for (let m = 0; m < 128; m++) this.keyGlow[m] *= 0.93;
    }

    /* ---- ball ---- */
    _project(v, L, lift) {
      // world: x right, y away from viewer, z up. Orthographic, slightly from above.
      const tilt = 0.35, c = Math.cos(tilt), s = Math.sin(tilt);
      const y = v[1] * c - v[2] * s, z = v[1] * s + v[2] * c;
      return { x: L.cx + v[0] * L.r, y: L.cy - lift - z * L.r, depth: -y };
    }

    _drawBall(L) {
      const g = this.g, m = this.motion, c = this.c;
      const spinN = Math.min(1, m.spin / 900);
      this.lift += ((this.inAir ? L.r * 0.35 : 0) - this.lift) * 0.15;
      const lift = this.lift;

      // shadow
      g.fillStyle = c.line;
      g.globalAlpha = 0.5 - Math.min(0.3, lift / L.r);
      g.beginPath();
      g.ellipse(L.cx, L.cy + L.r * 1.02, L.r * (0.85 - lift / L.r * 0.3), L.r * 0.13, 0, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;

      // ripples
      const t = performance.now();
      this.ripples = this.ripples.filter((rp) => t - rp.t < 900);
      for (const rp of this.ripples) {
        const k = (t - rp.t) / 900;
        g.strokeStyle = rp.bite ? c.gyro : c.accent;
        g.globalAlpha = (1 - k) * Math.min(1, rp.g / 8 + 0.3);
        g.lineWidth = 2 + Math.min(8, rp.g);
        g.beginPath();
        g.arc(L.cx, L.cy - lift, L.r * (1.05 + k * (0.6 + rp.g / 12)), 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;

      // body
      const flash = this.ripples.length ? Math.max(0, 1 - (t - this.ripples[this.ripples.length - 1].t) / 250) : 0;
      const cy = L.cy - lift;
      const grad = g.createRadialGradient(L.cx - L.r * 0.35, cy - L.r * 0.4, L.r * 0.1, L.cx, cy, L.r);
      grad.addColorStop(0, c.accent2);
      grad.addColorStop(1, c.accent);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(L.cx, cy, L.r, 0, Math.PI * 2);
      g.fill();
      if (!this.live) { g.fillStyle = c.bg; g.globalAlpha = 0.45; g.fill(); g.globalAlpha = 1; }
      if (flash) { g.fillStyle = '#fff'; g.globalAlpha = flash * 0.35; g.fill(); g.globalAlpha = 1; }

      // seams: latitude and longitude lines of the ball, rotated by the live orientation
      g.lineWidth = 1.6;
      g.strokeStyle = c.ink;
      const drawPath = (pts) => {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const d = (a.depth + b.depth) / 2;
          g.globalAlpha = d > 0 ? 0.25 + 0.45 * d : 0.07;
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        }
      };
      for (let lat = -60; lat <= 60; lat += 30) {
        const pts = [], la = (lat * Math.PI) / 180;
        for (let k = 0; k <= 36; k++) {
          const lo = (k / 36) * Math.PI * 2;
          pts.push(this._project(m.rotate([Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]), L, lift));
        }
        drawPath(pts);
      }
      for (let lon = 0; lon < 180; lon += 45) {
        const pts = [], lo = (lon * Math.PI) / 180;
        for (let k = 0; k <= 36; k++) {
          const la = (k / 36) * Math.PI * 2;
          pts.push(this._project(m.rotate([Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]), L, lift));
        }
        drawPath(pts);
      }
      // paw prints
      g.fillStyle = c.ink;
      for (const p of PAWS) {
        const n = Math.hypot(...p);
        const s = this._project(m.rotate([p[0] / n, p[1] / n, p[2] / n]), L, lift);
        if (s.depth <= 0.05) continue;
        g.globalAlpha = 0.55 * s.depth;
        const sz = L.r * 0.09 * (0.5 + 0.5 * s.depth);
        g.beginPath(); g.ellipse(s.x, s.y + sz * 0.3, sz, sz * 0.8, 0, 0, Math.PI * 2); g.fill();
        for (let k = -1.5; k <= 1.5; k++) {
          g.beginPath(); g.arc(s.x + k * sz * 0.62, s.y - sz * (0.95 - Math.abs(k) * 0.18), sz * 0.3, 0, Math.PI * 2); g.fill();
        }
      }
      g.globalAlpha = 1;

      // spin halo
      if (spinN > 0.05) {
        g.strokeStyle = c.accent;
        g.globalAlpha = spinN * 0.6;
        g.lineWidth = 3;
        const a0 = (performance.now() / 1000) * (2 + spinN * 10);
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          g.arc(L.cx, cy, L.r * 1.12, a0 + k * 2.09, a0 + k * 2.09 + 0.5 + spinN);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }

    _drawMode(L) {
      if (!this.live) return;
      const g = this.g, label = { rolling: 'ROLLING · tin tin tin', airborne: 'IN THE AIR', biting: 'BITING · piano' }[this.mode];
      g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      g.fillStyle = label ? this.c.accent : this.c.dim;
      g.fillText(label || 'RESTING · silent', 14, 22);
    }

    /* ---- particles ---- */
    _keyX(midi, L) {
      const whites = [];
      for (let m = LO; m <= HI; m++) if (!BLACK.has(m % 12)) whites.push(m);
      const ww = L.w / whites.length;
      if (!BLACK.has(midi % 12)) return (whites.indexOf(midi) + 0.5) * ww;
      return whites.indexOf(midi - 1) * ww + ww;
    }

    _spawn(n, L) {
      if (n.midi < LO || n.midi > HI) return;
      const hue = ((n.midi % 12) * 7 * 30) % 360;        // circle of fifths colouring
      this.particles.push({
        x: this._keyX(n.midi, L), y: L.keyY, vx: (Math.random() - 0.5) * 0.4, vy: -(1.2 + n.velocity * 2.4),
        r: 2 + n.velocity * 6, hue, life: 1,
      });
      if (this.particles.length > 260) this.particles.shift();
    }

    _drawParticles(L) {
      const g = this.g;
      for (const p of this.particles) {
        p.x += p.vx; p.y += p.vy; p.vy *= 0.985; p.life -= 0.012;
        g.fillStyle = `hsla(${p.hue}, 75%, 60%, ${Math.max(0, p.life) * 0.8})`;
        g.beginPath(); g.arc(p.x, p.y, p.r * (0.6 + p.life * 0.4), 0, Math.PI * 2); g.fill();
      }
      this.particles = this.particles.filter((p) => p.life > 0 && p.y > -20);
    }

    /* ---- traces ---- */
    _drawTraces(L) {
      const g = this.g, m = this.motion, c = this.c;
      const y0 = L.traceY, h = L.traceH, n = m.histLen;
      g.strokeStyle = c.line; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y0 + h); g.lineTo(L.w, y0 + h); g.stroke();
      const plot = (buf, max, color) => {
        g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
        const stride = Math.max(1, Math.floor(n / L.w));
        for (let i = 0; i < n; i += stride) {
          const v = buf[(m.histPos + i) % n];
          const x = (i / n) * L.w, y = y0 + h - Math.min(1, v / max) * h;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      };
      plot(m.histGyro, 2000, c.gyro);
      plot(m.histAcc, 8, c.acc);
      for (const mk of m.marks) {
        const age = (m.histPos - mk.pos + n) % n;
        if (performance.now() - mk.t > 5000) continue;
        const x = L.w * (1 - age / n);
        g.strokeStyle = c.accent; g.globalAlpha = 0.7; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + h); g.stroke();
        g.globalAlpha = 1;
      }
      g.font = '11px ui-sans-serif, system-ui, sans-serif';
      g.fillStyle = c.acc; g.fillText('|a| 0–8 g', 8, y0 + 12);
      g.fillStyle = c.gyro; g.fillText('|ω| 0–2000 °/s', 80, y0 + 12);
    }

    /* ---- keyboard ---- */
    _drawKeys(L) {
      const g = this.g, c = this.c, y = L.keyY, h = L.keyH;
      const whites = [];
      for (let m = LO; m <= HI; m++) if (!BLACK.has(m % 12)) whites.push(m);
      const ww = L.w / whites.length;
      const glow = (m) => this.keyGlow[m];
      whites.forEach((m, i) => {
        g.fillStyle = c.white;
        g.fillRect(i * ww + 0.5, y, ww - 1, h);
        if (glow(m) > 0.02) {
          g.fillStyle = `hsla(${((m % 12) * 210) % 360}, 80%, 58%, ${glow(m)})`;
          g.fillRect(i * ww + 0.5, y, ww - 1, h);
        }
        if (this.scalePcs.has(m % 12)) {
          g.fillStyle = c.dim;
          g.beginPath(); g.arc(i * ww + ww / 2, y + h - 6, 1.6, 0, Math.PI * 2); g.fill();
        }
      });
      for (let m = LO; m <= HI; m++) {
        if (!BLACK.has(m % 12)) continue;
        const x = this._keyX(m, L) - ww * 0.32;
        g.fillStyle = c.black;
        g.fillRect(x, y, ww * 0.64, h * 0.6);
        if (glow(m) > 0.02) {
          g.fillStyle = `hsla(${((m % 12) * 210) % 360}, 80%, 58%, ${glow(m)})`;
          g.fillRect(x, y, ww * 0.64, h * 0.6);
        }
      }
    }

    /* ---- demo-mode gestures on the ball ---- */
    _bindPointer() {
      let down = null, last = null;
      const pos = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
      };
      this.canvas.addEventListener('pointerdown', (e) => {
        if (!this.onSpinGesture) return;
        down = last = pos(e);
        this.canvas.setPointerCapture(e.pointerId);
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!down) return;
        const p = pos(e), dt = Math.max(1, p.t - last.t);
        const dx = p.x - last.x, dy = p.y - last.y;
        const speed = Math.hypot(dx, dy) / dt;                    // px/ms
        if (speed > 0.05 && this.L) {
          // dragging the front of the ball rolls it around the axis perpendicular to the drag
          const dps = Math.min(1800, (speed * 1000 / this.L.r) * 57.3);
          this.onSpinGesture([dy, 0, dx], dps);
        }
        last = p;
      });
      const up = (e) => {
        if (!down) return;
        const p = pos(e);
        if (Math.hypot(p.x - down.x, p.y - down.y) < 8 && p.t - down.t < 350 && this.onTapGesture) this.onTapGesture();
        down = null;
      };
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', up);
    }
  }

  PB.Visualizer = Visualizer;
})(window.PB = window.PB || {});
