/**
 * @file net.c
 * Wi-Fi station with exponential-backoff reconnect, a setup access point when no network is
 * reachable, mDNS (pianoball.local), and one HTTP server that serves the web app and the
 * /ws WebSocket stream on port 80.
 */
#include "net.h"

#include <string.h>
#include <sys/socket.h>
#include <netinet/tcp.h>

#include "board_config.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

#if __has_include("mdns.h")
#include "mdns.h"
#define HAVE_MDNS 1
#endif

/* Optional compile-time credentials: copy wifi_secrets.example.h to wifi_secrets.h. */
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#define WIFI_PASS ""
#endif

static const char *TAG = "net";
#define PB_STR_(x) #x
#define PB_STR(x) PB_STR_(x)

#define MAX_CLIENTS 4

static httpd_handle_t s_server;
static net_cmd_cb_t s_on_cmd;
static SemaphoreHandle_t s_lock;
static int s_clients[MAX_CLIENTS];
static int s_nclients;

static bool s_have_sta_creds, s_sta_up, s_ap_on, s_low_power;
static uint32_t s_backoff_ms = 1000;
static esp_timer_handle_t s_reconnect_timer, s_fallback_timer;

/* ------------------------------------------------------------------ clients */

static void client_add(int fd)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < s_nclients; i++) {
        if (s_clients[i] == fd) goto out;
    }
    if (s_nclients < MAX_CLIENTS) s_clients[s_nclients++] = fd;
out:
    xSemaphoreGive(s_lock);
}

static void client_remove(int fd)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < s_nclients; i++) {
        if (s_clients[i] == fd) {
            s_clients[i] = s_clients[--s_nclients];
            break;
        }
    }
    xSemaphoreGive(s_lock);
}

int net_client_count(void) { return s_nclients; }

esp_err_t net_send_to(int fd, const void *data, size_t len)
{
    if (!s_server) return ESP_ERR_INVALID_STATE;
    if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
        client_remove(fd);
        return ESP_FAIL;
    }
    httpd_ws_frame_t f = {.type = HTTPD_WS_TYPE_BINARY, .payload = (uint8_t *)data, .len = len, .final = true};
    esp_err_t err = httpd_ws_send_data(s_server, fd, &f);   /* thread-safe: runs on the server task */
    if (err != ESP_OK) {
        client_remove(fd);
        httpd_sess_trigger_close(s_server, fd);
    }
    return err;
}

int net_broadcast(const void *data, size_t len)
{
    int fds[MAX_CLIENTS], n;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    n = s_nclients;
    memcpy(fds, s_clients, sizeof(int) * n);
    xSemaphoreGive(s_lock);
    int ok = 0;
    for (int i = 0; i < n; i++) ok += net_send_to(fds[i], data, len) == ESP_OK;
    return ok;
}

/* ------------------------------------------------------------------ http */

#define ASSET(sym, path_, type_)                                                   \
    extern const uint8_t _binary_##sym##_start[] asm("_binary_" #sym "_start");   \
    extern const uint8_t _binary_##sym##_end[] asm("_binary_" #sym "_end");

ASSET(index_html, "/", "text/html")
ASSET(style_css, "/style.css", "text/css")
ASSET(protocol_js, "/js/protocol.js", "")
ASSET(link_js, "/js/link.js", "")
ASSET(motion_js, "/js/motion.js", "")
ASSET(piano_js, "/js/piano.js", "")
ASSET(composer_js, "/js/composer.js", "")
ASSET(visualizer_js, "/js/visualizer.js", "")
ASSET(sim_js, "/js/sim.js", "")
ASSET(app_js, "/js/app.js", "")

typedef struct {
    const char *path, *type;
    const uint8_t *start, *end;
} asset_t;

#define JS "application/javascript"
static const asset_t s_assets[] = {
    {"/", "text/html; charset=utf-8", _binary_index_html_start, _binary_index_html_end},
    {"/index.html", "text/html; charset=utf-8", _binary_index_html_start, _binary_index_html_end},
    {"/style.css", "text/css", _binary_style_css_start, _binary_style_css_end},
    {"/js/protocol.js", JS, _binary_protocol_js_start, _binary_protocol_js_end},
    {"/js/link.js", JS, _binary_link_js_start, _binary_link_js_end},
    {"/js/motion.js", JS, _binary_motion_js_start, _binary_motion_js_end},
    {"/js/piano.js", JS, _binary_piano_js_start, _binary_piano_js_end},
    {"/js/composer.js", JS, _binary_composer_js_start, _binary_composer_js_end},
    {"/js/visualizer.js", JS, _binary_visualizer_js_start, _binary_visualizer_js_end},
    {"/js/sim.js", JS, _binary_sim_js_start, _binary_sim_js_end},
    {"/js/app.js", JS, _binary_app_js_start, _binary_app_js_end},
};

static esp_err_t static_handler(httpd_req_t *req)
{
    const char *uri = req->uri;
    size_t ulen = strcspn(uri, "?#");
    for (size_t i = 0; i < sizeof(s_assets) / sizeof(s_assets[0]); i++) {
        const asset_t *a = &s_assets[i];
        if (strlen(a->path) == ulen && strncmp(a->path, uri, ulen) == 0) {
            httpd_resp_set_type(req, a->type);
            httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
            return httpd_resp_send(req, (const char *)a->start, a->end - a->start);
        }
    }
    return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
}

static esp_err_t ws_handler(httpd_req_t *req)
{
    int fd = httpd_req_to_sockfd(req);
    if (req->method == HTTP_GET) {   /* handshake done */
        client_add(fd);
        ESP_LOGI(TAG, "client %d connected (%d total)", fd, s_nclients);
        return ESP_OK;
    }
    uint8_t buf[128];
    httpd_ws_frame_t f = {.payload = NULL};
    esp_err_t err = httpd_ws_recv_frame(req, &f, 0);
    if (err != ESP_OK) return err;
    if (f.len > sizeof(buf)) return ESP_ERR_INVALID_SIZE;
    f.payload = buf;
    if (f.len && (err = httpd_ws_recv_frame(req, &f, f.len)) != ESP_OK) return err;
    if (f.type == HTTPD_WS_TYPE_BINARY && f.len && s_on_cmd) s_on_cmd(fd, buf, f.len);
    return ESP_OK;
}

static esp_err_t on_open(httpd_handle_t hd, int fd)
{
    int one = 1;   /* no Nagle: 72-byte packets must leave immediately */
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return ESP_OK;
}

static void on_close(httpd_handle_t hd, int fd)
{
    client_remove(fd);
    close(fd);
}

static esp_err_t start_http(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.max_open_sockets = 7;
    cfg.lru_purge_enable = true;
    cfg.send_wait_timeout = 2;
    cfg.open_fn = on_open;
    cfg.close_fn = on_close;
    cfg.stack_size = 6144;
    ESP_ERROR_CHECK(httpd_start(&s_server, &cfg));
    static const httpd_uri_t ws = {.uri = "/ws", .method = HTTP_GET, .handler = ws_handler, .is_websocket = true};
    static const httpd_uri_t any = {.uri = "/*", .method = HTTP_GET, .handler = static_handler};
    httpd_register_uri_handler(s_server, &ws);
    httpd_register_uri_handler(s_server, &any);
    return ESP_OK;
}

/* ------------------------------------------------------------------ wifi */

static void start_ap(void)
{
    if (s_ap_on) return;
    wifi_config_t ap = {0};
    int n = snprintf((char *)ap.ap.ssid, sizeof(ap.ap.ssid), AP_SSID_PREFIX "%d", BALL_ID);
    ap.ap.ssid_len = n;
    strlcpy((char *)ap.ap.password, AP_PASSWORD, sizeof(ap.ap.password));
    ap.ap.authmode = strlen(AP_PASSWORD) >= 8 ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ap.ap.max_connection = 3;
    ap.ap.channel = 1;
    esp_wifi_set_mode(s_have_sta_creds ? WIFI_MODE_APSTA : WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &ap);
    s_ap_on = true;
    ESP_LOGW(TAG, "setup AP '%s' up: join it and open http://192.168.4.1", ap.ap.ssid);
}

static void reconnect_cb(void *arg) { esp_wifi_connect(); }

static void fallback_cb(void *arg)
{
    if (!s_sta_up) start_ap();
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_sta_up = false;
        ESP_LOGW(TAG, "wifi lost, retry in %lu ms", (unsigned long)s_backoff_ms);
        esp_timer_stop(s_reconnect_timer);
        esp_timer_start_once(s_reconnect_timer, (uint64_t)s_backoff_ms * 1000);
        s_backoff_ms = s_backoff_ms * 2 > 30000 ? 30000 : s_backoff_ms * 2;
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        s_sta_up = true;
        s_backoff_ms = 1000;
        ESP_LOGI(TAG, "online: http://" IPSTR "  (or http://" DEVICE_HOSTNAME ".local)", IP2STR(&e->ip_info.ip));
        wifi_sta_list_t sta;
        if (s_ap_on && esp_wifi_ap_get_sta_list(&sta) == ESP_OK && sta.num == 0) {
            esp_wifi_set_mode(WIFI_MODE_STA);   /* nobody is using the setup AP: save power */
            s_ap_on = false;
        }
        net_set_low_power(s_low_power);
    }
}

static void load_creds(char *ssid, size_t ssid_sz, char *pass, size_t pass_sz)
{
    strlcpy(ssid, WIFI_SSID, ssid_sz);
    strlcpy(pass, WIFI_PASS, pass_sz);
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READONLY, &h) == ESP_OK) {
        char s[33] = {0};
        size_t a = sizeof(s), b = pass_sz;
        if (nvs_get_str(h, "ssid", s, &a) == ESP_OK && s[0]) {
            strlcpy(ssid, s, ssid_sz);
            if (nvs_get_str(h, "pass", pass, &b) != ESP_OK) pass[0] = 0;
        }
        nvs_close(h);
    }
}

esp_err_t net_save_wifi(const char *ssid, const char *pass)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("wifi", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    nvs_set_str(h, "ssid", ssid);
    nvs_set_str(h, "pass", pass);
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

int8_t net_rssi(void)
{
    wifi_ap_record_t ap;
    return (s_sta_up && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) ? ap.rssi : 0;
}

uint8_t net_wifi_mode(void) { return s_ap_on ? (s_sta_up ? 2 : 1) : 0; }

void net_set_low_power(bool low)
{
    s_low_power = low;
    if (s_sta_up) esp_wifi_set_ps(low ? WIFI_PS_MAX_MODEM : WIFI_PS_NONE);
}

esp_err_t net_start(net_cmd_cb_t on_cmd)
{
    s_on_cmd = on_cmd;
    s_lock = xSemaphoreCreateMutex();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *sta = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();
    esp_netif_set_hostname(sta, DEVICE_HOSTNAME);

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    esp_wifi_set_storage(WIFI_STORAGE_RAM);
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL);

    const esp_timer_create_args_t rt = {.callback = reconnect_cb, .name = "wifi_retry"};
    const esp_timer_create_args_t ft = {.callback = fallback_cb, .name = "wifi_ap_fallback"};
    esp_timer_create(&rt, &s_reconnect_timer);
    esp_timer_create(&ft, &s_fallback_timer);

    char ssid[33], pass[65];
    load_creds(ssid, sizeof(ssid), pass, sizeof(pass));
    s_have_sta_creds = ssid[0] != 0;
    if (s_have_sta_creds) {
        wifi_config_t sc = {0};
        strlcpy((char *)sc.sta.ssid, ssid, sizeof(sc.sta.ssid));
        strlcpy((char *)sc.sta.password, pass, sizeof(sc.sta.password));
        sc.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
        sc.sta.scan_method = WIFI_FAST_SCAN;
        esp_wifi_set_mode(WIFI_MODE_STA);
        esp_wifi_set_config(WIFI_IF_STA, &sc);
        esp_timer_start_once(s_fallback_timer, (uint64_t)STA_FALLBACK_AP_AFTER_MS * 1000);
        ESP_LOGI(TAG, "joining '%s'", ssid);
    } else {
        ESP_LOGW(TAG, "no Wi-Fi credentials stored");
        start_ap();
    }
    ESP_ERROR_CHECK(esp_wifi_start());

#ifdef HAVE_MDNS
    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(DEVICE_HOSTNAME);
        mdns_instance_name_set("Piano Ball " PB_STR(BALL_ID));
        mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }
#endif
    return start_http();
}
