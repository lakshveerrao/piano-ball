#!/usr/bin/env node
/* Mock Piano Ball: serves web/ over HTTP and streams the real binary protocol on /ws from
 * the simulated ball in web/js/sim.js, exactly like the firmware does. No dependencies.
 *
 *   node tools/mock_ball.js [--port 8080] [--no-auto] [--flaky 20]
 *
 *   --no-auto   ball lies still (drowsy after 10 s) instead of playing fetch
 *   --flaky N   drop every connection every N seconds to exercise auto-reconnect
 *
 * A "Put ball to sleep" command makes the mock refuse connections for 6 s and then wake,
 * just like the real ball waking on motion. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../web/js/protocol.js');
const { SimBall } = require('../web/js/sim.js');

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = +arg('--port', 8080);
const AUTO = !args.includes('--no-auto');
const FLAKY = +arg('--flaky', 0);
const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' };

const clients = new Set();
let asleepUntil = 0;

/* ---- minimal RFC 6455 server ---- */
function wsFrame(payload, opcode = 0x2) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, Buffer.from(payload)]);
}

function acceptWs(req, socket) {
  if (Date.now() < asleepUntil) { socket.destroy(); return; }   // asleep: nothing answers
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const client = { socket, buf: Buffer.alloc(0) };
  clients.add(client);
  console.log(`client connected (${clients.size})`);
  send(client, statusFrame());
  socket.on('data', (d) => { client.buf = Buffer.concat([client.buf, d]); parse(client); });
  const drop = () => { if (clients.delete(client)) console.log(`client left (${clients.size})`); };
  socket.on('close', drop);
  socket.on('error', drop);
}

function parse(c) {
  while (c.buf.length >= 2) {
    const op = c.buf[0] & 0x0f, masked = c.buf[1] & 0x80;
    let len = c.buf[1] & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { c.socket.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let data = c.buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) { const m = c.buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ m[i & 3])); }
    c.buf = c.buf.subarray(need);
    if (op === 0x8) { c.socket.end(wsFrame(Buffer.alloc(0), 0x8)); return; }
    if (op === 0x9) { c.socket.write(wsFrame(data, 0xA)); continue; }
    if (op === 0x2) onCommand(c, data);
  }
}

function send(c, bytes) { if (!c.socket.destroyed) c.socket.write(wsFrame(bytes)); }
function broadcast(bytes) { for (const c of clients) send(c, bytes); }

/* ---- the ball ---- */
const ball = new SimBall((frame) => broadcast(frame));
ball.auto = AUTO;
const statusFrame = () => P.encodeStatus({ uptimeMs: ball.t * 1000, batteryMv: 3950, batteryPct: 78, rssi: -52,
  impactThresholdG: ball.config.impactThresholdG, sleepAfterS: ball.config.sleepAfterS, clients: clients.size });

function onCommand(c, data) {
  const cmd = P.decodeCommand(data);
  if (!cmd) return;
  if (cmd.cmd === 'ping') send(c, P.encodePong(cmd.token, ball.t * 1000));
  else if (cmd.cmd === 'config') {
    if (cmd.impactThresholdG != null) ball.config.impactThresholdG = cmd.impactThresholdG;
    if (cmd.sleepAfterS != null) ball.config.sleepAfterS = cmd.sleepAfterS;
    console.log('config', ball.config);
    broadcast(statusFrame());
  } else if (cmd.cmd === 'sleep') {
    console.log('sleep requested: going dark for 6 s');
    broadcast(P.encodeSleep(3));
    asleepUntil = Date.now() + 6000;
    // the real ball's radio just stops: sockets die without a close frame
    setTimeout(() => { for (const cl of clients) cl.socket.destroy(); clients.clear(); }, 150);
  } else if (cmd.cmd === 'wifi') {
    console.log(`wifi set to "${cmd.ssid}" (mock: ignored)`);
  }
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now >= asleepUntil) ball.advance(Math.min(0.1, (now - last) / 1000));
  last = now;
}, 20);

if (FLAKY) setInterval(() => {
  if (clients.size) console.log('flaky: dropping all connections');
  for (const c of clients) c.socket.destroy();
}, FLAKY * 1000);

/* ---- http ---- */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] === '/ws') acceptWs(req, socket);
  else socket.destroy();
});
server.listen(PORT, () => {
  console.log(`Mock Piano Ball on http://localhost:${PORT}  (ws://localhost:${PORT}/ws)` +
    (AUTO ? ', playing fetch' : ', lying still') + (FLAKY ? `, dropping links every ${FLAKY}s` : ''));
});
