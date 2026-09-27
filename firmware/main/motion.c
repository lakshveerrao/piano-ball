/**
 * @file motion.c
 * Per-sample processing at 250 Hz: gyro bias tracking, impact and free-fall detection,
 * stillness timing. The stream itself stays raw-ish: only the gyro bias is removed.
 */
#include "motion.h"

#include <math.h>
#include <string.h>

#include "board_config.h"

#define MS_TO_SAMPLES(ms) ((uint32_t)(ms) * SENSOR_RATE_HZ / 1000)

static struct {
    float bias[3];
    uint32_t bias_samples;           /* still samples folded into the bias estimate */
    float lp[3];                     /* gravity/centripetal low-pass, counts */
    bool lp_init;
    uint32_t still_samples;
    uint16_t threshold_mg;

    bool in_impact;
    motion_impact_t imp;
    uint32_t imp_age;
    bool imp_reported;
    uint32_t refractory_until;

    bool in_ff;
    uint32_t ff_start, ff_len;
} m;

void motion_init(void)
{
    memset(&m, 0, sizeof(m));
    m.threshold_mg = IMPACT_THRESHOLD_MG;
}

void motion_set_impact_threshold(uint16_t mg)
{
    if (mg < 600) mg = 600;
    m.threshold_mg = mg;
}

uint16_t motion_impact_threshold(void) { return m.threshold_mg; }
uint32_t motion_still_ms(void) { return m.still_samples * 1000 / SENSOR_RATE_HZ; }
bool motion_bias_valid(void) { return m.bias_samples >= SENSOR_RATE_HZ; }

static inline int16_t clamp16(float v)
{
    if (v > 32767.f) return 32767;
    if (v < -32768.f) return -32768;
    return (int16_t)lrintf(v);
}

uint8_t motion_process(uint32_t index, const mpu_raw_t *in, imu_sample_t *out,
                       motion_impact_t *impact, motion_freefall_t *ff)
{
    uint8_t ev = 0;
    const float a[3] = {in->ax, in->ay, in->az};
    const float g[3] = {in->gx, in->gy, in->gz};
    const float lsb_g = ACCEL_LSB_PER_G, lsb_dps = GYRO_LSB_PER_DPS_X10 / 10.0f;

    float mag_g = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) / lsb_g;

    /* ---- stillness + gyro bias ---- */
    float gc[3], gmax = 0;
    for (int i = 0; i < 3; i++) {
        gc[i] = g[i] - m.bias[i];
        float v = fabsf(gc[i]) / lsb_dps;
        if (v > gmax) gmax = v;
    }
    float gyro_limit = motion_bias_valid() ? STILL_GYRO_DPS : 25.0f;   /* raw MPU6050 bias can be ~20 dps */
    bool still = fabsf(mag_g - 1.0f) * 1000.f < STILL_ACCEL_MG && gmax < gyro_limit;
    m.still_samples = still ? m.still_samples + 1 : 0;
    if (m.still_samples > MS_TO_SAMPLES(500)) {
        /* Resting: fold gyro into the bias, fast at first, then slowly to follow temperature drift. */
        float alpha = m.bias_samples < SENSOR_RATE_HZ ? 1.0f / (m.bias_samples + 1) : 0.002f;
        for (int i = 0; i < 3; i++) m.bias[i] += alpha * (g[i] - m.bias[i]);
        m.bias_samples++;
    }

    out->ax = in->ax; out->ay = in->ay; out->az = in->az;
    out->gx = clamp16(g[0] - m.bias[0]);
    out->gy = clamp16(g[1] - m.bias[1]);
    out->gz = clamp16(g[2] - m.bias[2]);

    /* ---- impact: spike in high-passed acceleration (removes gravity and steady spin) ---- */
    if (!m.lp_init) {
        memcpy(m.lp, a, sizeof(m.lp));
        m.lp_init = true;
    }
    float hp[3], hp_mag = 0;
    for (int i = 0; i < 3; i++) {
        hp[i] = a[i] - m.lp[i];
        hp_mag += hp[i] * hp[i];
    }
    hp_mag = sqrtf(hp_mag);
    float hp_mg = hp_mag * 1000.f / lsb_g;
    if (!m.in_impact) {
        /* ~80 ms time constant; frozen during an impact so the spike doesn't leak into it */
        for (int i = 0; i < 3; i++) m.lp[i] += 0.05f * (a[i] - m.lp[i]);
    }

    if (!m.in_impact && hp_mg > m.threshold_mg && index >= m.refractory_until) {
        m.in_impact = true;
        m.imp_reported = false;
        m.imp_age = 0;
        memset(&m.imp, 0, sizeof(m.imp));
        m.imp.index = index;
    }
    if (m.in_impact) {
        m.imp_age++;
        if (hp_mg > m.threshold_mg && m.imp.duration < 255) m.imp.duration++;
        if (hp_mg > m.imp.peak_mg) {
            m.imp.peak_mg = hp_mg > 65535.f ? 65535 : (uint16_t)hp_mg;
            float inv = hp_mag > 0 ? 127.f / hp_mag : 0;
            m.imp.dx = (int8_t)(hp[0] * inv);
            m.imp.dy = (int8_t)(hp[1] * inv);
            m.imp.dz = (int8_t)(hp[2] * inv);
        }
        bool falling = hp_mg < m.threshold_mg * 0.5f;
        /* Report as soon as the peak has passed, but never later than a few samples after onset:
         * musical timing matters more than squeezing out the last few milli-g of the peak. */
        if (!m.imp_reported && (falling || m.imp_age > IMPACT_MAX_WAIT_SAMPLES)) {
            *impact = m.imp;
            m.imp_reported = true;
            ev |= EV_IMPACT;
        }
        if (falling) {
            m.in_impact = false;
            m.refractory_until = index + MS_TO_SAMPLES(IMPACT_REFRACTORY_MS);
            memcpy(m.lp, a, sizeof(m.lp));   /* re-seat the baseline after the bounce */
        }
    }

    /* ---- free fall (thrown / bouncing through the air) ---- */
    if (mag_g * 1000.f < FREEFALL_THRESHOLD_MG) {
        m.ff_len++;
        if (!m.in_ff && m.ff_len >= MS_TO_SAMPLES(FREEFALL_MIN_MS)) {
            m.in_ff = true;
            m.ff_start = index - m.ff_len + 1;
            ff->start_index = m.ff_start;
            ff->duration_ms = 0;
            ev |= EV_FF_START;
        }
    } else if (mag_g * 1000.f > FREEFALL_THRESHOLD_MG * 1.7f) {   /* hysteresis */
        if (m.in_ff) {
            ff->start_index = m.ff_start;
            ff->duration_ms = (uint16_t)((index - m.ff_start) * 1000 / SENSOR_RATE_HZ);
            ev |= EV_FF_END;
        }
        m.in_ff = false;
        m.ff_len = 0;
    }
    return ev;
}
