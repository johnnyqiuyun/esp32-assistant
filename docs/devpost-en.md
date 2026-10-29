# ESP32 Assistant — Devpost description (English)

**Track:** Physical AI
**Repository:** https://github.com/johnnyqiuyun/esp32-assistant (MIT)
**Tagline:** Plug in an ESP32-S3 and know in seconds whether it works, what it is doing, and — with NVIDIA Nemotron on Nebius — why it is failing and how to fix it.

## Inspiration

Bringing up a microcontroller board means juggling Device Manager, esptool, a serial terminal and a search engine.
Logs like `rst:0xc (RTC_SW_CPU_RST)` or `reason: 202` mean nothing to a beginner, and even experienced engineers lose time on reboot loops.
We wanted the AI coding agent we already use to also understand the physical board on the desk.

## What it does

ESP32 Assistant is a plugin for Velloc Code (and Claude Code) with a live pane beside the chat:

- **Finds boards automatically** within 2 seconds of plugging in, and flags a missing USB driver with the fix.
- **Identifies the chip**: model, revision, flash size, PSRAM, MAC.
- **Live serial monitor** that starts by itself, and a **plain-language verdict** at the top of each board: running normally, crashed, keeps restarting, stuck in download mode, no firmware, silent. Reset reasons and Wi-Fi disconnect codes are translated into words.
- **🤖 AI diagnosis with NVIDIA Nemotron on Nebius Token Factory**: one click sends the chip facts, the monitor summary and the last 80 log lines to `nvidia/Nemotron-3_5-Lightning`. It returns the root cause (quoting the log line that proves it), up to four fix steps and a confidence level, in about 2 seconds. The card shows which model answered and exactly what was sent.
- **Safe flashing** of merged firmware images, with a confirmation card (port, file, size, estimated time), a progress bar and image checks that refuse the wrong chip or a partial image.
- **Demo firmware** (Arduino, four scenarios: healthy, crash, Wi-Fi failure, watchdog loop) so anyone can reproduce the failures.

## How we built it

- **Pane:** a Velloc mod in JavaScript, written as pure render functions (same state → same UI), polling a small file protocol.
- **Back end:** Python with pyserial and esptool. A background monitor process owns the serial port and writes state and log files; flashing pauses the monitor and resumes it to capture the new boot log.
- **AI:** Nebius Token Factory's OpenAI-compatible API, standard library only. We tuned the prompt with real failures: rules against false alarms (no "re-flash" advice for a healthy board), `reasoning_effort: "none"` so the answer stays short JSON, and a tolerant parser for small JSON slips.
- **Testing:** test-driven, 113 Python and 131 JavaScript unit tests, plus verification on a real ESP32-S3 (16 MB flash, 8 MB PSRAM, CP2102N).

## Challenges

- The host runtime had undocumented limits (child processes die when a call returns, no text input, environment variables not visible). We mapped them with small spikes and designed around them.
- Reset garbage: after each reboot the UART emits stray bytes, including a NUL, right before `ESP-ROM:`. It hid reboot loops and even blanked the UI. We now clean every line in the monitor, the pane and the AI context.
- Keeping a model honest: early answers suggested re-flashing healthy boards. Grounding the prompt in the monitor's facts fixed it.

## Accomplishments

- A reboot loop goes from "mystery" to an evidence-backed root cause in two seconds.
- Nothing writes to the board except flashing, and flashing always asks first.

## What's next

- Automatic diagnosis when a crash is detected; decoding backtraces against the ELF.
- Letting the coding agent apply the suggested fix, rebuild and re-flash in one loop.
- More chips (ESP32-C3/C6) and macOS/Linux.

## Built with

NVIDIA Nemotron · Nebius Token Factory · Python · pyserial · esptool · JavaScript · Velloc Code · Arduino / ESP-IDF · ESP32-S3
