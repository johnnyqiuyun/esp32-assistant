// ESP32 Assistant demo: a program that hangs and is reset by the task watchdog, again and again.
//
// It prints normal sensor lines for about 8 s, then gets stuck in a busy loop that never feeds the
// watchdog. After 3 s the task watchdog fires, the chip panics and restarts, and the cycle repeats.
// The pane should turn red ("keeps restarting") and the AI diagnosis should point at the busy loop.

#include <stdio.h>
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "demo";

void app_main(void)
{
    esp_task_wdt_config_t cfg = {
        .timeout_ms = 3000,
        .idle_core_mask = 0,
        .trigger_panic = true,  // reset instead of only printing a warning
    };
    if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) {
        esp_task_wdt_init(&cfg);
    }
    esp_task_wdt_add(NULL);  // watch this task (app_main)

    ESP_LOGI(TAG, "ESP32 Assistant demo firmware: watchdog scenario");
    for (int n = 0; n < 4; n++) {
        ESP_LOGI(TAG, "temperature=%.1f C humidity=%d%% heap=%lu", 24.0 + (esp_random() % 30) / 10.0,
                 45 + (int)(esp_random() % 10), (unsigned long)esp_get_free_heap_size());
        esp_task_wdt_reset();
        vTaskDelay(pdMS_TO_TICKS(2000));
    }

    ESP_LOGW(TAG, "waiting for sensor data that never arrives...");
    volatile int data_ready = 0;
    while (!data_ready) {
        // the bug: a busy wait with no vTaskDelay() and no esp_task_wdt_reset()
    }
}
