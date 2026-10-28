---
name: esp32s3-bringup
description: Use when an ESP32-S3 board (DevKitC-1, N16R8 modules, any S3 dev board) is plugged in over USB and the user wants to find it, check whether it works, read its boot log, watch its serial output or Wi-Fi state, or flash a merged .bin (Arduino or ESP-IDF). Also read when esptool cannot connect, when no COM port appears, when Device Manager shows a CP210x/CH340 device with error code 28, when the boot log is garbage, or when the board keeps rebooting.
---

# ESP32-S3 bring-up

All hardware access goes through one script. Everything in it is **read-only except
`flash`**, the one command that writes flash, and it refuses to write without `--yes`.
Never run `flash --yes`, or any esptool write/erase/efuse command, without first telling
the user the port, the file and its size and getting their explicit agreement.

```
<python> "${CLAUDE_PLUGIN_ROOT}/scripts/esp32_bringup.py" <command> [--port COMx] [--json]
```

| Command | What it does | Resets the board? |
|---|---|---|
| `ports [--drivers]` | Lists USB serial ports from CP210x / CH340 / FTDI / Espressif native USB, with serial numbers. `--drivers` also lists such devices whose driver is missing (Windows). Does not open any port. | No |
| `probe --port COMx` | Reads chip, revision, features, PSRAM, crystal, MAC and flash (esptool `flash-id`). On failure reports `busy`, `no_response` or `error`. | Once |
| `log --port COMx [--seconds 6]` | Resets the board, captures 115200-baud output, and prints a summary. | Once |
| `monitor start\|status\|stop\|pause\|resume\|reset\|retry\|list --port COMx` | Background serial monitor (see below). | `start` no; `reset` yes |
| `reset --port COMx` | Resets the board (through its monitor when one runs). | Once |
| `flash --port COMx FILE.bin --yes --wait` | **Writes** a merged image at 0x0 (see below). | Once, after writing |

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

## Monitor

- `monitor start` starts a background process that owns the port, writes every line with a
  timestamp to `%LOCALAPPDATA%\esp32s3-bringup\logs\<USB serial or port>\*.log` and keeps a state
  file with a live summary (boots, last reset reason, crash, errors/warnings, Wi-Fi state, IP,
  disconnect reason, RSSI). `monitor status --json` returns it plus the last lines.
  Opening the port does not reset the board.
- `probe`, `log` and `flash` pause a running monitor, then resume it and let it reset the board so
  the boot banner lands in the log. `log` with a monitor running reads the monitor's log instead of
  opening the port.
- States: `running`, `paused`, `waiting` (port vanished, reopened when it is back), `busy` (another
  program holds the port; not retried until `monitor retry` or an unplug/replug), `stopped`.
- Before flashing or monitoring with **another** tool (idf.py, Arduino IDE), run `monitor pause`
  (or `stop`), or press Pause in the Velloc pane.
- A monitor started from the command line exits on its own after 10 minutes without a heartbeat
  (`monitor status` refreshes it). Monitors started by the Velloc pane end with the Velloc session.

## Flashing

Only merged single images, written at 0x0:
- Arduino IDE: Sketch → Export Compiled Binary → `<sketch>.ino.merged.bin`.
- ESP-IDF: `idf.py merge-bin` (output in `build/`).

1. Run `flash --port COMx FILE --json` **without** `--yes`. It checks the file (exists, not empty,
   first byte 0xE9, built for ESP32-S3, partition table at 0x8000, not larger than the flash
   given with `--flash-size`) and returns `needs_yes` with the plan, or `bad_image` with the
   reason (`missing`, `empty`, `not_esp_image` (an ELF or other file), `wrong_chip`,
   `not_merged` (an app-only or bootloader .bin, which would brick the boot if written at 0x0),
   `too_big`).
2. Tell the user the port, the file and its size, and that it replaces the program on the board.
   Ask. Only after a clear yes:
3. `flash --port COMx FILE --yes --wait` (add `--flash-size 16MB` from `probe` when known). It
   pauses a monitor, writes at 460800 baud with verification, and resumes the monitor, which
   resets the board. Then show the new boot log (`monitor status` or `log`).
   **Run it with the longest tool timeout you have (e.g. 600000 ms).** A tool timeout kills the
   process mid-write and leaves a half-written board. A 4 MB image takes about 20 s, a 16 MB
   one about 80 s. If the image may take longer than your timeout, run it **without** `--wait`
   (it starts a background job) and poll `monitor status --port COMx --json` until `flash.state`
   is `done` or `failed`. Never interrupt a flash that is running.

Failure reasons: `busy` (port held by another program), `no_response` (hold BOOT and press RST),
`already_flashing`, `error`.

In Velloc the user can also flash from the pane: `/esp32 flash <path> [COMx]`, then Confirm.

## Wi-Fi disconnect reasons (ESP-IDF)

2 auth expired · 8 left on purpose · 15 4-way handshake timeout (wrong password?) · 200 beacon
timeout (weak signal / AP off) · 201 network not found · 202 auth failed (wrong password?) ·
203 association failed · 204 handshake timeout (wrong password?) · 205 connection failed.

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
a board only when the user presses **Check**. For a board known to be an ESP
(checked before, or Espressif native USB) it starts the serial monitor by itself; that
opens the port without resetting the board. Stop in the pane keeps it stopped until the
board is unplugged. If the pane says "port busy", the user's monitor or flasher has the port,
which is expected.

## Reporting

Report what the board itself returned (chip, MAC, flash size, PSRAM, reset reason,
warnings) separately from advice. Always give the COM port.
