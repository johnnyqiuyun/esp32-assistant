# Spike notes (plan Task 1), 2026-10-28

Throwaway mod `esp32-spike` (removed after this note).

- INSTALL_METHOD = A
  Copy the plugin directory to `%USERPROFILE%\.velloc\plugins\<name>\` and add `<name>` to
  `%USERPROFILE%\.velloc\enabled-plugins.json` → restart Velloc. Velloc compiled it into
  `%USERPROFILE%\.velloc\mods\.builds\esp32-spike@<hash>.json` and `/esp32-spike` opened the pane
  (user confirmed: "有反应 右侧也有ui … ticks在计数").
  Velloc does NOT hot-reload a changed mod file: editing spike.js produced no new build; a restart is needed.
- BACKGROUND_POLL = true
  `$.clock.every(2000)` wrote a counter to `$.store` (`%USERPROFILE%\.velloc\mods\esp32-spike\store.json`):
  45 at 13:32:33 → 2047 at 14:37:37 (~30/min for 65 min) while the user sent no messages.
- STATUS_LINE = false
  Not observed: the user did not report a status line, and the diagnostics that would have
  recorded `$.ui.status` were never loaded (no hot reload). Status line is optional in the design.
- `$.process.run`: not directly observed in Velloc (same reason). panel.js was smoke-tested with a
  fake `$` whose `process.run` spawns the real Python; final acceptance in Velloc verifies it.
- `$.store` persists as JSON at `%USERPROFILE%\.velloc\mods\<plugin>\store.json`.

# Spike notes, phase 2 (plan Task 1), 2026-10-28

Throwaway mod `esp32-spike2` (removed after this note).

- DETACH_FLAGS = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW (+ CREATE_BREAKAWAY_FROM_JOB, falling back without it)
  Inside Velloc, CREATE_BREAKAWAY_FROM_JOB is refused (WinError 5): Velloc runs `$.process.run` children in a job
  object that does not allow breakaway.
- DETACHED_SURVIVES_RUN = false
  The "detached" grandchild never wrote its file: it is killed together with the job when `$.process.run` returns.
  The same launcher run from a normal terminal works (child kept running), so this is Velloc's containment.
- TIMEOUT_KILLS_CHILD = true  ("$.process.run: the command did not finish within 3000ms; it was stopped").
- LONG_RUN_WORKS = true
  `$.process.run([py, sleeper.py], { timeoutMs: 86400000 })` without awaiting keeps the child running
  (observed ~100 s of continuous updates), and other `$.process.run` calls work meanwhile (print(42) in 184 ms).
- LONG_RUN_KILLED_ON_VELLOC_EXIT = true
  The child stopped updating at 15:57:05 and its process was gone; Velloc was not running at 15:57:12.
  (Observed once, timed by the user quitting Velloc.)
- FS_READ_OUTSIDE_PLUGIN = true  (`$.fs.read` of %LOCALAPPDATA%\esp32s3-bringup\spike\sleeper.json returned its content).
- LINK_OPENS_FOLDER = false  (user: the Link did not open a folder).
- INPUT_WORKS = false  (user: no input box was shown in the pane).

Decision (user chose option A): in Velloc the monitor and the flash job run as long, un-awaited
`$.process.run` calls that live as long as the Velloc session; no detaching from Velloc's job object.
