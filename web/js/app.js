/* App glue: source selection (real ball / demo), audio start, controls, readouts. */
(function (PB) {
  'use strict';
  const P = PB.protocol, T = PB.theory;
  const $ = (id) => document.getElementById(id);

  /* ---- persisted preferences (per browser; everything works without storage) ---- */
  const PREF_KEY = 'pianoball.prefs';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} };

  const motion = new PB.Motion();
  const link = new PB.Link();
  const viz = new PB.Visualizer($('viz'), motion);
  let ctx = null, piano = null, composer = null;
  let mode = null, sim = null, simTimer = null;
  let ballState = 'active', lastHit = null, lastAir = null;

  /* ---- incoming packets (same path for the real ball and the demo) ---- */
  function onPacket(pkt) {
    switch (pkt.type) {
      case 'imu':
        motion.ingest(pkt.samples, pkt.periodUs);
        viz.live = true;
        if (pkt.state !== ballState) setBallState(pkt.state);
        break;
      case 'impact':
        lastHit = pkt.peakG;
        viz.impact(pkt.peakG);
        if (composer) composer.impact(pkt.peakG);
        break;
      case 'freefall':
        viz.inAir = pkt.phase === 'start';
        motion.setAirborne(pkt.phase === 'start');
        if (composer) composer.airborne(pkt.phase === 'start');
        if (pkt.phase === 'end') lastAir = pkt.durationMs;
        break;
      case 'status':
        motion.configure(pkt);
        showStatus(pkt);
        if (pkt.state !== ballState) setBallState(pkt.state);
        else if (mode === 'ball') renderConn();
        break;
      case 'sleep':
        viz.live = false;
        hint('The ball went to sleep (' + pkt.reason + '). Pick it up or roll it to wake it; the app reconnects by itself.');
        break;
    }
  }
  link.onPacket = onPacket;

  const MODE_TEXT = { still: 'Resting', idle: 'Resting', rolling: 'Rolling', airborne: 'Thrown!', biting: 'Being bitten' };
  motion.onChomp = (g) => { viz.chomp(g); if (composer) composer.chomp(g); };
  motion.onMode = (m) => { viz.mode = m; $('sMode').textContent = MODE_TEXT[m] || m; };

  function setBallState(s) {
    ballState = s;
    if (mode === 'ball') renderConn();
    if (s === 'drowsy') hint('Ball is resting, so it stays silent until it moves.');
    else if (s === 'active') hint('');
  }

  /* ---- connection indicator ---- */
  function renderConn() {
    const el = $('conn'), txt = $('connText');
    if (mode === 'demo') { el.dataset.state = 'demo'; txt.textContent = 'Demo ball'; return; }
    const s = link.state;
    el.dataset.state = s;
    const rate = link.status && link.status.sampleRate;
    txt.textContent = {
      idle: 'Not connected',
      connecting: 'Connecting…',
      live: ballState === 'drowsy' ? 'Connected · resting' : 'Live' + (rate ? ' · ' + rate + ' Hz' : ''),
      stale: 'Connected · no data',
      retrying: 'Reconnecting…',
      asleep: 'Ball asleep · waiting to wake',
    }[s] || s;
  }
  link.onState = (s) => {
    renderConn();
    if (s !== 'live' && s !== 'stale') viz.live = false;
    if (s === 'live') hint('');
    if (s === 'retrying' && link.stats.packets === 0) hint('Can’t reach the ball at ' + link.url + '. Retrying…');
    $('connectBtn').textContent = s === 'idle' ? 'Connect' : 'Disconnect';
  };

  function hint(msg) { $('hint').textContent = msg; }

  /* ---- device info ---- */
  function showStatus(s) {
    const b = $('batt');
    if (s.batteryPct != null) {
      b.hidden = false;
      $('battText').textContent = s.batteryPct + '%';
      $('battFill').setAttribute('width', String(Math.max(1, (17 * s.batteryPct) / 100)));
      b.classList.toggle('low', s.batteryPct < 20);
    } else b.hidden = true;
    const rows = [
      ['Firmware', s.fw], ['Wi-Fi', s.wifiMode + (s.rssi ? ' · ' + s.rssi + ' dBm' : '')],
      ['Battery', s.batteryMv ? (s.batteryMv / 1000).toFixed(2) + ' V' : 'not measured'],
      ['Sensor', s.sampleRate ? s.sampleRate + ' Hz' : 'not found'], ['Uptime', fmtUptime(s.uptimeMs)],
      ['Listeners', s.clients],
    ];
    $('devInfo').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    if (document.activeElement !== $('thr')) { $('thr').value = s.impactThresholdG; $('thrOut').textContent = s.impactThresholdG.toFixed(1); }
    if (document.activeElement !== $('sleepAfter')) {
      const sel = $('sleepAfter');
      if (![...sel.options].some((o) => +o.value === s.sleepAfterS)) sel.add(new Option(s.sleepAfterS + ' seconds', s.sleepAfterS));
      sel.value = String(s.sleepAfterS);
    }
  }
  const fmtUptime = (ms) => { const s = Math.floor(ms / 1000); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; };

  /* ---- source: real ball or demo ---- */
  function defaultUrl() {
    if (prefs.url) return prefs.url;
    if (location.protocol === 'http:' && location.host) return 'ws://' + location.host + '/ws';   // served by the ball / mock
    return 'ws://pianoball.local/ws';
  }

  function setMode(m) {
    if (mode === m) return;
    mode = m;
    prefs.mode = m; savePrefs();
    $('tabBall').setAttribute('aria-selected', String(m === 'ball'));
    $('tabDemo').setAttribute('aria-selected', String(m === 'demo'));
    $('paneBall').hidden = m !== 'ball';
    $('paneDemo').hidden = m !== 'demo';
    stopSim();
    if (m === 'demo') {
      link.disconnect();
      startSim();
    } else {
      viz.onSpinGesture = viz.onTapGesture = null;
      viz.live = false;
      hint('');
    }
    renderConn();
  }

  function startSim() {
    sim = new PB.SimBall((frame) => onPacket(P.decode(frame)));
    sim.auto = $('demoAuto').checked;
    sim.config.impactThresholdG = +$('thr').value;
    viz.onSpinGesture = (axis, dps) => sim.spin(axis, dps);
    viz.onTapGesture = () => sim.bounce(3 + Math.random() * 4);
    let last = performance.now();
    simTimer = setInterval(() => {
      const now = performance.now();
      sim.advance(Math.min(0.1, (now - last) / 1000));
      last = now;
    }, 20);
    hint(sim.auto ? '' : 'Drag the ball to roll it, tap it to bounce, B to bite.');
  }
  function stopSim() {
    clearInterval(simTimer);
    sim = null;
  }

  $('tabBall').onclick = () => setMode('ball');
  $('tabDemo').onclick = () => setMode('demo');
  $('connectBtn').onclick = () => {
    if (link.state !== 'idle') { link.disconnect(); return; }
    let url = $('url').value.trim() || defaultUrl();
    if (!/^wss?:\/\//.test(url)) url = 'ws://' + url.replace(/^https?:\/\//, '').replace(/\/$/, '') + (url.includes('/ws') ? '' : '/ws');
    $('url').value = url;
    prefs.url = url; savePrefs();
    if (location.protocol === 'https:' && url.startsWith('ws:')) {
      hint('This page is on https, and browsers block ws:// from it. Open the app from the ball itself: http://pianoball.local');
    }
    link.connect(url);
  };
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { link.disconnect(); $('connectBtn').click(); } });
  $('demoBounce').onclick = () => sim && sim.bounce(3 + Math.random() * 5);
  $('demoThrow').onclick = () => sim && sim.throw(0.4 + Math.random() * 0.6);
  $('demoBite').onclick = () => sim && sim.bite();
  $('demoAuto').onchange = (e) => { if (sim) sim.auto = e.target.checked; hint(''); prefs.auto = e.target.checked; savePrefs(); };
  document.addEventListener('keydown', (e) => {
    if (mode !== 'demo' || !sim || e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); sim.bounce(3 + Math.random() * 5); }
    if (e.key === 't' || e.key === 'T') sim.throw(0.4 + Math.random() * 0.6);
    if (e.key === 'b' || e.key === 'B') sim.bite();
  });

  /* ---- music controls ---- */
  for (const [id, s] of Object.entries(T.SCALES)) $('scale').add(new Option(s.name, id));
  T.NOTE_NAMES.forEach((n, i) => $('key').add(new Option(n, i)));

  const musicInputs = {
    scale: { el: $('scale'), def: 'majorPent' },
    key: { el: $('key'), def: '0' },
    tempo: { el: $('tempo'), def: '92', out: $('tempoOut'), fmt: (v) => v },
    volume: { el: $('volume'), def: '70', out: $('volumeOut'), fmt: (v) => v },
    reverb: { el: $('reverb'), def: '30', out: $('reverbOut'), fmt: (v) => v },
    sens: { el: $('sens'), def: '1', out: $('sensOut'), fmt: (v) => (+v).toFixed(1) },
  };
  function applyMusic() {
    const v = (k) => musicInputs[k].el.value;
    for (const [k, m] of Object.entries(musicInputs)) { if (m.out) m.out.textContent = m.fmt(v(k)); prefs[k] = v(k); }
    savePrefs();
    viz.scalePcs = new Set(T.scalePcs(v('scale'), +v('key')));
    if (composer) composer.set({ scale: v('scale'), key: +v('key'), tempo: +v('tempo'), sensitivity: +v('sens') });
    if (piano) { piano.setVolume(v('volume') / 100); piano.setReverb(v('reverb') / 100); }
  }
  for (const [k, m] of Object.entries(musicInputs)) {
    m.el.value = prefs[k] != null ? prefs[k] : m.def;
    m.el.addEventListener('input', applyMusic);
  }

  function startAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      piano = new PB.Piano(ctx);
      composer = new PB.Composer(piano, motion);
      piano.onNote = (m, v, t) => viz.note(m, v, t);
      viz.audioCtx = ctx;
      applyMusic();
      composer.start();
    }
    ctx.resume();
    $('startBtn').hidden = true;
    $('pauseBtn').disabled = false;
    $('pauseBtn').textContent = 'Pause music';
  }
  $('startBtn').onclick = startAudio;
  $('pauseBtn').onclick = () => {
    if (!ctx) return;
    if (ctx.state === 'running') {
      piano.releaseAll();
      setTimeout(() => ctx.suspend(), 300);
      composer.stop();
      $('pauseBtn').textContent = 'Resume music';
    } else {
      ctx.resume();
      composer.start();
      $('pauseBtn').textContent = 'Pause music';
    }
  };

  /* ---- ball settings ---- */
  let cfgTimer = null;
  function sendConfig(cfg) {
    if (mode === 'demo' && sim) { Object.assign(sim.config, cfg); return; }
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => link.send(P.config(cfg)), 150);
  }
  $('thr').addEventListener('input', (e) => { $('thrOut').textContent = (+e.target.value).toFixed(1); sendConfig({ impactThresholdG: +e.target.value }); });
  $('sleepAfter').addEventListener('change', (e) => sendConfig({ sleepAfterS: +e.target.value }));
  $('sleepNow').onclick = () => {
    if (mode !== 'ball' || !link.send(P.sleepNow())) hint('Connect to the ball first.');
  };
  $('wifiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const ssid = $('wifiSsid').value.trim(), pass = $('wifiPass').value;
    if (mode !== 'ball' || !link.send(P.wifi(ssid, pass))) { $('wifiMsg').textContent = 'Connect to the ball first.'; return; }
    $('wifiMsg').textContent = 'Saved. The ball is rebooting to join “' + ssid + '”. Reconnect your device to that network and open http://pianoball.local';
    $('wifiPass').value = '';
  });

  /* ---- readouts, 4 Hz ---- */
  setInterval(() => {
    $('sSpin').textContent = Math.round((motion.spin / 360) * 60);
    $('sHit').textContent = lastHit == null ? '–' : lastHit.toFixed(1);
    $('sAir').textContent = lastAir == null ? '–' : lastAir;
    const live = mode === 'demo' || link.state === 'live';
    $('sRate').textContent = mode === 'demo' ? 250 : live ? link.stats.sps : 0;
    $('sRtt').textContent = mode === 'demo' ? '0' : link.rtt == null ? '–' : Math.round(link.rtt);
    $('sLost').textContent = mode === 'demo' ? 0 : link.stats.lost;
  }, 250);

  /* ---- boot ---- */
  $('url').value = defaultUrl();
  $('demoAuto').checked = prefs.auto != null ? !!prefs.auto : true;
  applyMusic();
  const servedByBall = location.protocol === 'http:' && !!location.host;
  setMode(prefs.mode || (servedByBall ? 'ball' : 'demo'));
  if (mode === 'ball' && servedByBall) link.connect(defaultUrl());
  renderConn();

  // debug handle for automated checks
  window.pianoBall = { link, motion, viz, get composer() { return composer; }, get sim() { return sim; }, get ctx() { return ctx; }, setMode, startAudio };
})(window.PB);
