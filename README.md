# ESP32 Assistant (esp32s3-bringup)

**Plug in an ESP32-S3 and know in seconds whether it works, what it is doing, and — with NVIDIA Nemotron on
Nebius Token Factory — why it is failing and how to fix it.**
Built for the Nebius × NVIDIA Global AI Hackathon (Physical AI track).

- Project description: [docs/devpost-en.md](docs/devpost-en.md) · intro slides: [docs/ESP32-Assistant.pptx](docs/ESP32-Assistant.pptx) · demo firmware: [demo-firmware/](demo-firmware/)
- 中文作品说明：[docs/作品说明.md](docs/作品说明.md) · 界面设计原则：[docs/design-ux.md](docs/design-ux.md)

**Human-centred pane (v0.3):** each board gets one plain-language verdict with the next step
(running normally / crashed / restarting in a loop / port held by another program / download mode …),
a compact spec line with details on demand, a Wi-Fi row with signal bars, restart reasons in plain
words, a filterable log, and a flash flow with a confirm card, progress bar and result advice.

A Claude Code / Velloc plugin for checking an ESP32-S3 board over USB. It finds
the board, reads the chip without writing anything, and explains the boot log.
In Velloc it also adds an **ESP32 pane** that shows which boards are plugged in
and what they are.

It can also run a background **serial monitor** (live log + board/Wi-Fi summary) and
**flash** a merged `.bin`.

Everything is **read-only except `flash`**, which writes only when given `--yes`
(the skill asks the user first; the pane asks for confirmation). No erase, no eFuse changes.

## Contents

| Path | What it is |
|---|---|
| `scripts/esp32_bringup.py` | The CLI (pyserial + esptool): `ports`, `probe`, `log`, `monitor`, `reset`, `flash` |
| `scripts/esp_monitor.py` | Monitor process, file protocol, live summary, flash job |
| `skills/esp32s3-bringup/SKILL.md` | Workflow, boot-log decoding, S3 board pitfalls |
| `commands/bringup.md` | `/esp32s3-bringup:bringup`: find → check → boot log |
| `commands/log.md` | `/esp32s3-bringup:log`: reset and explain the boot log |
| `commands/flash.md` | `/esp32s3-bringup:flash`: check a merged .bin, ask, flash, show the new boot log |
| `hooks/` | Velloc mod: `panel.js` (wiring), `core.js` (state), `view.js` + `monitor-view.js` (pane), `texts.js` |
| `locales/` | Pane text, `zh` and `en` |

## Velloc pane

`/esp32` opens it. Every 2 s it lists ESP-style USB serial ports (CP210x, CH340,
FTDI, Espressif native USB) **without opening them**, and every ~10 s it also checks
for devices with a missing driver. A new board shows **Check**. Pressing it resets
the board once and reads the chip. After that the board is remembered by its USB
serial number and is shown straight away whenever it is plugged in, with no reset.
A port that appears later in the session opens the pane without taking focus.

## AI diagnosis (NVIDIA Nemotron on Nebius Token Factory)

Each board card has a **🤖 AI diagnosis** button. It becomes the highlighted action when the verdict is a problem
(crash, reboot loop, download mode…). It sends the board description, the monitor summary (status, boots,
last reset reason, error/warning counts, Wi-Fi state) and the last 80 log lines to an **NVIDIA Nemotron**
model on **Nebius Token Factory**, and shows the likely cause with the log line that proves it, up to four
fix steps, and a confidence. Nothing is sent until the button is pressed; the card says what was sent.

- Key: `setx NEBIUS_API_KEY "your-key"` (then restart Velloc). Model: `ESP32_AI_MODEL`, default `nvidia/Nemotron-3_5-Lightning`.
- CLI: `python scripts/esp32_bringup.py explain --port COM4 --lang en`.
- Standard library only (`urllib`), OpenAI-compatible `chat/completions` API.

## Serial monitor

Each board card in the pane has a monitor section: a summary line (running / crashed, boots,
uptime, Wi-Fi state, IP, disconnect reason, RSSI), buttons (Stop, Pause/Resume, Reset, Clear,
Retry when busy) and the last 200 lines, coloured: errors red, warnings yellow, Wi-Fi cyan,
panics bold red. A board known to be an ESP starts monitoring by itself; opening the port does
not reset it. Pressing Stop keeps it stopped until the board is unplugged.

`probe`, `log` and `flash` pause the monitor and resume it afterwards. Another tool (idf.py,
Arduino IDE) can't take the port while the monitor holds it: press Pause first. When another
program already holds the port, the monitor shows "port busy" and waits for Retry.

Logs: `%LOCALAPPDATA%\esp32s3-bringup\logs\<USB serial>\YYYYMMDD-HHMMSS.log` (5 MB per file,
50 files kept per board). Override the data folder with `ESP32_BRINGUP_HOME`.

In Velloc the monitor runs inside the Velloc session and ends with it. Started from the command
line (`monitor start`) it runs detached and exits after 10 minutes without a `monitor status`.

## Flashing

Only merged single images, written at 0x0 (Arduino: Export Compiled Binary →
`*.ino.merged.bin`; ESP-IDF: `idf.py merge-bin`).

- Velloc: `/esp32 flash C:\path\to\fw.merged.bin [COMx]`, then press **Flash it** in the pane;
  progress shows as a percentage, then the new boot log.
- Chat: ask the AI to flash a file; it checks the file and port and asks you before writing.
- CLI: `python scripts/esp32_bringup.py flash --port COM4 fw.merged.bin --yes --wait`.

The image must start with 0xE9 (an ELF or other file is refused) and fit the board's flash.

## Requirements

- Python 3.10+ with `pyserial` and `esptool` (`python -m pip install --user pyserial esptool`).
  The pane looks for `%ESP_PYTHON%`, then `%LOCALAPPDATA%\Programs\Python\Python31x\python.exe`, then `py -3`.
- A USB-UART driver for the board's bridge (CP210x / CH340 / FTDI). The native USB port needs none.

## Install

**Velloc:** copy this directory to `%USERPROFILE%\.velloc\plugins\esp32s3-bringup\`
(without `.git`, `docs`, `tests`), add `"esp32s3-bringup"` to
`%USERPROFILE%\.velloc\enabled-plugins.json`, and restart Velloc. Velloc does not
reload a changed mod until it restarts.

**Claude Code:** (from GitHub, or give a local clone's path instead of `johnnyqiuyun/esp32-assistant`)
```
/plugin marketplace add johnnyqiuyun/esp32-assistant
/plugin install esp32s3-bringup@esp32s3-bringup
```
Then restart Claude Code. Claude Code has no pane; use the commands
`/esp32s3-bringup:bringup`, `/esp32s3-bringup:log`, `/esp32s3-bringup:flash`, or just ask
("is my ESP32 working?", "why does it keep rebooting?").

## Script usage

```
python scripts/esp32_bringup.py ports --drivers
python scripts/esp32_bringup.py probe --port COM4
python scripts/esp32_bringup.py log --port COM4 --seconds 6
python scripts/esp32_bringup.py monitor start --port COM4
python scripts/esp32_bringup.py monitor status --port COM4 --json
python scripts/esp32_bringup.py monitor stop --port COM4
python scripts/esp32_bringup.py flash --port COM4 fw.merged.bin            # prints the plan only
python scripts/esp32_bringup.py flash --port COM4 fw.merged.bin --yes --wait
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
