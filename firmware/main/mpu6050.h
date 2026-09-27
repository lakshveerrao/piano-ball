#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
    int16_t ax, ay, az, gx, gy, gz;
} mpu_raw_t;

/** Probe, reset and configure: 250 Hz, DLPF ~98 Hz, +-16 g, +-2000 dps, FIFO on. */
esp_err_t mpu6050_init(void);

/** Drain whole samples from the FIFO. Returns count read (<= max); *overflow set on FIFO overflow. */
int mpu6050_read_fifo(mpu_raw_t *out, int max, bool *overflow);

/** Low-power accel-only cycle mode with the motion interrupt latched on INT. */
esp_err_t mpu6050_enter_wake_on_motion(uint8_t threshold);

/** Diagnostic: log every I2C device on the configured pins, else search other pin pairs. */
void mpu6050_scan_log(void);

/** After a timer wake: did the motion detector fire while we slept? (reads + clears INT_STATUS) */
bool mpu6050_motion_latched(void);
