# esp32s3-bringup

A Claude Code / Velloc plugin for checking an ESP32-S3 board over USB. It finds
the board, reads the chip without writing anything, and explains the boot log.
In Velloc it also adds an **ESP32 pane** that shows which boards are plugged in
and what they are.

Everything is **read-only**: no flash writes, no erase, no eFuse changes.

## Contents

| Path | What it is |
|---|---|
| `scripts/esp32_bringup.py` | The CLI that does the hardware work (pyserial + esptool): `ports`, `probe`, `log` |
| `skills/esp32s3-bringup/SKILL.md` | Workflow, boot-log decoding, S3 board pitfalls |
| `commands/bringup.md` | `/esp32s3-bringup:bringup`: find → check → boot log |
| `commands/log.md` | `/esp32s3-bringup:log`: reset and explain the boot log |
| `hooks/` | Velloc mod: `panel.js` (wiring), `core.js` (state), `view.js` (pane), `texts.js` |
| `locales/` | Pane text, `zh` and `en` |

## Velloc pane

`/esp32` opens it. Every 2 s it lists ESP-style USB serial ports (CP210x, CH340,
FTDI, Espressif native USB) **without opening them**, and every ~10 s it also checks
for devices with a missing driver. A new board shows **Check**. Pressing it resets
the board once and reads the chip. After that the board is remembered by its USB
serial number and is shown straight away whenever it is plugged in, with no reset.
A port that appears later in the session opens the pane without taking focus.

## Requirements

- Python 3.10+ with `pyserial` and `esptool` (`python -m pip install --user pyserial esptool`).
  The pane looks for `%ESP_PYTHON%`, then `%LOCALAPPDATA%\Programs\Python\Python31x\python.exe`, then `py -3`.
- A USB-UART driver for the board's bridge (CP210x / CH340 / FTDI). The native USB port needs none.

## Install

**Velloc:** copy this directory to `%USERPROFILE%\.velloc\plugins\esp32s3-bringup\`
(without `.git`, `docs`, `tests`), add `"esp32s3-bringup"` to
`%USERPROFILE%\.velloc\enabled-plugins.json`, and restart Velloc. Velloc does not
reload a changed mod until it restarts.

**Claude Code:**
```
/plugin marketplace add J:\2_MY_WORK\ESP32\esp32s3-bringup
/plugin install esp32s3-bringup@esp32s3-bringup
```

## Script usage

```
python scripts/esp32_bringup.py ports --drivers
python scripts/esp32_bringup.py probe --port COM4
python scripts/esp32_bringup.py log --port COM4 --seconds 6
```

Every command takes `--json`. `--port` defaults to `$ESP_PORT`.

## Tests

```
python -m unittest discover -s tests
node --test "tests/*.test.js"
```

## Tested on

ESP32-S3 (QFN56) rev v0.2, 16 MB flash, 8 MB PSRAM, CP2102N bridge; esptool 5.6.0,
Python 3.13, Node 22, Velloc 1.155.2.4, Windows 11.

## License

MIT
