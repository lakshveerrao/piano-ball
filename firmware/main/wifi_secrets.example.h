/* Copy to wifi_secrets.h (git-ignored) to bake home Wi-Fi into the firmware.
 * Without it the ball opens a "PianoBall-XXXX" setup network: join it, open
 * http://192.168.4.1 and use "Ball Wi-Fi" in the app. Credentials set from the
 * app are stored in NVS and take priority over these. */
#define WIFI_SSID "your-network"
#define WIFI_PASS "your-password"
