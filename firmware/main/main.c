/**
 * @file main.c
 * Piano Ball firmware: MPU6050 at 250 Hz -> impact/free-fall detection -> binary WebSocket
 * stream, with drowsy (modem sleep) and deep-sleep (wake on motion) power states.
 *
 *   sensor_task (prio 10)  drains the MPU FIFO every 8 ms, runs motion.c, queues items
 *   stream_task (prio 5)   batches samples into packets, sends events at once, status 1 Hz,
 *                          decides active / drowsy / deep sleep
 */
#include <string.h>

#include "board_config.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "motion.h"
#include "mpu6050.h"
#include "net.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "power.h"
#include "protocol.h"

static const char *TAG = "ball";

enum { ITEM_SAMPLE, ITEM_IMPACT, ITEM_FF };
typedef struct {
    uint8_t kind;
    uint32_t index;
    union {
        imu_sample_t sample;
        motion_impact_t impact;
        motion_freefall_t ff;
    };
    uint8_t ff_phase_end;   /* for ITEM_FF: 1 = end */
} item_t;

static QueueHandle_t s_items;
static volatile bool s_sensor_ok, s_overflow, s_sleep_requested, s_reboot_requested, s_status_now;
static volatile uint8_t s_state = STATE_ACTIVE;
static uint16_t s_sleep_after_s = SLEEP_AFTER_S;
static uint16_t s_seq;
static uint16_t s_batt_mv;   /* refreshed with every status packet (1 Hz), 0 = unknown */

/* ------------------------------------------------------------------ settings */

static void load_settings(void)
{
    nvs_handle_t h;
    if (nvs_open("cfg", NVS_READONLY, &h) != ESP_OK) return;
    uint16_t v;
    if (nvs_get_u16(h, "impact_mg", &v) == ESP_OK) motion_set_impact_threshold(v);
    if (nvs_get_u16(h, "sleep_s", &v) == ESP_OK) s_sleep_after_s = v;
    nvs_close(h);
}

static void save_settings(void)
{
    nvs_handle_t h;
    if (nvs_open("cfg", NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u16(h, "impact_mg", motion_impact_threshold());
    nvs_set_u16(h, "sleep_s", s_sleep_after_s);
    nvs_commit(h);
    nvs_close(h);
}

/* ------------------------------------------------------------------ sensor */

static void sensor_task(void *arg)
{
    static mpu_raw_t raw[48];
    uint32_t index = 0;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(8));
        if (!s_sensor_ok) {
            if (mpu6050_init() == ESP_OK) s_sensor_ok = true;
            else vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        bool ovf;
        int n = mpu6050_read_fifo(raw, 48, &ovf);
        if (ovf) {
            s_overflow = true;
            index += 1024 / 12;   /* roughly what the FIFO held; keeps the timeline honest */
        }
        for (int i = 0; i < n; i++, index++) {
            item_t it = {.kind = ITEM_SAMPLE, .index = index};
            motion_impact_t imp;
            motion_freefall_t ff;
            uint8_t ev = motion_process(index, &raw[i], &it.sample, &imp, &ff);
            if (s_state == STATE_ACTIVE && xQueueSend(s_items, &it, 0) != pdTRUE) s_overflow = true;
            if (ev & EV_IMPACT) {
                item_t e = {.kind = ITEM_IMPACT, .index = imp.index, .impact = imp};
                xQueueSendToFront(s_items, &e, 0);   /* jump the queue: the music reacts to this */
            }
            if (ev & (EV_FF_START | EV_FF_END)) {
                item_t e = {.kind = ITEM_FF, .index = ff.start_index, .ff = ff, .ff_phase_end = !!(ev & EV_FF_END)};
                xQueueSendToFront(s_items, &e, 0);
            }
        }
    }
}

/* ------------------------------------------------------------------ packets */

static void send_status(int fd)
{
    pkt_status_t p = {
        .type = PKT_STATUS,
        .state = s_state,
        .seq = s_seq++,
        .uptime_ms = (uint32_t)(esp_timer_get_time() / 1000),
        .battery_pct = 255,
        .rssi = net_rssi(),
        .sample_rate_hz = s_sensor_ok ? SENSOR_RATE_HZ : 0,
        .accel_lsb_per_g = ACCEL_LSB_PER_G,
        .gyro_lsb_per_dps_x10 = GYRO_LSB_PER_DPS_X10,
        .fw_major = FW_MAJOR,
        .fw_minor = FW_MINOR,
        .impact_threshold_mg = motion_impact_threshold(),
        .sleep_after_s = s_sleep_after_s,
        .wifi_mode = net_wifi_mode(),
        .clients = (uint8_t)net_client_count(),
    };
    uint16_t mv;
    uint8_t pct;
    s_batt_mv = 0;
    if (battery_read(&mv, &pct)) {
        p.battery_mv = s_batt_mv = mv;
        p.battery_pct = pct;
    }
    if (fd >= 0) net_send_to(fd, &p, sizeof(p));
    else net_broadcast(&p, sizeof(p));
}

static void on_command(int fd, const uint8_t *d, size_t len)
{
    switch (d[0]) {
    case CMD_PING:
        if (len >= 4) {
            pkt_pong_t p = {.type = PKT_PONG, .token = (uint16_t)(d[2] | d[3] << 8),
                            .uptime_ms = (uint32_t)(esp_timer_get_time() / 1000)};
            net_send_to(fd, &p, sizeof(p));
        }
        break;
    case CMD_CONFIG:
        if (len >= 6) {
            uint16_t thr = d[2] | d[3] << 8, slp = d[4] | d[5] << 8;
            if (thr != 0xFFFF) motion_set_impact_threshold(thr);
            if (slp != 0xFFFF) s_sleep_after_s = slp;
            save_settings();
            s_status_now = true;
            ESP_LOGI(TAG, "config: impact %u mg, sleep after %u s", motion_impact_threshold(), s_sleep_after_s);
        }
        break;
    case CMD_SLEEP:
        s_sleep_requested = true;
        break;
    case CMD_WIFI: {
        size_t sl = len > 1 ? d[1] : 0;
        if (len < 3 + sl || sl == 0 || sl > 32) break;
        size_t pl = d[2 + sl];
        if (len < 3 + sl + pl || pl > 63) break;
        char ssid[33] = {0}, pass[64] = {0};
        memcpy(ssid, d + 2, sl);
        memcpy(pass, d + 3 + sl, pl);
        if (net_save_wifi(ssid, pass) == ESP_OK) {
            ESP_LOGI(TAG, "wifi set to '%s', rebooting", ssid);
            s_reboot_requested = true;
        }
        break;
    }
    }
}

static void go_to_sleep(uint8_t reason)
{
    pkt_sleep_t p = {.type = PKT_SLEEP, .reason = reason};
    net_broadcast(&p, sizeof(p));
    vTaskDelay(pdMS_TO_TICKS(150));   /* let the frame leave before the radio stops */
    power_deep_sleep();
}

static uint8_t s_pkt[sizeof(pkt_imu_hdr_t) + BATCH_SAMPLES * sizeof(imu_sample_t)];
static int s_batched;

static void flush_batch(bool send)
{
    if (!s_batched) return;
    pkt_imu_hdr_t *hdr = (pkt_imu_hdr_t *)s_pkt;
    hdr->type = PKT_IMU;
    hdr->count = s_batched;
    hdr->seq = s_seq++;
    hdr->period_us = SENSOR_PERIOD_US;
    hdr->state = s_state;
    hdr->flags = (motion_bias_valid() ? IMU_FLAG_BIAS_CORRECTED : 0) | (s_overflow ? IMU_FLAG_OVERFLOW : 0);
    s_overflow = false;
    if (send) net_broadcast(s_pkt, sizeof(pkt_imu_hdr_t) + s_batched * sizeof(imu_sample_t));
    s_batched = 0;
}

static void stream_task(void *arg)
{
    pkt_imu_hdr_t *hdr = (pkt_imu_hdr_t *)s_pkt;
    imu_sample_t *samples = (imu_sample_t *)(s_pkt + sizeof(pkt_imu_hdr_t));
    int64_t batch_started = 0, last_status = 0, no_client_since = esp_timer_get_time();
    int last_clients = 0;

    for (;;) {
        item_t it;
        bool got = xQueueReceive(s_items, &it, pdMS_TO_TICKS(20)) == pdTRUE;
        int64_t now = esp_timer_get_time();
        int clients = net_client_count();

        if (got && it.kind == ITEM_SAMPLE) {
            /* every packet is a contiguous run of samples */
            if (s_batched && it.index != hdr->first_index + s_batched) flush_batch(clients);
            if (s_batched == 0) {
                hdr->first_index = it.index;
                batch_started = now;
            }
            samples[s_batched++] = it.sample;
        } else if (got && it.kind == ITEM_IMPACT && clients) {
            pkt_impact_t p = {.type = PKT_IMPACT, .duration = it.impact.duration, .seq = s_seq++,
                              .index = it.impact.index, .peak_mg = it.impact.peak_mg,
                              .dx = it.impact.dx, .dy = it.impact.dy, .dz = it.impact.dz};
            net_broadcast(&p, sizeof(p));
        } else if (got && it.kind == ITEM_FF && clients) {
            pkt_freefall_t p = {.type = PKT_FREEFALL, .phase = it.ff_phase_end ? 0 : 1, .seq = s_seq++,
                                .index = it.ff.start_index, .duration_ms = it.ff.duration_ms};
            net_broadcast(&p, sizeof(p));
        }
        if (s_batched == BATCH_SAMPLES || (s_batched && now - batch_started > 30000)) flush_batch(clients);

        /* ---- status / hello ---- */
        if (clients > last_clients || s_status_now || now - last_status > 1000000) {
            send_status(-1);
            s_status_now = false;
            last_status = now;
        }
        last_clients = clients;
        if (clients) no_client_since = now;

        /* ---- power state ---- */
        uint32_t still = s_sensor_ok ? motion_still_ms() : 0;
        uint8_t state = still > DROWSY_AFTER_S * 1000u ? STATE_DROWSY : STATE_ACTIVE;
        if (state != s_state) {
            s_state = state;
            net_set_low_power(state == STATE_DROWSY);
            s_status_now = true;
            ESP_LOGI(TAG, "%s", state == STATE_DROWSY ? "drowsy" : "active");
        }
        uint32_t limit = s_sleep_after_s;
        if (!clients && limit > SLEEP_AFTER_NO_CLIENT_S) limit = SLEEP_AFTER_NO_CLIENT_S;
        bool low = s_batt_mv && s_batt_mv < LOW_BATTERY_MV;

        if (s_reboot_requested) {
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
        }
        if (s_sleep_requested) go_to_sleep(3);
        if (low && still > 10000) go_to_sleep(2);
        if (limit && still > limit * 1000u) go_to_sleep(1);
        if (!s_sensor_ok && now - no_client_since > 300000000LL) go_to_sleep(1);
    }
}

void app_main(void)
{
    power_early_boot();

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    ESP_LOGI(TAG, "Piano Ball fw %d.%d (%s)", FW_MAJOR, FW_MINOR,
             power_woke_from_sleep() ? "woke on motion" : "cold boot");

    battery_init();
    motion_init();
    load_settings();
    s_sensor_ok = mpu6050_init() == ESP_OK;
    if (!s_sensor_ok) mpu6050_scan_log();   /* tell us where the sensor actually is */

    s_items = xQueueCreate(512, sizeof(item_t));
    ESP_ERROR_CHECK(net_start(on_command));

    xTaskCreate(sensor_task, "sensor", 4096, NULL, 10, NULL);
    xTaskCreate(stream_task, "stream", 4096, NULL, 5, NULL);
}
