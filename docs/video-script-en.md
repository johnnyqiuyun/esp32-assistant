# Demo video script (English, ≤ 3 min)

About 420 words of narration, which is roughly 2:50 at a calm TTS pace (Clipchamp: "Text to speech", English (US), speed 1.0).
Record the screen first, then lay the narration on the timeline. Each block below is one TTS clip.

Preparation:
- The board has `demo-healthy.merged.bin` on it. Velloc is open with the `/esp32` pane visible. The board is unplugged.
- Keep `demo-firmware/bin/demo-watchdog.merged.bin` and `demo-healthy.merged.bin` ready to type.

| Time | Screen | Narration |
|---|---|---|
| 0:00 – 0:15 | Board in hand, then Velloc with the empty pane ("no board found" + checklist). | Every embedded developer knows this moment: you plug in a board and you have no idea whether it works, what it is running, or why it keeps rebooting. ESP32 Assistant puts the answer in one pane, right next to your AI coding agent. |
| 0:15 – 0:35 | Plug the board in. The card appears within 2 s. Click **Identify chip**. | Plug in an ESP32-S3 and it shows up in two seconds. One click identifies it: sixteen megabytes of flash, eight of PSRAM, two hundred forty megahertz. Missing USB driver? It tells you, and how to fix it. |
| 0:35 – 0:55 | Green verdict "Program running normally". Scroll the live log, click the **Errors / warnings** filter, click **Reset**. | The serial monitor starts on its own. Instead of a wall of logs, you get a verdict in plain words: the program is running, how long, and why it last restarted. Errors and warnings are colored and can be filtered. |
| 0:55 – 1:15 | Type `/esp32 flash …\demo-watchdog.merged.bin COM4`. The confirm card shows port, file, size, estimated time. Confirm. Progress bar to 100 %. | Now let's break it. I flash a firmware with a hidden bug. Flashing is the only write the tool ever makes, so it always asks first, and it checks that the image really is a merged ESP32-S3 image before touching the chip. |
| 1:15 – 1:35 | The verdict turns red: "Board keeps restarting (N times)". The log shows red `task_wdt` lines. | Within seconds the verdict turns red: the board keeps restarting. The log is full of task watchdog errors. For a beginner, this is where the afternoon disappears. |
| 1:35 – 2:10 | Click **🤖 AI diagnosis** (it is highlighted). The result card appears: cause, steps, confidence, "nvidia/Nemotron-3_5-Lightning · 2.0 s", and what was sent. | So I click AI diagnosis. The plugin sends the chip facts, the monitor's summary and the last eighty log lines to NVIDIA Nemotron on Nebius Token Factory. Two seconds later: a task watchdog timeout — the loop task never feeds the watchdog while processing the sensor queue. It quotes the evidence, gives concrete fixes, and says how confident it is. The card also shows exactly which model answered and what data left the machine. |
| 2:10 – 2:30 | Flash `demo-healthy.merged.bin` (confirm card, progress). The verdict turns green again. | Apply the fix, flash again, and the board is back to green. From a mystery reboot loop to a working board, without leaving the editor. |
| 2:30 – 2:50 | Architecture slide or the README diagram; then the test run (`unittest` + `node --test`) scrolling by. | Under the hood: a Velloc mod written as pure render functions, a Python back end built on esptool and pyserial, and a background monitor that shares the port safely. Everything is read-only except flashing. Over two hundred forty unit tests, verified on real hardware. |
| 2:50 – 3:00 | Repo page on GitHub, logo / title card. | ESP32 Assistant: physical hardware, explained by NVIDIA Nemotron on Nebius. It's open source — link below. |

Tips:
- Hide the Nebius API key: never open `%LOCALAPPDATA%\esp32s3-bringup\nebius-api-key` or a terminal with `NEBIUS_API_KEY` on screen.
- If the AI answer differs slightly from the narration, trim the narration of the 1:35 block to "a task watchdog timeout in the loop task" — that part is stable.
- Speed up the flash progress (2×) in the editor if needed; keep the confirm card readable for at least 2 s.
