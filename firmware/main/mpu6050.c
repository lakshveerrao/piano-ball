/**
 * @file mpu6050.c
 * MPU6050 over the IDF i2c_master driver, sampled through the on-chip FIFO so the
 * 250 Hz stream is jitter-free and survives Wi-Fi stalls of up to ~340 ms.
 */
#include "mpu6050.h"

#include <string.h>

#include "board_config.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "mpu6050";

#define REG_SMPLRT_DIV   0x19
#define REG_CONFIG       0x1A
#define REG_GYRO_CONFIG  0x1B
#define REG_ACCEL_CONFIG 0x1C
#define REG_MOT_THR      0x1F
#define REG_MOT_DUR      0x20
#define REG_FIFO_EN      0x23
#define REG_INT_PIN_CFG  0x37
#define REG_INT_ENABLE   0x38
#define REG_INT_STATUS   0x3A
#define REG_ACCEL_XOUT_H 0x3B
#define REG_MOT_DET_CTRL 0x69
#define REG_USER_CTRL    0x6A
#define REG_PWR_MGMT_1   0x6B
#define REG_PWR_MGMT_2   0x6C
#define REG_FIFO_COUNTH  0x72
#define REG_FIFO_R_W     0x74
#define REG_WHO_AM_I     0x75

#define FIFO_SAMPLE_BYTES 12   /* accel xyz + gyro xyz */
#define FIFO_SIZE         1024

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;

static esp_err_t wr(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = {reg, val};
    return i2c_master_transmit(s_dev, buf, sizeof(buf), 50);
}

static esp_err_t rd(uint8_t reg, uint8_t *out, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, out, len, 50);
}

static inline int16_t be16(const uint8_t *p) { return (int16_t)((p[0] << 8) | p[1]); }

static esp_err_t attach(void)
{
    if (!s_bus) {
        i2c_master_bus_config_t bus = {
            .i2c_port = BOARD_I2C_PORT,
            .sda_io_num = BOARD_I2C_SDA_GPIO,
            .scl_io_num = BOARD_I2C_SCL_GPIO,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .flags.enable_internal_pullup = BOARD_I2C_INTERNAL_PULLUPS,
        };
        ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus, &s_bus), TAG, "i2c bus");
    }
    if (!s_dev) {
        uint8_t addr = 0;
        const uint8_t candidates[2] = {BOARD_MPU_ADDR_PRIMARY, BOARD_MPU_ADDR_FALLBACK};
        for (int i = 0; i < 2 && !addr; i++) {
            if (i2c_master_probe(s_bus, candidates[i], 20) == ESP_OK) addr = candidates[i];
        }
        if (!addr) {
            ESP_LOGE(TAG, "no MPU6050 at 0x68/0x69 (SDA=%d SCL=%d)", BOARD_I2C_SDA_GPIO, BOARD_I2C_SCL_GPIO);
            return ESP_ERR_NOT_FOUND;
        }
        i2c_device_config_t dev = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = addr,
            .scl_speed_hz = BOARD_I2C_FREQ_HZ,
        };
        ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(s_bus, &dev, &s_dev), TAG, "add dev");
    }
    return ESP_OK;
}

esp_err_t mpu6050_init(void)
{
    ESP_RETURN_ON_ERROR(attach(), TAG, "attach");
    uint8_t who = 0;
    ESP_RETURN_ON_ERROR(rd(REG_WHO_AM_I, &who, 1), TAG, "who_am_i");
    if (who != 0x68 && who != 0x70 && who != 0x72 && who != 0x69) {
        ESP_LOGE(TAG, "unexpected WHO_AM_I 0x%02X", who);
        return ESP_ERR_INVALID_RESPONSE;
    }

    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_1, 0x80), TAG, "reset");
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_1, 0x01), TAG, "wake, PLL gyro X clock");
    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_2, 0x00), TAG, "all axes on");
    /* Light on-chip filtering: DLPF_CFG=2 -> accel 94 Hz / gyro 98 Hz bandwidth, below the
     * 125 Hz Nyquist of the 250 Hz output, so noise is rejected without smearing impacts. */
    ESP_RETURN_ON_ERROR(wr(REG_CONFIG, 0x02), TAG, "dlpf");
    ESP_RETURN_ON_ERROR(wr(REG_SMPLRT_DIV, (1000 / SENSOR_RATE_HZ) - 1), TAG, "rate");
    ESP_RETURN_ON_ERROR(wr(REG_GYRO_CONFIG, 0x18), TAG, "+-2000 dps");
    ESP_RETURN_ON_ERROR(wr(REG_ACCEL_CONFIG, 0x18), TAG, "+-16 g");
    ESP_RETURN_ON_ERROR(wr(REG_INT_ENABLE, 0x00), TAG, "int off");
    /* FIFO: reset, enable, feed accel + all gyro axes. */
    ESP_RETURN_ON_ERROR(wr(REG_USER_CTRL, 0x04), TAG, "fifo reset");
    vTaskDelay(pdMS_TO_TICKS(2));
    ESP_RETURN_ON_ERROR(wr(REG_USER_CTRL, 0x40), TAG, "fifo on");
    ESP_RETURN_ON_ERROR(wr(REG_FIFO_EN, 0x78), TAG, "fifo sources");
    ESP_LOGI(TAG, "ready (WHO_AM_I 0x%02X) %d Hz, +-16 g, +-2000 dps", who, SENSOR_RATE_HZ);
    return ESP_OK;
}

static void fifo_reset(void)
{
    wr(REG_USER_CTRL, 0x44);   /* keep enabled, pulse reset */
}

int mpu6050_read_fifo(mpu_raw_t *out, int max, bool *overflow)
{
    *overflow = false;
    uint8_t st = 0, cnt[2];
    if (rd(REG_INT_STATUS, &st, 1) != ESP_OK) return 0;
    if (st & 0x10) {           /* FIFO_OFLOW_INT: data is misaligned now, start clean */
        *overflow = true;
        fifo_reset();
        return 0;
    }
    if (rd(REG_FIFO_COUNTH, cnt, 2) != ESP_OK) return 0;
    int bytes = (cnt[0] << 8) | cnt[1];
    if (bytes >= FIFO_SIZE - FIFO_SAMPLE_BYTES) {
        *overflow = true;
        fifo_reset();
        return 0;
    }
    int n = bytes / FIFO_SAMPLE_BYTES;
    if (n > max) n = max;
    int got = 0;
    uint8_t buf[FIFO_SAMPLE_BYTES * 8];
    while (got < n) {
        int chunk = n - got > 8 ? 8 : n - got;
        if (rd(REG_FIFO_R_W, buf, chunk * FIFO_SAMPLE_BYTES) != ESP_OK) break;
        for (int i = 0; i < chunk; i++) {
            const uint8_t *p = buf + i * FIFO_SAMPLE_BYTES;
            mpu_raw_t *s = &out[got + i];
            s->ax = be16(p + 0);  s->ay = be16(p + 2);  s->az = be16(p + 4);
            s->gx = be16(p + 6);  s->gy = be16(p + 8);  s->gz = be16(p + 10);
        }
        got += chunk;
    }
    return got;
}

esp_err_t mpu6050_enter_wake_on_motion(uint8_t threshold)
{
    /* InvenSense wake-on-motion recipe: accel HPF hold, motion threshold, latched INT,
     * then cycle mode with gyros in standby (~10-20 uA). */
    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_1, 0x00), TAG, "wake");
    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_2, 0x00), TAG, "pwr2");
    ESP_RETURN_ON_ERROR(wr(REG_USER_CTRL, 0x00), TAG, "fifo off");
    ESP_RETURN_ON_ERROR(wr(REG_FIFO_EN, 0x00), TAG, "fifo src off");
    ESP_RETURN_ON_ERROR(wr(REG_CONFIG, 0x01), TAG, "dlpf 184");
    ESP_RETURN_ON_ERROR(wr(REG_ACCEL_CONFIG, 0x01), TAG, "+-2g, HPF 5 Hz");
    ESP_RETURN_ON_ERROR(wr(REG_MOT_THR, threshold), TAG, "mot thr");
    ESP_RETURN_ON_ERROR(wr(REG_MOT_DUR, 1), TAG, "mot dur");
    ESP_RETURN_ON_ERROR(wr(REG_MOT_DET_CTRL, 0x15), TAG, "mot ctrl");
    ESP_RETURN_ON_ERROR(wr(REG_INT_PIN_CFG, 0x20), TAG, "active-high push-pull, latched");
    ESP_RETURN_ON_ERROR(wr(REG_INT_ENABLE, 0x40), TAG, "MOT_EN");
    vTaskDelay(pdMS_TO_TICKS(5));
    ESP_RETURN_ON_ERROR(wr(REG_ACCEL_CONFIG, 0x07), TAG, "HPF hold");
    uint8_t st;
    rd(REG_INT_STATUS, &st, 1);   /* clear anything latched while configuring */
    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_2, 0x47), TAG, "LP wake 5 Hz, gyro standby");
    ESP_RETURN_ON_ERROR(wr(REG_PWR_MGMT_1, 0x28), TAG, "cycle, temp off");
    return ESP_OK;
}

void mpu6050_scan_log(void)
{
    /* Diagnostic for "sensor not found": which pins/addresses answer at all? Releases the bus. */
    if (s_dev) { i2c_master_bus_rm_device(s_dev); s_dev = NULL; }
    if (s_bus) { i2c_del_master_bus(s_bus); s_bus = NULL; }

    /* configured pins: every address */
    i2c_master_bus_handle_t bus = NULL;
    i2c_master_bus_config_t cfg = {
        .i2c_port = BOARD_I2C_PORT, .sda_io_num = BOARD_I2C_SDA_GPIO, .scl_io_num = BOARD_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = 1,
    };
    int found = 0;
    if (i2c_new_master_bus(&cfg, &bus) == ESP_OK) {
        for (int a = 0x08; a < 0x78; a++) {
            if (i2c_master_probe(bus, a, 5) == ESP_OK) {
                ESP_LOGW(TAG, "scan: device at 0x%02X on SDA=%d SCL=%d", a, BOARD_I2C_SDA_GPIO, BOARD_I2C_SCL_GPIO);
                found++;
            }
        }
        i2c_del_master_bus(bus);
    }
    if (found >= 100) ESP_LOGW(TAG, "scan: every address ACKs -> SDA is stuck low (short or missing pull-up)");
    if (found) return;

    /* other pins: look for the IMU's usual addresses (MPU 0x68/0x69, LSM6/QMI 0x6A/0x6B) */
    static const int pins[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 18, 19, 20, 21, 22, 23};
    const int n = sizeof(pins) / sizeof(pins[0]);
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (i == j) continue;
            cfg.sda_io_num = pins[i];
            cfg.scl_io_num = pins[j];
            if (i2c_new_master_bus(&cfg, &bus) != ESP_OK) continue;
            for (int a = 0x68; a <= 0x6B; a++) {
                if (i2c_master_probe(bus, a, 3) == ESP_OK) {
                    ESP_LOGW(TAG, "scan: device at 0x%02X on SDA=%d SCL=%d", a, pins[i], pins[j]);
                    found++;
                }
            }
            i2c_del_master_bus(bus);
            gpio_reset_pin(pins[i]);   /* otherwise the pin stays routed to the I2C unit: false hits */
            gpio_reset_pin(pins[j]);
        }
    }
    if (!found) ESP_LOGW(TAG, "scan: nothing answers on any pin pair -> check the sensor's power (VCC/GND) and wires");
}

bool mpu6050_motion_latched(void)
{
    uint8_t st = 0;
    if (attach() != ESP_OK || rd(REG_INT_STATUS, &st, 1) != ESP_OK) return true;  /* unsure: wake up */
    return (st & 0x40) != 0;
}
