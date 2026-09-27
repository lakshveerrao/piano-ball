// node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/js/protocol.js');
const PB = require('../web/js/composer.js');
const { SimBall, Detector } = require('../web/js/sim.js');

/* ---------------------------------------------------------------- protocol */

test('IMU packet round-trips and matches the firmware layout', () => {
  const samples = [100, -200, 2048, 16, -16, 32767, -32768, 0, 1, 2, 3, 4];
  const b = P.encodeImu({ seq: 65535, firstIndex: 123456, samples, state: 1, flags: 3 });
  assert.equal(b.length, 12 + 2 * 12);          // sizeof(pkt_imu_hdr_t) + 2 * sizeof(imu_sample_t)
  assert.deepEqual([...b.slice(0, 2)], [0x01, 2]);
  const d = P.decode(b.buffer);
  assert.equal(d.type, 'imu');
  assert.equal(d.seq, 65535);
  assert.equal(d.firstIndex, 123456);
  assert.equal(d.periodUs, 4000);
  assert.equal(d.state, 'drowsy');
  assert.ok(d.biasCorrected && d.overflow);
  assert.deepEqual([...d.samples], samples);
});

test('event, status, pong and sleep packets decode', () => {
  const imp = P.decode(P.encodeImpact({ seq: 7, index: 99, peakG: 6.25, dir: [0, -1, 0.5] }));
  assert.equal(imp.type, 'impact');
  assert.equal(imp.peakG, 6.25);
  assert.ok(Math.abs(imp.dir[1] + 1) < 0.01 && Math.abs(imp.dir[2] - 0.5) < 0.01);

  const ff = P.decode(P.encodeFreefall({ seq: 1, index: 5, start: false, durationMs: 640 }));
  assert.deepEqual([ff.type, ff.phase, ff.durationMs], ['freefall', 'end', 640]);

  const st = P.encodeStatus({ uptimeMs: 5000, batteryMv: 3900, batteryPct: 70, rssi: -60, impactThresholdG: 3, sleepAfterS: 120 });
  assert.equal(st.length, 26);                   // sizeof(pkt_status_t)
  const s = P.decode(st);
  assert.equal(s.sampleRate, 250);
  assert.equal(s.accelLsbPerG, 2048);
  assert.equal(s.gyroLsbPerDps, 16.4);
  assert.equal(s.impactThresholdG, 3);
  assert.equal(s.sleepAfterS, 120);
  assert.equal(s.rssi, -60);

  assert.equal(P.decode(P.encodePong(42, 1000)).token, 42);
  assert.equal(P.decode(P.encodeSleep(2)).reason, 'low battery');
  assert.equal(P.decode(new Uint8Array([0x01, 5, 0])), null, 'truncated packets are rejected');
});

test('commands encode to the byte layout firmware expects', () => {
  assert.deepEqual([...P.ping(0x1234)], [0x10, 0, 0x34, 0x12]);
  assert.deepEqual([...P.config({ impactThresholdG: 2.5 })], [0x11, 0, 0xc4, 0x09, 0xff, 0xff]);
  assert.deepEqual([...P.sleepNow()], [0x12]);
  const w = P.wifi('home', 'secret');
  assert.deepEqual([...w.slice(0, 2)], [0x13, 4]);
  assert.deepEqual(P.decodeCommand(w), { cmd: 'wifi', ssid: 'home', pass: 'secret' });
});

/* ---------------------------------------------------------------- simulator + detector */

function collect(fn, seconds) {
  const events = [];
  const ball = new SimBall((f) => events.push(P.decode(f)));
  fn(ball);
  ball.advance(seconds);
  return events;
}

test('simulated stream runs at 250 Hz with contiguous sample indices', () => {
  const ev = collect(() => {}, 2);
  const imu = ev.filter((e) => e.type === 'imu');
  assert.equal(imu.reduce((s, p) => s + p.count, 0), 500);
  for (let i = 1; i < imu.length; i++) assert.equal(imu[i].firstIndex, imu[i - 1].firstIndex + imu[i - 1].count);
  const acc = imu[10].samples;
  assert.ok(Math.abs(Math.hypot(acc[0], acc[1], acc[2]) / 2048 - 1) < 0.1, 'resting ball reads 1 g');
});

test('detector reports bounces with their strength and ignores rolling', () => {
  const quiet = collect((b) => b.spin([1, 0, 0], 900), 3).filter((e) => e.type === 'impact');
  assert.equal(quiet.length, 0, 'rolling fast is not an impact');
  const hit = collect((b) => b.bounce(6), 0.5).filter((e) => e.type === 'impact');
  assert.equal(hit.length, 1);
  assert.ok(hit[0].peakG > 4.5 && hit[0].peakG < 8, `peak ${hit[0].peakG}`);
});

test('a throw produces free-fall start/end with the airtime, then a landing impact', () => {
  const ev = collect((b) => b.throw(0.6), 2.5);
  const ff = ev.filter((e) => e.type === 'freefall');
  assert.equal(ff[0].phase, 'start');
  const end = ff.find((e) => e.phase === 'end');
  // 0.6 m up and down: 2 * sqrt(2h/g) = 700 ms
  assert.ok(end.durationMs > 600 && end.durationMs < 760, `airtime ${end.durationMs}`);
  const landing = ev.filter((e) => e.type === 'impact' && e.index > end.index);
  assert.ok(landing.length >= 1 && landing[0].peakG > 5, 'lands with a thump');
});

test('ball goes drowsy (stops streaming samples) after 10 s still, like the firmware', () => {
  const ev = collect(() => {}, 12);
  const lastImu = ev.filter((e) => e.type === 'imu').pop();
  assert.ok(lastImu.firstIndex < 10.2 * 250);
  assert.equal(ev.filter((e) => e.type === 'status').pop().state, 'drowsy');
});

test('detector refractory period stops one bounce counting twice', () => {
  const d = new Detector();
  const hits = [];
  for (let i = 0; i < 100; i++) {
    const spike = i === 10 || i === 11 || i === 14 ? 5 : 0;   // one ringing bounce
    d.process(i, [0, 0, 1 + spike], (k, e) => k === 'impact' && hits.push(e));
  }
  assert.equal(hits.length, 1);
});

/* ---------------------------------------------------------------- behaviour + music */

const { Motion } = require('../web/js/motion.js');

/** Run the simulated ball through the real Motion classifier (as the app does). */
function simulate(setup, seconds, onStep) {
  const motion = new Motion();
  motion.lastSampleAt = Infinity;                 // tests run faster than real time: always "fresh"
  const modes = {};
  const chomps = [];
  motion.onChomp = (g) => chomps.push(g);
  const ball = new SimBall((f) => {
    const p = P.decode(f);
    if (p.type === 'imu') motion.ingest(p.samples, p.periodUs);
    if (p.type === 'freefall') motion.setAirborne(p.phase === 'start');
  });
  setup(ball);
  const steps = Math.round(seconds / 0.02);
  for (let i = 0; i < steps; i++) {
    ball.advance(0.02);
    modes[motion.mode] = (modes[motion.mode] || 0) + 1;
    if (onStep) onStep(motion, ball, i * 0.02);
  }
  for (const k in modes) modes[k] /= steps;
  return { modes, chomps, motion };
}

test('classifier: a resting ball is still', () => {
  const { modes } = simulate(() => {}, 3);
  assert.ok(modes.still > 0.75, JSON.stringify(modes));
});

test('classifier: a rolling ball is rolling (never biting)', () => {
  const { modes } = simulate((b) => b.spin([1, 0.3, 0], 700), 2.5);
  assert.ok(modes.rolling > 0.8, JSON.stringify(modes));
  assert.ok(!modes.biting, JSON.stringify(modes));
});

test('classifier: a chewed ball is biting, with chomps reported', () => {
  for (let run = 0; run < 5; run++) {
    const { modes, chomps } = simulate((b) => b.bite(4), 4);
    assert.ok(modes.biting > 0.7, JSON.stringify(modes));
    assert.ok(!modes.rolling || modes.rolling < 0.1, JSON.stringify(modes));
    assert.ok(chomps.length >= 5, `chomps ${chomps.length}`);
  }
});

test('classifier: a thrown ball is airborne, rolls after landing, then settles to still', () => {
  const seen = [];
  simulate((b) => b.throw(0.7), 9, (m) => { if (seen[seen.length - 1] !== m.mode) seen.push(m.mode); });
  assert.ok(seen.includes('airborne'), seen.join(' > '));
  assert.equal(seen[seen.length - 1], 'still', seen.join(' > '));
  assert.ok(!seen.includes('biting'), seen.join(' > '));
});

/** Drive the composer with a scripted mode sequence (fake piano + motion). */
function runComposer({ scale = 'majorPent', key = 0, mode, bite = 0.5, spin = 0.5, seconds = 8, chomps = [], impacts = [] }) {
  const played = [], tins = [];
  const ctx = { currentTime: 0 };
  let released = 0;
  const piano = {
    ctx, pan: 0,
    play: (m, v, t, d) => played.push({ m, v, t }),
    chime: (m, v, t) => tins.push({ m, v, t }),
    releaseAll: () => released++,
  };
  const modeAt = typeof mode === 'function' ? mode : () => mode;
  const motion = { controls: () => ({ mode: modeAt(ctx.currentTime), bite, spin, spinDps: spin * 900, pan: 0, fresh: true }) };
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const c = new PB.Composer(piano, motion, { random });
  c.set({ scale, key, tempo: 100 });
  c.running = true;
  const dt = 0.025;
  let nextStep = 0, step = 0;
  for (let t = 0; t < seconds; t += dt) {
    ctx.currentTime = t;
    while (nextStep < t + 0.12) { c.tick(step++, nextStep); nextStep += c.stepDur; }
    c.tin(dt, t + 0.03);
    chomps.filter((x) => Math.abs(x.t - t) < dt / 2).forEach((x) => c.chomp(x.g));
    impacts.filter((x) => Math.abs(x.t - t) < dt / 2).forEach((x) => c.impact(x.g));
  }
  return { played, tins, released };
}

test('still or idle ball: complete silence', () => {
  for (const mode of ['still', 'idle']) {
    const r = runComposer({ mode });
    assert.equal(r.played.length + r.tins.length, 0, mode);
  }
});

test('rolling: tin chimes only, one per quarter turn, faster when rolling faster', () => {
  const slow = runComposer({ mode: 'rolling', spin: 0.2, seconds: 4 });   // 180 dps -> 2 tins/s
  const fast = runComposer({ mode: 'rolling', spin: 0.8, seconds: 4 });   // 720 dps -> 8 tins/s
  assert.equal(slow.played.length + fast.played.length, 0, 'no piano while rolling');
  assert.ok(Math.abs(slow.tins.length - 8) <= 1, `slow ${slow.tins.length}`);
  assert.ok(Math.abs(fast.tins.length - 32) <= 2, `fast ${fast.tins.length}`);
  const avg = (a) => a.reduce((s, n) => s + n.m, 0) / a.length;
  assert.ok(avg(fast.tins) > avg(slow.tins), 'faster roll sits higher');
  assert.ok(fast.tins.every((n) => n.m >= 76 && n.m <= 96));
});

test('biting: piano only, each chomp plays a note, harder bites louder', () => {
  const r = runComposer({ mode: 'biting', bite: 0.4, seconds: 4,
    chomps: [{ t: 1, g: 0.5 }, { t: 2, g: 2.6 }] });
  assert.equal(r.tins.length, 0, 'no tins while biting');
  assert.ok(r.played.length > 10);
  const at = (t) => r.played.filter((n) => Math.abs(n.t - t) < 0.03);
  const soft = Math.max(...at(1.004).map((n) => n.v)), hard = Math.max(...at(2.004).map((n) => n.v));
  assert.ok(hard > soft + 0.3, `soft ${soft} hard ${hard}`);
});

test('harder chewing plays more piano notes', () => {
  const gentle = runComposer({ mode: 'biting', bite: 0.1 });
  const hard = runComposer({ mode: 'biting', bite: 0.9 });
  assert.ok(hard.played.length > gentle.played.length * 1.8, `${gentle.played.length} -> ${hard.played.length}`);
});

test('bite then rest: piano is damped and the ball goes quiet', () => {
  const r = runComposer({ mode: (t) => (t < 3 ? 'biting' : 'still'), seconds: 6 });
  assert.ok(r.released >= 1, 'damper applied');
  assert.equal(r.played.filter((n) => n.t > 3.2).length, 0, 'nothing new after resting');
});

test('throw: rising tins in the air, landing impact is a tin cluster scaled by strength', () => {
  const r = runComposer({ mode: (t) => (t < 1 ? 'airborne' : 'idle'), seconds: 2, impacts: [{ t: 1.0, g: 9 }] });
  const air = r.tins.filter((n) => n.t < 1.02);
  assert.ok(air.length >= 10, `air tins ${air.length}`);
  assert.ok(air[air.length - 1].m > air[0].m, 'rising');
  const landing = r.tins.filter((n) => n.t > 1.02);
  assert.ok(landing.length >= 3 && landing[0].v > 0.7, 'loud landing cluster');
  assert.equal(r.played.length, 0);
});

test('every piano note and tin stays inside the selected scale, for every scale and key', () => {
  for (const scale of Object.keys(PB.theory.SCALES)) {
    for (const key of [0, 3, 7, 10]) {
      const pcs = new Set(PB.theory.scalePcs(scale, key));
      const modes = ['biting', 'rolling', 'airborne', 'biting', 'still'];
      const r = runComposer({ scale, key, seconds: 10, mode: (t) => modes[Math.floor(t / 2)],
        chomps: [{ t: 0.5, g: 1 }, { t: 7, g: 2.5 }], impacts: [{ t: 4.1, g: 8 }, { t: 6.5, g: 3 }] });
      assert.ok(r.played.length > 20 && r.tins.length > 10, scale);
      for (const n of [...r.played, ...r.tins]) {
        assert.ok(pcs.has(n.m % 12), `${scale}/${key}: ${n.m} outside scale`);
        assert.ok(n.v > 0 && n.v <= 1, 'velocity in range');
      }
    }
  }
});

