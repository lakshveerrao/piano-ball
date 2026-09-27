// End-to-end over a real socket: mock ball server <-> WebSocket client (Node's built-in).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const P = require('../web/js/protocol.js');

const PORT = 18000 + Math.floor(Math.random() * 1000);
let proc;

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'mock_ball.js'), '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => d.toString().includes('Mock Piano Ball') && resolve());
    proc.on('exit', () => reject(new Error('mock exited')));
  });
});
test.after(() => proc.kill());

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.packets = [];
    ws.onmessage = (e) => ws.packets.push(P.decode(e.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('connect failed'));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('serves the web app', async () => {
  const html = await (await fetch(`http://localhost:${PORT}/`)).text();
  assert.match(html, /<title>Piano Ball<\/title>/);
  const js = await fetch(`http://localhost:${PORT}/js/composer.js`);
  assert.equal(js.status, 200);
});

test('streams status + 250 Hz IMU data, answers pings, applies config', async () => {
  const ws = await open();
  await wait(1100);
  assert.equal(ws.packets[0].type, 'status', 'hello status first');
  const samples = ws.packets.filter((p) => p.type === 'imu').reduce((s, p) => s + p.count, 0);
  assert.ok(samples > 200 && samples < 300, `~250 samples/s, got ${samples}`);

  ws.send(P.ping(777));
  ws.send(P.config({ impactThresholdG: 3.3 }));
  await wait(200);
  assert.ok(ws.packets.some((p) => p.type === 'pong' && p.token === 777));
  assert.ok(ws.packets.some((p) => p.type === 'status' && p.impactThresholdG === 3.3));
  ws.close();
});

test('sleep: announces, drops the link, refuses while asleep, accepts again on wake', async () => {
  const ws = await open();
  const closed = new Promise((r) => (ws.onclose = r));
  ws.send(P.sleepNow());
  await closed;
  assert.ok(ws.packets.some((p) => p.type === 'sleep' && p.reason === 'requested'));
  await assert.rejects(open(), 'no answer while asleep');
  await wait(6200);
  const again = await open();
  again.close();
});
