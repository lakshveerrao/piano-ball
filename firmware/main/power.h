#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/** Call first thing in app_main: after a timer wake with no motion, goes straight back to sleep. */
void power_early_boot(void);

esp_err_t battery_init(void);
/** Averaged battery reading. Returns false if there is no battery sense (or it reads implausibly). */
bool battery_read(uint16_t *mv, uint8_t *pct);

/** Arm motion wake-up and enter deep sleep. Does not return. */
void power_deep_sleep(void) __attribute__((noreturn));

/** True if this boot came from deep sleep (motion or timer wake). */
bool power_woke_from_sleep(void);
