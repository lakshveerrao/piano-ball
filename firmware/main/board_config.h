/**
 * @file board_config.h
 * Pin map and tunables for the Piano Ball (ESP32-C6 + MPU6050 in a dog ball).
 * Everything hardware-specific lives here.
 */
#pragma once

/* ---- I2C / MPU6050 ------------------------------------------------------ */
#define BOARD_I2C_PORT            0
#define BOARD_I2C_SDA_GPIO        5       /* ball 1 wiring, found by I2C scan 2026-09-27 */
#define BOARD_I2C_SCL_GPIO        0
#define BOARD_I2C_FREQ_HZ         400000
#define BOARD_I2C_INTERNAL_PULLUPS 1      /* most MPU6050 breakouts already have 4.7k pull-ups */
#define BOARD_MPU_ADDR_PRIMARY    0x68
#define BOARD_MPU_ADDR_FALLBACK   0x69

/* MPU6050 INT pin -> ESP32-C6 LP GPIO (0..7), used to wake from deep sleep on motion.
 * Set BOARD_HAS_MPU_INT to 0 if INT is not wired: the ball then wakes on a timer,
 * peeks at the accelerometer, and goes straight back to sleep if nothing moved. */
#define BOARD_HAS_MPU_INT         1
#define BOARD_MPU_INT_GPIO        2

/* ---- Battery sense: LiPo -> 100k/100k divider -> GPIO0 (ADC1_CH0) -------- */
#define BOARD_HAS_BATTERY_SENSE   0       /* GPIO0 is used by I2C SCL on ball 1 */
#define BOARD_BATTERY_ADC_GPIO    0
#define BOARD_BATTERY_ADC_CHANNEL ADC_CHANNEL_0
#define BOARD_BATTERY_DIVIDER     2.0f

/* ---- Sampling ----------------------------------------------------------- */
#define SENSOR_RATE_HZ            250     /* >= 200 Hz requirement; 1 kHz base / (1+3) */
#define SENSOR_PERIOD_US          (1000000 / SENSOR_RATE_HZ)
#define ACCEL_LSB_PER_G           2048    /* +-16 g: ball impacts easily exceed 8 g */
#define GYRO_LSB_PER_DPS_X10      164     /* +-2000 dps -> 16.4 LSB/dps */
#define BATCH_SAMPLES             5       /* 5 samples/packet -> 50 packets/s, 20 ms latency */

/* ---- Motion detection defaults (runtime-adjustable from the app) -------- */
#define IMPACT_THRESHOLD_MG       2500    /* |a| deviation from 1 g that counts as an impact */
#define IMPACT_REFRACTORY_MS      80
#define IMPACT_MAX_WAIT_SAMPLES   3       /* report at most 12 ms after onset, with the peak so far */
#define FREEFALL_THRESHOLD_MG     350
#define FREEFALL_MIN_MS           60
#define STILL_ACCEL_MG            60      /* |a| within 1 g +- this ... */
#define STILL_GYRO_DPS            8       /* ... and rotation below this = still */

/* ---- Power -------------------------------------------------------------- */
#define DROWSY_AFTER_S            10      /* still this long: stop streaming samples, Wi-Fi modem sleep */
#define SLEEP_AFTER_S             60      /* still this long: deep sleep (default, app can change) */
#define SLEEP_AFTER_NO_CLIENT_S   30      /* shorter when nobody is listening */
#define LOW_BATTERY_MV            3400    /* go to sleep early below this */
#define TIMER_WAKE_S              3       /* only used when BOARD_HAS_MPU_INT == 0 */
#define WAKE_MOTION_THRESHOLD     4       /* MOT_THR, 2 mg/LSB on MPU6050 -> ~8..32 mg depending on die */

/* ---- Network ------------------------------------------------------------ */
#define BALL_ID                   1       /* this ball's name: setup network "PianoBall-1", mDNS "Piano Ball 1" */
#define DEVICE_HOSTNAME           "pianoball"
#define AP_SSID_PREFIX            "PianoBall-"
#define AP_PASSWORD               ""      /* open setup AP; set 8+ chars to secure it */
#define STA_FALLBACK_AP_AFTER_MS  20000   /* no STA link after this long -> also open the setup AP */

#define FW_MAJOR 1
#define FW_MINOR 0
