#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/** Called from the HTTP server task for every binary frame a client sends. */
typedef void (*net_cmd_cb_t)(int fd, const uint8_t *data, size_t len);

/** Start Wi-Fi (station with auto-reconnect, setup AP fallback), mDNS and the HTTP/WebSocket server. */
esp_err_t net_start(net_cmd_cb_t on_cmd);

/** Send one binary frame to every connected WebSocket client. Returns clients reached. */
int net_broadcast(const void *data, size_t len);
esp_err_t net_send_to(int fd, const void *data, size_t len);

int net_client_count(void);
int8_t net_rssi(void);
uint8_t net_wifi_mode(void);            /* 0 station, 1 setup AP, 2 both */
void net_set_low_power(bool low);       /* Wi-Fi modem sleep while the ball is idle */
esp_err_t net_save_wifi(const char *ssid, const char *pass);
