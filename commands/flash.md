---
description: Flash a merged .bin to the ESP32-S3 (asks before writing), then show the new boot log
argument-hint: "<file.merged.bin> [COM port]"
---

Use the esp32s3-bringup skill (its Flashing section). File and optional port: $ARGUMENTS

1. Find the port: from the arguments, `$ESP_PORT`, or `ports` (if more than one board is found, ask which one).
2. Run `flash --port <port> <file> --json` without `--yes`, adding `--flash-size` from `probe` if known. If it returns `bad_image`, explain the reason and stop.
3. Tell the user the port, the full file path and its size, and that this replaces the program on the board. Ask for a clear yes. Do not continue without one.
4. Run `flash --port <port> <file> --yes --wait` with the longest tool timeout available (e.g. 600000 ms); a tool timeout would cut the write in half. For an image that may take longer, run it without `--wait` and poll `monitor status --port <port> --json` until `flash.state` is `done` or `failed`. Report the result.
5. Show the new boot log (`monitor status --port <port> --json` if a monitor is running, otherwise `log --port <port>`) and say whether the new firmware started normally.
