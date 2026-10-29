// ESP32 Assistant demo firmware — gives the pane and the AI diagnosis something real to find.
//
// One sketch, four builds (DEMO_SCENARIO, set by demo-firmware/build.ps1):
//   0 healthy   prints fake sensor readings every 2 s; pressing BOOT triggers a NULL-pointer crash on camera
//   1 crash     writes through a NULL pointer 5 s after boot -> Guru Meditation -> reboot -> crash again
//   2 wifi      tries to join an access point that does not exist -> disconnect reason 201 (NO_AP_FOUND)
//   3 watchdog  the main task stops yielding -> task watchdog panic -> reboot -> again
//
// Wi-Fi events are reported by this sketch in ESP-IDF's log style ("wifi:connected with …",
// "wifi:disconnected … reason: N") because Arduino's prebuilt ESP-IDF keeps its own Wi-Fi logs quiet.
// The reason codes are the real ones from the Wi-Fi driver's event.

#include <WiFi.h>
#include <esp_task_wdt.h>

#ifndef DEMO_SCENARIO
#define DEMO_SCENARIO 0
#endif

static const char *SCENARIO_NAMES[] = {"healthy", "crash", "wifi", "watchdog"};
static const char *MISSING_AP = "esp32-assistant-demo-missing-ap";
static const int BOOT_PIN = 0;

#define LOG(level, tag, fmt, ...) Serial.printf("%c (%lu) %s: " fmt "\n", level, (unsigned long)millis(), tag, ##__VA_ARGS__)

static void crashNow(const char *why) {
  LOG('W', "demo", "%s -> writing through a NULL pointer", why);
  Serial.flush();
  volatile int *sensorBuffer = nullptr;  // the bug: a buffer that was never allocated
  *sensorBuffer = 42;
}

static void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      LOG('I', "wifi", "connected with %s, channel %d", WiFi.SSID().c_str(), WiFi.channel());
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      LOG('I', "esp_netif_handlers", "sta ip: %s, mask: %s, gw: %s", WiFi.localIP().toString().c_str(),
          WiFi.subnetMask().toString().c_str(), WiFi.gatewayIP().toString().c_str());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      // Printed as "wifi:disconnected …" (no space after the tag colon), the way ESP-IDF prints it.
      Serial.printf("W (%lu) wifi:disconnected, ssid: %s, reason: %d\n", (unsigned long)millis(), MISSING_AP,
                    info.wifi_sta_disconnected.reason);
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(BOOT_PIN, INPUT_PULLUP);
  LOG('I', "demo", "ESP32 Assistant demo firmware v1, scenario: %s", SCENARIO_NAMES[DEMO_SCENARIO]);
  LOG('I', "demo", "chip %s rev %d, %d cores, flash %u MB, PSRAM %u KB free", ESP.getChipModel(), ESP.getChipRevision(),
      ESP.getChipCores(), ESP.getFlashChipSize() / (1024 * 1024), ESP.getFreePsram() / 1024);

  if (DEMO_SCENARIO == 2) {
    WiFi.onEvent(onWifiEvent);
    WiFi.mode(WIFI_STA);
    LOG('I', "demo", "connecting to Wi-Fi \"%s\"", MISSING_AP);
    WiFi.begin(MISSING_AP, "not-a-real-password");
  }

  if (DEMO_SCENARIO == 3) {
    esp_task_wdt_config_t cfg = {.timeout_ms = 3000, .idle_core_mask = 0, .trigger_panic = true};
    if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);  // not started by the core: start it
    esp_task_wdt_add(nullptr);
    LOG('I', "demo", "processing sensor queue…");
    delay(1000);
    LOG('W', "demo", "sensor queue never empties; the loop no longer feeds the watchdog");
    while (true) {
      // the bug: a busy wait for data that never comes, without delay() or a watchdog reset
    }
  }
}

void loop() {
  static unsigned long last = 0;
  static int lastButton = HIGH;
  unsigned long now = millis();

  if (DEMO_SCENARIO == 1 && now > 5000) crashNow("sensor buffer used before allocation");

  if (DEMO_SCENARIO == 0) {
    int button = digitalRead(BOOT_PIN);
    if (lastButton == HIGH && button == LOW) crashNow("BOOT pressed: simulating a bug");
    lastButton = button;
  }

  if (now - last >= 2000) {
    last = now;
    float temperature = 24.0f + (esp_random() % 30) / 10.0f;
    int humidity = 45 + esp_random() % 10;
    if (DEMO_SCENARIO == 2 && WiFi.status() != WL_CONNECTED) {
      LOG('W', "demo", "still offline, retrying Wi-Fi");
      WiFi.reconnect();
    } else {
      LOG('I', "demo", "temperature=%.1f C humidity=%d%% heap=%u", temperature, humidity, ESP.getFreeHeap());
    }
  }
  delay(20);
}
