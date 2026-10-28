---
name: esp32s3-bringup
description: Use when an ESP32-S3 board (DevKitC-1, N16R8 modules, any S3 dev board) is plugged in over USB and the user wants to find it, check whether it works, or read its boot log. Also read when esptool cannot connect, when no COM port appears, when Device Manager shows a CP210x/CH340 device with error code 28, when the boot log is garbage, or when the board keeps rebooting.
---

# ESP32-S3 bring-up

All hardware access goes through one script. Everything in it is **read-only**:
it never writes flash, eFuses or memory. Do not run esptool write/erase commands
for the user from this skill.

```
<python> "${CLAUDE_PLUGIN_ROOT}/scripts/esp32_bringup.py" <command> [--port COMx] [--json]
```

| Command | What it does | Resets the board? |
|---|---|---|
| `ports [--drivers]` | Lists USB serial ports from CP210x / CH340 / FTDI / Espressif native USB, with serial numbers. `--drivers` also lists such devices whose driver is missing (Windows). Does not open any port. | No |
| `probe --port COMx` | Reads chip, revision, features, PSRAM, crystal, MAC and flash (esptool `flash-id`). On failure reports `busy`, `no_response` or `error`. | Once |
| `log --port COMx [--seconds 6]` | Resets the board, captures 115200-baud output, and prints a summary. | Once |

`--port` defaults to `$ESP_PORT`. Once you know the board's port, pass it on every call.

## Environment

- Needs `pyserial` and `esptool`. If they are missing: `<python> -m pip install --user pyserial esptool`.
- Windows: bare `python` may be the Microsoft Store alias (does nothing, exit code 49)
  or an MSYS2 Python. Use the full path to a real install, e.g.
  `%LOCALAPPDATA%\Programs\Python\Python313\python.exe`.
- PowerShell 5.1 turns native stderr into error records when you add `2>&1`. Read the text and don't treat that as a failure.

## Workflow

1. **Find**: run `ports --drivers`.
   - No port and no missing-driver device usually means a charge-only cable, the
     wrong USB connector, or no power. Many S3 boards have two USB-C connectors:
     **USB** (native, VID 303A) and **UART/COM** (CP2102N or CH343 bridge). Try both.
   - A missing-driver row with error code **28** means the bridge has no driver
     installed. Install it from Device Manager → Update driver → Search
     automatically, or from Windows Update → Optional updates (look for
     "Silicon Laboratories Inc. - Ports"). The install needs administrator rights,
     so ask the user to run it.
2. **Identify**: run `probe`. Report the chip, revision, flash size, PSRAM and MAC.
   - `busy`: another program holds the port (idf.py monitor, a serial terminal,
     the Velloc ESP32 pane while it is checking). Close it and retry.
   - `no_response`: hold **BOOT**, press **RST**, release BOOT, then retry. If the
     native USB port vanished, the running app may have taken it over; this
     makes it reappear in download mode.
3. **Boot log**: run `log` and explain the summary (see below).

## Reading the ESP32-S3 boot log

Unlike the ESP8266, the S3 prints ROM and app output at the same baud rate, **115200**.

- `rst:0x..` is the reset cause: `0x1 POWERON` (power-on, and also an EN reset
  through the USB bridge), `0x3 RTC_SW_SYS_RST` (software reset, `esp_restart`),
  `0xc RTC_SW_CPU_RST` (CPU reset, usually after a panic), `0xf RTCWDT_RTC_RST`
  (RTC watchdog).
- `boot:0x8 (SPI_FAST_FLASH_BOOT)` means it booted from flash. A `DOWNLOAD` boot
  mode means GPIO0/BOOT was held low.
- `esp_psram: SPI SRAM memory test OK` means the PSRAM self-test passed.
- `Project name`, `App version`, `ESP-IDF` identify the firmware.
- `Detected size(16384k) larger than the size in the binary image header(4096k)`
  is harmless. The firmware was built for a smaller flash; set Flash size in
  `menuconfig` to use all of it.
- `Guru Meditation Error`, `abort() was called`, or more than one `ESP-ROM:` banner
  in a few seconds means the firmware is crashing or rebooting in a loop.
- A Wi-Fi app that prints RSSI as a small positive number is not reporting a real
  RSSI. Real RSSI values are negative dBm.

## Velloc pane

In Velloc this plugin also runs a mod (`hooks/panel.js`). `/esp32` opens a pane
that lists ESP serial ports every 2 s **without opening them**. A board is
remembered by USB serial number after it has been checked once. The pane checks
a board only when the user presses **Check**, so it never resets a board by
itself. If the pane says "port busy", the user's monitor or flasher has the port,
which is expected.

## Reporting

Report what the board itself returned (chip, MAC, flash size, PSRAM, reset reason,
warnings) separately from advice. Always give the COM port.
