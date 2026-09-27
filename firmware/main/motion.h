#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "mpu6050.h"
#include "protocol.h"

#define EV_IMPACT   0x01
#define EV_FF_START 0x02
#define EV_FF_END   0x04

typedef struct {
    uint32_t index;        /* onset sample */
    uint16_t peak_mg;
    int8_t   dx, dy, dz;
    uint8_t  duration;
} motion_impact_t;

typedef struct {
    uint32_t start_index;
    uint16_t duration_ms;
} motion_freefall_t;

void motion_init(void);
void motion_set_impact_threshold(uint16_t mg);
uint16_t motion_impact_threshold(void);

/** Process one sample: removes gyro bias into *out, returns EV_* bits for events it completed. */
uint8_t motion_process(uint32_t index, const mpu_raw_t *in, imu_sample_t *out,
                       motion_impact_t *impact, motion_freefall_t *ff);

/** Milliseconds the ball has been continuously still. */
uint32_t motion_still_ms(void);
bool motion_bias_valid(void);
