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
