---
description: Reset the ESP32-S3 and explain its boot log (115200 baud)
argument-hint: "[COM port] [seconds]"
---

Use the esp32s3-bringup skill. Run `log` with `--port` from $ARGUMENTS (otherwise use `$ESP_PORT`, or find it with `ports`), plus `--seconds` if a number was given. Tell the user this resets the board once. Show the log, then explain the key lines: reset reason, boot mode, PSRAM test, project and IDF version, warnings, errors, panics and reboot loops.
