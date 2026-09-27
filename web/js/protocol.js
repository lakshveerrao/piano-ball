/* Piano Ball binary protocol (little-endian). Mirrors firmware/main/protocol.h.
 * Works in the browser (window.PB.protocol) and in Node (require). */
(function (root) {
  'use strict';

  const PKT = { IMU: 0x01, IMPACT: 0x02, FREEFALL: 0x03, STATUS: 0x04, SLEEP: 0x05, PONG: 0x06 };
  const CMD = { PING: 0x10, CONFIG: 0x11, SLEEP: 0x12, WIFI: 0x13 };
  const STATE = ['active', 'drowsy', 'sleeping'];
  const SLEEP_REASON = { 1: 'still', 2: 'low battery', 3: 'requested' };
  const SIZES = { IMU_HDR: 12, SAMPLE: 12, IMPACT: 14, FREEFALL: 10, STATUS: 26, SLEEP: 2, PONG: 8 };

  /** Decode one frame (ArrayBuffer / Uint8Array / Node Buffer) into a plain object, or null. */
  function decode(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 2) return null;
    switch (u8[0]) {
      case PKT.IMU: {
        const count = u8[1];
        if (u8.length < SIZES.IMU_HDR + count * SIZES.SAMPLE) return null;
        const samples = new Int16Array(count * 6);
        for (let i = 0; i < count * 6; i++) samples[i] = v.getInt16(SIZES.IMU_HDR + i * 2, true);
        return {
          type: 'imu', count, seq: v.getUint16(2, true), firstIndex: v.getUint32(4, true),
          periodUs: v.getUint16(8, true), state: STATE[u8[10]] || 'active',
          biasCorrected: !!(u8[11] & 1), overflow: !!(u8[11] & 2), samples,
        };
      }
      case PKT.IMPACT:
        if (u8.length < SIZES.IMPACT) return null;
        return {
          type: 'impact', duration: u8[1], seq: v.getUint16(2, true), index: v.getUint32(4, true),
          peakG: v.getUint16(8, true) / 1000, dir: [v.getInt8(10) / 127, v.getInt8(11) / 127, v.getInt8(12) / 127],
        };
      case PKT.FREEFALL:
        if (u8.length < SIZES.FREEFALL) return null;
        return {
          type: 'freefall', phase: u8[1] ? 'start' : 'end', seq: v.getUint16(2, true),
          index: v.getUint32(4, true), durationMs: v.getUint16(8, true),
        };
      case PKT.STATUS:
        if (u8.length < SIZES.STATUS) return null;
        return {
          type: 'status', state: STATE[u8[1]] || 'active', seq: v.getUint16(2, true),
          uptimeMs: v.getUint32(4, true),
          batteryMv: v.getUint16(8, true) || null,
          batteryPct: u8[10] === 255 ? null : u8[10],
          rssi: v.getInt8(11) || null,
          sampleRate: v.getUint16(12, true),
          accelLsbPerG: v.getUint16(14, true),
          gyroLsbPerDps: v.getUint16(16, true) / 10,
          fw: u8[18] + '.' + u8[19],
          impactThresholdG: v.getUint16(20, true) / 1000,
          sleepAfterS: v.getUint16(22, true),
          wifiMode: ['station', 'setup AP', 'station + AP'][u8[24]] || 'station',
          clients: u8[25],
        };
      case PKT.SLEEP:
        return { type: 'sleep', reason: SLEEP_REASON[u8[1]] || 'unknown' };
      case PKT.PONG:
        if (u8.length < SIZES.PONG) return null;
        return { type: 'pong', token: v.getUint16(2, true), uptimeMs: v.getUint32(4, true) };
    }
    return null;
  }

  /* ---- encoders (app -> ball commands, plus ball -> app packets for the simulator/mock) ---- */

  function ping(token) {
    const b = new Uint8Array(4); const v = new DataView(b.buffer);
    b[0] = CMD.PING; v.setUint16(2, token & 0xffff, true); return b;
  }
  function config({ impactThresholdG, sleepAfterS } = {}) {
    const b = new Uint8Array(6); const v = new DataView(b.buffer);
    b[0] = CMD.CONFIG;
    v.setUint16(2, impactThresholdG == null ? 0xffff : Math.round(impactThresholdG * 1000), true);
    v.setUint16(4, sleepAfterS == null ? 0xffff : sleepAfterS, true);
    return b;
  }
  function sleepNow() { return new Uint8Array([CMD.SLEEP]); }
  function wifi(ssid, pass) {
    const enc = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Buffer.from(s, 'utf8'));
    const s = enc(ssid).slice(0, 32), p = enc(pass).slice(0, 63);
    const b = new Uint8Array(3 + s.length + p.length);
    b[0] = CMD.WIFI; b[1] = s.length; b.set(s, 2); b[2 + s.length] = p.length; b.set(p, 3 + s.length);
    return b;
  }

  function encodeImu({ seq, firstIndex, periodUs = 4000, state = 0, flags = 1, samples }) {
    const count = samples.length / 6;
    const b = new Uint8Array(SIZES.IMU_HDR + count * SIZES.SAMPLE); const v = new DataView(b.buffer);
    b[0] = PKT.IMU; b[1] = count; v.setUint16(2, seq & 0xffff, true); v.setUint32(4, firstIndex >>> 0, true);
    v.setUint16(8, periodUs, true); b[10] = state; b[11] = flags;
    for (let i = 0; i < samples.length; i++) v.setInt16(SIZES.IMU_HDR + i * 2, samples[i], true);
    return b;
  }
  function encodeImpact({ seq, index, peakG, dir = [0, 0, 1], duration = 2 }) {
    const b = new Uint8Array(SIZES.IMPACT); const v = new DataView(b.buffer);
    b[0] = PKT.IMPACT; b[1] = duration; v.setUint16(2, seq & 0xffff, true); v.setUint32(4, index >>> 0, true);
    v.setUint16(8, Math.min(65535, Math.round(peakG * 1000)), true);
    for (let i = 0; i < 3; i++) v.setInt8(10 + i, Math.round(Math.max(-1, Math.min(1, dir[i])) * 127));
    return b;
  }
  function encodeFreefall({ seq, index, start, durationMs = 0 }) {
    const b = new Uint8Array(SIZES.FREEFALL); const v = new DataView(b.buffer);
    b[0] = PKT.FREEFALL; b[1] = start ? 1 : 0; v.setUint16(2, seq & 0xffff, true);
    v.setUint32(4, index >>> 0, true); v.setUint16(8, durationMs, true);
    return b;
  }
  function encodeStatus(s) {
    const b = new Uint8Array(SIZES.STATUS); const v = new DataView(b.buffer);
    b[0] = PKT.STATUS; b[1] = s.state || 0; v.setUint16(2, (s.seq || 0) & 0xffff, true);
    v.setUint32(4, s.uptimeMs >>> 0, true); v.setUint16(8, s.batteryMv || 0, true);
    b[10] = s.batteryPct == null ? 255 : s.batteryPct; v.setInt8(11, s.rssi || 0);
    v.setUint16(12, s.sampleRate || 250, true); v.setUint16(14, s.accelLsbPerG || 2048, true);
    v.setUint16(16, s.gyroLsbPerDpsX10 || 164, true); b[18] = 1; b[19] = 0;
    v.setUint16(20, Math.round((s.impactThresholdG || 2.5) * 1000), true);
    v.setUint16(22, s.sleepAfterS == null ? 60 : s.sleepAfterS, true);
    b[24] = s.wifiMode || 0; b[25] = s.clients || 1;
    return b;
  }
  function encodeSleep(reason = 1) { return new Uint8Array([PKT.SLEEP, reason]); }
  function encodePong(token, uptimeMs) {
    const b = new Uint8Array(SIZES.PONG); const v = new DataView(b.buffer);
    b[0] = PKT.PONG; v.setUint16(2, token, true); v.setUint32(4, uptimeMs >>> 0, true); return b;
  }
  /** Decode an app -> ball command (used by the mock ball). */
  function decodeCommand(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    switch (u8[0]) {
      case CMD.PING: return { cmd: 'ping', token: v.getUint16(2, true) };
      case CMD.CONFIG: {
        const t = v.getUint16(2, true), s = v.getUint16(4, true);
        return { cmd: 'config', impactThresholdG: t === 0xffff ? null : t / 1000, sleepAfterS: s === 0xffff ? null : s };
      }
      case CMD.SLEEP: return { cmd: 'sleep' };
      case CMD.WIFI: {
        const sl = u8[1], dec = (a) => (typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(a) : Buffer.from(a).toString());
        return { cmd: 'wifi', ssid: dec(u8.slice(2, 2 + sl)), pass: dec(u8.slice(3 + sl, 3 + sl + u8[2 + sl])) };
      }
    }
    return null;
  }

  const api = {
    PKT, CMD, SIZES, decode, decodeCommand, ping, config, sleepNow, wifi,
    encodeImu, encodeImpact, encodeFreefall, encodeStatus, encodeSleep, encodePong,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.PB = root.PB || {}).protocol = api;
})(typeof window !== 'undefined' ? window : globalThis);
