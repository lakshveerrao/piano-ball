# Piano Ball wire protocol

WebSocket binary frames on `ws://<ball>/ws`, all little-endian. Defined in
`firmware/main/protocol.h` and mirrored in `web/js/protocol.js` (tested in `tests/core.test.js`).

## Ball → app

| Type | Name | Size | Layout |
|---|---|---|---|
| `0x01` | IMU batch | 12 + 12·n | `u8 type, u8 n, u16 seq, u32 first_index, u16 period_us, u8 state, u8 flags`, then n × `i16 ax ay az gx gy gz` |
| `0x02` | Impact | 14 | `u8 type, u8 duration_samples, u16 seq, u32 onset_index, u16 peak_mg, i8 dx dy dz, u8 _` |
| `0x03` | Free fall | 10 | `u8 type, u8 phase (1 start / 0 end), u16 seq, u32 start_index, u16 airtime_ms` |
| `0x04` | Status | 26 | `u8 type, u8 state, u16 seq, u32 uptime_ms, u16 battery_mv, u8 battery_pct, i8 rssi, u16 sample_rate, u16 accel_lsb_per_g, u16 gyro_lsb_per_dps×10, u8 fw_major, u8 fw_minor, u16 impact_threshold_mg, u16 sleep_after_s, u8 wifi_mode, u8 clients` |
| `0x05` | Going to sleep | 2 | `u8 type, u8 reason (1 still, 2 low battery, 3 requested)` |
| `0x06` | Pong | 8 | `u8 type, u8 _, u16 token, u32 uptime_ms` |

* **IMU samples** are raw sensor counts at 250 Hz: ±16 g (2048 LSB/g) and ±2000 °/s (16.4 LSB/°/s).
  The only processing is the MPU6050's 94/98 Hz low-pass (below the 125 Hz Nyquist) and gyro bias
  removal, which is learned while the ball rests (`flags` bit 0 once it has converged).
  `flags` bit 1 means the sensor FIFO overflowed and samples were lost.
* **Sample indices** count from boot. A gap between `first_index + n` and the next packet's
  `first_index` means lost samples. Every packet holds one contiguous run.
* 5 samples per packet: 50 packets/s, about 3.6 kB/s, 20 ms of batching latency.
* **Impacts** are spikes in high-passed acceleration (gravity and steady spin removed) above the
  threshold. They are sent at most 12 ms after onset, and they skip ahead of queued samples.
* **state**: 0 active, 1 drowsy (still for 10 s: IMU packets pause, status continues at 1 Hz, and
  Wi-Fi uses modem sleep).
* Status goes out on connect, once a second, and after every change.

## App → ball

| Type | Name | Layout |
|---|---|---|
| `0x10` | Ping | `u8 type, u8 _, u16 token` → Pong |
| `0x11` | Config | `u8 type, u8 _, u16 impact_threshold_mg, u16 sleep_after_s` (`0xFFFF` leaves a field unchanged, `sleep_after_s = 0` means never sleep). Saved to NVS. |
| `0x12` | Sleep now | `u8 type` |
| `0x13` | Wi-Fi | `u8 type, u8 ssid_len, ssid…, u8 pass_len, pass…`. Saved to NVS, then the ball reboots. |
