/* WebSocket link to the ball: auto-reconnect with backoff, heartbeat pings (RTT),
 * stale-data detection, sleep awareness, and loss statistics. */
(function (PB) {
  'use strict';
  const P = PB.protocol;

  class Link {
    constructor() {
      this.url = null;
      this.ws = null;
      this.state = 'idle';          // idle | connecting | live | stale | asleep | retrying
      this.wanted = false;
      this.retryMs = 500;
      this.lastRx = 0;
      this.rtt = null;
      this.status = null;
      this.onPacket = () => {};
      this.onState = () => {};
      this.stats = { packets: 0, samples: 0, lost: 0, pps: 0, sps: 0 };
      this._nextIndex = null;
      this._pingToken = 0;
      this._pingSent = new Map();
      this._rateWindow = { t: performance.now(), packets: 0, samples: 0 };
      this._timer = setInterval(() => this._tick(), 250);
      this._retryTimer = null;
    }

    connect(url) {
      this.url = url;
      this.wanted = true;
      this.retryMs = 500;
      this._open();
    }

    disconnect() {
      this.wanted = false;
      clearTimeout(this._retryTimer);
      if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
      this._set('idle');
    }

    send(bytes) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(bytes); return true; }
      return false;
    }

    _set(state, info) {
      if (state === this.state && !info) return;
      this.state = state;
      this.onState(state, info || {});
    }

    _open() {
      clearTimeout(this._retryTimer);
      if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) {} }
      if (this.state !== 'asleep') this._set('connecting');
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this._scheduleRetry(); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this._nextIndex = null;
      const openTimeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 4000);
      ws.onopen = () => {
        clearTimeout(openTimeout);
        this.retryMs = 500;
        this.lastRx = performance.now();
        this._set('live');
        this._ping();
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const pkt = P.decode(ev.data);
        if (!pkt) return;
        this.lastRx = performance.now();
        this._account(pkt);
        // stale -> live on fresh data; 'asleep' only ends with a new connection (packets still
        // in flight after the sleep notice must not cancel it)
        if (this.state === 'stale' || this.state === 'connecting') this._set('live');
        this.onPacket(pkt);
      };
      ws.onclose = () => {
        clearTimeout(openTimeout);
        this.ws = null;
        if (this.wanted) this._scheduleRetry();
        else this._set('idle');
      };
      ws.onerror = () => {};   // onclose follows
    }

    _scheduleRetry() {
      // A sleeping ball takes a few seconds to wake and rejoin Wi-Fi: keep a steady retry.
      const delay = this.state === 'asleep' ? 2500 : this.retryMs;
      if (this.state !== 'asleep') this._set('retrying', { inMs: delay });
      this._retryTimer = setTimeout(() => this._open(), delay);
      this.retryMs = Math.min(5000, this.retryMs * 2);
    }

    _account(pkt) {
      this.stats.packets++;
      this._rateWindow.packets++;
      if (pkt.type === 'imu') {
        this.stats.samples += pkt.count;
        this._rateWindow.samples += pkt.count;
        if (this._nextIndex != null && pkt.firstIndex > this._nextIndex) this.stats.lost += pkt.firstIndex - this._nextIndex;
        this._nextIndex = pkt.firstIndex + pkt.count;
      } else if (pkt.type === 'status') {
        this.status = pkt;
      } else if (pkt.type === 'pong') {
        const t0 = this._pingSent.get(pkt.token);
        if (t0 != null) { this.rtt = performance.now() - t0; this._pingSent.delete(pkt.token); }
      } else if (pkt.type === 'sleep') {
        this._set('asleep', { reason: pkt.reason });
      }
    }

    _ping() {
      const token = (this._pingToken = (this._pingToken + 1) & 0xffff);
      this._pingSent.set(token, performance.now());
      if (this._pingSent.size > 8) this._pingSent.delete(this._pingSent.keys().next().value);
      this.send(P.ping(token));
    }

    _tick() {
      const now = performance.now();
      const w = this._rateWindow;
      if (now - w.t >= 1000) {
        this.stats.pps = Math.round((w.packets * 1000) / (now - w.t));
        this.stats.sps = Math.round((w.samples * 1000) / (now - w.t));
        w.t = now; w.packets = 0; w.samples = 0;
        if (this.state === 'live' || this.state === 'stale') this._ping();
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Status arrives at 1 Hz even when the ball is resting, so silence means trouble.
      if (this.state === 'live' && now - this.lastRx > 2500) this._set('stale');
      if (this.state === 'stale' && now - this.lastRx > 6000) this.ws.close();   // force a reconnect
      if (this.state === 'asleep' && now - this.lastRx > 1000) this.ws.close();
    }
  }

  PB.Link = Link;
})(window.PB = window.PB || {});
