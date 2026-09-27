/**
 * @file power.c
 * Battery sense and deep sleep. In deep sleep the ESP32-C6 draws ~7 uA and the MPU6050
 * sits in accel-only cycle mode; its motion interrupt wakes the chip through an LP GPIO.
 */
#include "power.h"

#include "board_config.h"
#include "driver/gpio.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_wifi.h"
#include "mpu6050.h"

static const char *TAG = "power";

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;
static bool s_cali_ok, s_adc_ok;
static bool s_woke;

bool power_woke_from_sleep(void) { return s_woke; }

static void arm_and_sleep(void)
{
#if BOARD_HAS_MPU_INT
    gpio_set_direction(BOARD_MPU_INT_GPIO, GPIO_MODE_INPUT);
    esp_sleep_enable_ext1_wakeup_io(1ULL << BOARD_MPU_INT_GPIO, ESP_EXT1_WAKEUP_ANY_HIGH);
#else
    esp_sleep_enable_timer_wakeup((uint64_t)TIMER_WAKE_S * 1000000ULL);
#endif
    esp_deep_sleep_start();
}

void power_early_boot(void)
{
    uint32_t causes = esp_sleep_get_wakeup_causes();
    s_woke = causes & ((1u << ESP_SLEEP_WAKEUP_EXT1) | (1u << ESP_SLEEP_WAKEUP_TIMER));
#if !BOARD_HAS_MPU_INT
    /* Timer wake: only boot fully if the MPU latched a motion interrupt while we slept.
     * This check costs a few ms of CPU and no radio, so idle current stays tiny. */
    if ((causes & (1u << ESP_SLEEP_WAKEUP_TIMER)) && !mpu6050_motion_latched()) {
        arm_and_sleep();
    }
#endif
}

esp_err_t battery_init(void)
{
#if BOARD_HAS_BATTERY_SENSE
    adc_oneshot_unit_init_cfg_t unit = {.unit_id = ADC_UNIT_1, .ulp_mode = ADC_ULP_MODE_DISABLE};
    if (adc_oneshot_new_unit(&unit, &s_adc) != ESP_OK) return ESP_FAIL;
    adc_oneshot_chan_cfg_t ch = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_oneshot_config_channel(s_adc, BOARD_BATTERY_ADC_CHANNEL, &ch) != ESP_OK) return ESP_FAIL;
    adc_cali_curve_fitting_config_t cal = {
        .unit_id = ADC_UNIT_1,
        .chan = BOARD_BATTERY_ADC_CHANNEL,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    s_cali_ok = adc_cali_create_scheme_curve_fitting(&cal, &s_cali) == ESP_OK;
    s_adc_ok = true;
#endif
    return ESP_OK;
}

static uint8_t mv_to_pct(uint16_t mv)
{
    static const uint16_t v[] = {3300, 3500, 3600, 3700, 3750, 3800, 3900, 4000, 4100, 4200};
    static const uint8_t p[] = {0, 5, 12, 25, 40, 55, 70, 82, 93, 100};
    if (mv <= v[0]) return 0;
    if (mv >= v[9]) return 100;
    for (int i = 1; i < 10; i++) {
        if (mv <= v[i]) return (uint8_t)(p[i - 1] + (p[i] - p[i - 1]) * (mv - v[i - 1]) / (v[i] - v[i - 1]));
    }
    return 100;
}

bool battery_read(uint16_t *mv, uint8_t *pct)
{
    if (!s_adc_ok) return false;
    int sum = 0, n = 0;
    for (int i = 0; i < 8; i++) {
        int raw, v;
        if (adc_oneshot_read(s_adc, BOARD_BATTERY_ADC_CHANNEL, &raw) != ESP_OK) continue;
        if (s_cali_ok && adc_cali_raw_to_voltage(s_cali, raw, &v) == ESP_OK) sum += v;
        else sum += raw * 3100 / 4095;
        n++;
    }
    if (!n) return false;
    uint16_t batt = (uint16_t)((float)sum / n * BOARD_BATTERY_DIVIDER);
    if (batt < 2500 || batt > 4600) return false;   /* nothing wired to the divider (or USB only) */
    *mv = batt;
    *pct = mv_to_pct(batt);
    return true;
}

void power_deep_sleep(void)
{
    ESP_LOGI(TAG, "deep sleep (wake on %s)", BOARD_HAS_MPU_INT ? "motion interrupt" : "timer + motion latch");
    esp_wifi_stop();
    if (mpu6050_enter_wake_on_motion(WAKE_MOTION_THRESHOLD) != ESP_OK) {
        /* No sensor: a timer wake at least keeps retrying instead of sleeping forever. */
        esp_sleep_enable_timer_wakeup(30ULL * 1000000ULL);
        esp_deep_sleep_start();
    }
    arm_and_sleep();
    __builtin_unreachable();
}
