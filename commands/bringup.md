---
description: Find a USB-connected ESP32-S3, check it (read-only) and read its boot log
argument-hint: "[COM port]"
---

Use the esp32s3-bringup skill to check the ESP32-S3 the user has connected. Port hint: $ARGUMENTS

1. Run `ports --drivers`. If no port is found, explain the likely cause (missing driver with its error code, cable, wrong USB connector) and stop.
2. Tell the user that checking resets the board once. Then run `probe --port <port>` and report the chip, revision, flash, PSRAM, crystal and MAC.
3. Run `log --port <port>` and explain the reset reason, boot mode, PSRAM self-test, firmware name and IDF version, and any warnings, errors, panics or reboot loops.
4. Summarise the results in a table with a one-line verdict: working, or what is wrong.
