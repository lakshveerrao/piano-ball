# The web app in ../../web is embedded into the firmware and served at http://<ball>/
set(WEB ${CMAKE_CURRENT_LIST_DIR}/../../web)
idf_component_register(
    SRCS "main.c" "mpu6050.c" "motion.c" "net.c" "power.c"
    INCLUDE_DIRS "."
    EMBED_FILES
        "${WEB}/index.html"
        "${WEB}/style.css"
        "${WEB}/js/protocol.js"
        "${WEB}/js/link.js"
        "${WEB}/js/motion.js"
        "${WEB}/js/piano.js"
        "${WEB}/js/composer.js"
        "${WEB}/js/visualizer.js"
        "${WEB}/js/sim.js"
        "${WEB}/js/app.js"
    REQUIRES
        nvs_flash esp_driver_i2c esp_driver_gpio esp_adc esp_timer esp_wifi
        esp_netif esp_event esp_http_server esp_hw_support esp_system log lwip
)
