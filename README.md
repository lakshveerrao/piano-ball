# Piano Ball

A dog ball that makes music. An ESP32-C6 and an MPU6050 sealed in the ball stream motion
over Wi-Fi. A plain HTML/CSS/JS page works out what the dog is doing and plays along with the
Web Audio API.

| The ball is… | Sound |
|---|---|
| Resting / moved slightly | **Silence** (sounding notes are damped) |
| Rolling | **"Tin tin tin"**: a metal chime every quarter turn. Faster rolling means faster and higher |
| Thrown | Rising chimes while airborne, then a bright chime cluster on landing, louder for harder hits |
| Being bitten / chewed | **Piano**: each chomp plays a note, louder for harder bites. Vigorous chewing plays more notes, twisting raises the pitch, and bass and chords come in underneath |

The app classifies behaviour from the raw stream (`web/js/motion.js`):

* Rolling is steady rotation about one axis.
* Biting is irregular jolts ("chomps") with back-and-forth twisting.
* Throws come from free fall.
* Still means about 1 g and no rotation.

Every note, piano or chime, comes from the chosen scale, so nothing clashes. A compressor keeps
the output from clipping.

```
firmware/   ESP-IDF firmware (C): sensor, detection, Wi-Fi, WebSocket, sleep
web/        the app: index.html, style.css, js/*.js (no build step, no dependencies)
tools/      mock_ball.js: a fake ball that speaks the real protocol, for testing without hardware
tests/      node --test tests/*.test.js
PROTOCOL.md binary wire format
```

## Try it without hardware

```
node tools/mock_ball.js            # then open http://localhost:8080
node tools/mock_ball.js --flaky 20 # drops the link every 20 s to test reconnection
```

Or open `web/index.html` straight from disk and choose **Demo ball**. Drag the ball to roll it,
tap it to bounce, press T to throw or B to bite, or tick *Play fetch*.

## Hardware

| Part | Connection |
|---|---|
| MPU6050 SDA / SCL | GPIO5 / GPIO0 on ball 1 (I²C, 400 kHz). If the sensor isn't found, the firmware scans the pins and logs where it is |
| MPU6050 INT | GPIO2 (wakes the ball from deep sleep). Without it, set `BOARD_HAS_MPU_INT 0` |
| LiPo + | 100k/100k divider → an ADC pin for the battery gauge (optional; off on ball 1 because GPIO0 is SCL) |

Pins, thresholds and timeouts are all in `firmware/main/board_config.h`. Pad the board and
battery so they can't rattle, because rattling reads as impacts. The ±16 g range covers hard
bounces.

## Firmware

On this laptop, Reason Cybersecurity blocks the Windows compiler, so the firmware is built in
WSL2 (Ubuntu) and flashed from Windows:

```
wsl -d Ubuntu-26.04 -- bash tools/wsl_setup.sh          # once: PlatformIO in WSL (no sudo needed)
wsl -d Ubuntu-26.04 -- bash /mnt/c/Users/ADMIN/piano-ball/tools/wsl_build.sh
powershell -File toolslash.ps1 -Port COM17             # write + boot (USB reset)
python tools/serial_log.py COM17 10                     # watch the boot log
```

On a machine without that antivirus, `powershell -File firmwareuild.ps1 upload` builds and
flashes directly. Use the PlatformIO in `~/.platformio/penv` (6.2+): an older
`python -m platformio` removes the pioarduino platform.

What it does:

* Reads the MPU6050 FIFO at **250 Hz** without jitter. The FIFO buffers up to 340 ms, so Wi-Fi
  stalls don't drop samples.
* Light on-chip filtering only: a 94 Hz low-pass and gyro bias learned at rest. Otherwise the
  counts go out raw so the app can interpret them.
* **Impact** detection on high-passed acceleration, with a refractory period and reporting
  within 12 ms. **Free-fall** detection with airtime.
* **Wi-Fi**: joins home Wi-Fi (`wifi_secrets.h`, or set from the app) and reconnects with
  exponential backoff. If it can't join within 20 s it also opens the `PianoBall-XXXX` setup
  network. Also reachable as `pianoball.local` (mDNS).
* Serves the web app itself at `http://pianoball.local/`, with the stream on `/ws`. TCP_NODELAY
  is on.
* **Power**: after 10 s still the ball goes drowsy (the stream pauses and Wi-Fi uses modem sleep).
  After 60 s still (30 s with nobody connected, and adjustable) it goes into **deep sleep**, with
  the MPU in wake-on-motion cycle mode. Picking the ball up wakes it, and the app reconnects
  by itself. Low battery sends it to sleep early.

### First-time Wi-Fi setup (sealed ball)

1. Power the ball. With no network saved it opens the Wi-Fi network `PianoBall-XXXX`.
2. Join that network and open `http://192.168.4.1`.
3. Under **Ball settings → Ball Wi-Fi**, enter your home network. The ball saves it and reboots.
4. Back on home Wi-Fi, open `http://pianoball.local`.

## The app

Pick **Ball** or **Demo ball**, then press **Start the music** (browsers need a tap before
they'll play audio). Controls cover scale (8 scales, all consonant), key, tempo, volume,
reverb and sensitivity. On the ball itself you can set the impact threshold and sleep timeout,
put it to sleep, and set up Wi-Fi. The connection pill shows Live, Resting, Reconnecting or
Asleep. Settings are remembered per browser.

Open the app from the ball (`http://pianoball.local`) or the mock. An `https://` page can't
open `ws://` connections to your local network.

## Tests

```
node --test tests/*.test.js
```

Covers:

* The protocol byte layout (matching the C structs).
* The behaviour classifier on simulated rest, rolling, biting and throws.
* Sound: silence at rest, tins per quarter turn while rolling, piano only while biting (bite
  strength → velocity), damping after biting, throw and landing chimes, and every note staying
  in scale.
* The firmware detector port, plus a real WebSocket session with the mock (streaming, ping,
  config, sleep and wake).
