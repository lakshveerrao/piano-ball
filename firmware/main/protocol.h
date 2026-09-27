/**
 * @file protocol.h
 * Binary WebSocket protocol, all little-endian. Mirrored in web/js/protocol.js
 * and tools/mock_ball.js - keep all three in sync (docs: PROTOCOL.md).
 */
#pragma once
#include <stdint.h>

/* Ball -> app */
#define PKT_IMU      0x01
#define PKT_IMPACT   0x02
#define PKT_FREEFALL 0x03
#define PKT_STATUS   0x04
#define PKT_SLEEP    0x05
#define PKT_PONG     0x06

/* App -> ball */
#define CMD_PING     0x10
#define CMD_CONFIG   0x11
#define CMD_SLEEP    0x12
#define CMD_WIFI     0x13

/* Ball states */
#define STATE_ACTIVE   0
#define STATE_DROWSY   1
#define STATE_SLEEPING 2

/* IMU flags */
#define IMU_FLAG_BIAS_CORRECTED 0x01
#define IMU_FLAG_OVERFLOW       0x02   /* sensor FIFO overflowed since the last packet (gap in samples) */

typedef struct __attribute__((packed)) {
    int16_t ax, ay, az;   /* ACCEL_LSB_PER_G counts */
    int16_t gx, gy, gz;   /* GYRO_LSB_PER_DPS_X10 / 10 counts, gyro bias removed */
} imu_sample_t;          /* 12 bytes */

typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_IMU */
    uint8_t  count;
    uint16_t seq;
    uint32_t first_index; /* sample counter since boot; gaps = lost samples */
    uint16_t period_us;
    uint8_t  state;
    uint8_t  flags;
    /* imu_sample_t samples[count]; */
} pkt_imu_hdr_t;         /* 12 bytes */

typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_IMPACT */
    uint8_t  duration;    /* samples above threshold (so far) */
    uint16_t seq;
    uint32_t index;       /* sample index of onset */
    uint16_t peak_mg;     /* peak |a| deviation from 1 g, milli-g */
    int8_t   dx, dy, dz;  /* direction of peak acceleration, unit vector * 127 */
    uint8_t  reserved;
} pkt_impact_t;          /* 14 bytes */

typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_FREEFALL */
    uint8_t  phase;       /* 1 = started, 0 = ended */
    uint16_t seq;
    uint32_t index;
    uint16_t duration_ms; /* for phase 0: total airtime */
} pkt_freefall_t;        /* 10 bytes */

typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_STATUS */
    uint8_t  state;
    uint16_t seq;
    uint32_t uptime_ms;
    uint16_t battery_mv;  /* 0 = unknown */
    uint8_t  battery_pct; /* 255 = unknown */
    int8_t   rssi;        /* dBm, 0 in AP mode */
    uint16_t sample_rate_hz;
    uint16_t accel_lsb_per_g;
    uint16_t gyro_lsb_per_dps_x10;
    uint8_t  fw_major, fw_minor;
    uint16_t impact_threshold_mg;
    uint16_t sleep_after_s;   /* 0 = never sleeps */
    uint8_t  wifi_mode;       /* 0 = station, 1 = setup AP, 2 = both */
    uint8_t  clients;
} pkt_status_t;          /* 26 bytes */

typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_SLEEP */
    uint8_t  reason;      /* 1 still, 2 low battery, 3 requested */
} pkt_sleep_t;

typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_PONG */
    uint8_t  reserved;
    uint16_t token;       /* echoed from CMD_PING */
    uint32_t uptime_ms;
} pkt_pong_t;

_Static_assert(sizeof(imu_sample_t) == 12, "imu sample");
_Static_assert(sizeof(pkt_imu_hdr_t) == 12, "imu hdr");
_Static_assert(sizeof(pkt_impact_t) == 14, "impact");
_Static_assert(sizeof(pkt_freefall_t) == 10, "freefall");
_Static_assert(sizeof(pkt_status_t) == 26, "status");
_Static_assert(sizeof(pkt_pong_t) == 8, "pong");

/* Commands:
 *   CMD_PING   [0x10, 0, token u16]
 *   CMD_CONFIG [0x11, 0, impact_threshold_mg u16, sleep_after_s u16]  (0xFFFF = leave unchanged)
 *   CMD_SLEEP  [0x12]
 *   CMD_WIFI   [0x13, ssid_len u8, ssid..., pass_len u8, pass...]      stored in NVS, then reboot
 */
