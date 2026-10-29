/**
 * ESP32 bring-up in the Velloc session: a pane that shows which ESP boards are
 * plugged in and what they are.
 *
 * - Every SCAN_EVERY ticks it runs `esp32_bringup.py ports --json`, which lists USB
 *   serial ports without opening them, so polling never resets a board. Every
 *   DRIVER_EVERY ticks it also asks Windows for devices with a missing driver.
 * - It never opens a serial port on its own. `probe` (which resets the board
 *   once) runs only when the person presses Check / Check again.
 * - Probe results are kept in `$.store` under STORE_KEY by USB serial number,
 *   so a board plugged in again shows its last result without being reset.
 * - `/esp32` scans and opens the pane; a newly plugged port opens it without
 *   taking focus.
 *
 * Runtime facts (worker lifetime, status line) are from docs/spike-notes.md.
 */

import {
  applyProbe, forgetStopped, liveJob, liveMonitor, newPorts, parseFlashArgs, pythonCandidates, recordKey, reconcile, shouldAutostart,
} from './core.js'
import { loadTexts } from './texts.js'
import { paneTree, statusText } from './view.js'

const PANE_ID = 'esp32'
const COMMAND = 'esp32'
const TICK_MS = 1000
const SCAN_EVERY = 2 // ticks
const DRIVER_EVERY = 10 // ticks
const STATUS_CLOSED_EVERY = 5 // ticks between monitor reads while the pane is closed
const AUTOSTART_BACKOFF_MS = 10000
// Velloc ends a $.process.run child when the call returns (spike 2), so a monitor or flash job runs as one
// long call that is not awaited; Velloc ends it with the session.
const MONITOR_RUN_TIMEOUT_MS = 24 * 3600 * 1000
const FLASH_TIMEOUT_MS = 35 * 60 * 1000
const CONTROL_TIMEOUT_MS = 10000
const AI_TIMEOUT_MS = 90000 // explain allows the model 60 s
const PORTS_TIMEOUT_MS = 10000
const PROBE_TIMEOUT_MS = 40000
const PY_CHECK_TIMEOUT_MS = 10000
const STORE_KEY = 'boards'
const VIEW = { plugin: 'esp32s3-bringup', key: 'view' } // the pane's view, in $.state (types/index.d.ts)
const STORE_ALIAS_EXIT = 49 // the Microsoft Store "python" placeholder
const BACKGROUND_POLL = true
const STATUS_LINE = false

export function register(on) {
  // The engine's interface, reached only through closures made in a hook ($ is never stored or passed:
  // Claude Code refuses a module that does). Velloc runs the same code.
  let io = null
  let t = key => key
  let python = null // argv prefix of a working interpreter
  let pythonResolved = false // a failed lookup is cached too; Refresh or /esp32 retries it
  let pythonState = { state: 'ok' }
  let records = {}
  let transient = {}
  let scan = []
  let missingDriver = null
  let ticks = 0
  let scanning = false
  let firstScan = true
  let paneOpen = false
  let publishing = Promise.resolve()
  let home = ''
  let monitors = {} // port -> { monitor, lines, flash } read from the monitor's files
  const runs = {} // port -> true while a monitor started by this pane is running
  const lastStart = {} // port -> ms of the last automatic start
  let stoppedPorts = []
  const clearAt = {}
  const flashDraft = {}
  const expanded = {} // port -> details shown
  const logFilter = {} // port -> 'all' | 'problems' | 'wifi'
  const logMore = {} // port -> show 200 lines instead of 30
  const flashDismissed = {} // port -> startedAt of the flash result the person closed
  const ai = {} // port -> AI diagnosis: { state: 'running' } | result of `explain --json` with state 'done' | 'failed'
  let pluginRoot = ''
  const script = () => `${pluginRoot}/scripts/esp32_bringup.py`

  async function quietly(action, fallback) {
    try { return await action() } catch { return fallback }
  }

  function currentView() {
    return {
      boards: reconcile(scan, records, transient),
      missingDriver,
      python: pythonState,
      polling: BACKGROUND_POLL ? 'background' : 'pane',
      monitors,
      clearAt,
      flashDraft,
      logDir: `${home}\\logs`,
      linkOpensFolder: false, // spike 2: a Link cannot open a local folder
      now: Date.now(),
      expanded,
      logFilter,
      logMore,
      flashDismissed,
      ai,
    }
  }

  async function readJson(path) {
    return quietly(async () => JSON.parse(await io.read(path)), null)
  }

  async function readMonitors() {
    if (!home) return
    const now = Date.now()
    const next = {}
    for (const { port } of scan) {
      const state = await readJson(`${home}\\monitors\\${port}.json`)
      const flash = await readJson(`${home}\\jobs\\${port}.flash.json`)
      const live = liveMonitor(state, now)
      next[port] = { monitor: live ?? (state ? { ...state, state: 'stopped' } : null), lines: live?.tail ?? state?.tail ?? [],
        flash: liveJob(flash, now) }
    }
    monitors = next
  }

  function startMonitor(port) {
    if (runs[port] || !python) return
    const entry = scan.find(p => p.port === port)
    runs[port] = true
    lastStart[port] = Date.now()
    void io.run([...python, script(), 'monitor', 'run', '--port', port, '--key', entry?.serial ?? port, '--no-heartbeat'],
      { timeoutMs: MONITOR_RUN_TIMEOUT_MS })
      .catch(() => undefined)
      .finally(() => { delete runs[port] })
  }

  function autostart() {
    const now = Date.now()
    for (const board of reconcile(scan, records, transient)) {
      if (now - (lastStart[board.port] ?? 0) < AUTOSTART_BACKOFF_MS) continue
      if (shouldAutostart(board, monitors[board.port]?.monitor ?? null, stoppedPorts)) startMonitor(board.port)
    }
  }

  async function control(port, cmd) {
    await quietly(() => runScript(['monitor', cmd, '--port', port, '--json'], CONTROL_TIMEOUT_MS))
    await readMonitors()
    await quietly(() => publish())
  }

  function flashSizeOf(port) {
    const board = reconcile(scan, records, transient).find(b => b.port === port)
    return board?.info?.flash?.size ?? null
  }

  async function askFlash(port, path) {
    const size = flashSizeOf(port)
    const result = await quietly(() => runScript(['flash', '--port', port, path, '--json', ...(size ? ['--flash-size', size] : [])], CONTROL_TIMEOUT_MS))
    const out = result?.json
    if (out?.reason === 'needs_yes') flashDraft[port] = { path: out.plan.file, bytes: out.plan.bytes, confirming: true }
    else flashDraft[port] = { path, confirming: false, error: out?.detail ?? out?.reason ?? 'error' }
  }

  /** Ask NVIDIA Nemotron on Nebius Token Factory (`explain`) about the board on `port`; never blocks the pane. */
  function explainBoard(port) {
    if (ai[port]?.state === 'running' || !python) return
    const board = reconcile(scan, records, transient).find(b => b.port === port)
    const i = board?.info
    const description = i ? [i.chip, i.flash?.size && `${i.flash.size} flash`, i.psram && `${i.psram} PSRAM`].filter(Boolean).join(' · ') : ''
    const lang = String(io.locale ?? '').startsWith('zh') ? 'zh' : 'en'
    ai[port] = { state: 'running' }
    void quietly(() => publish())
    void io.run([...python, script(), 'explain', '--port', port, '--board', description, '--lang', lang, '--json'],
      { timeoutMs: AI_TIMEOUT_MS })
      .then(ran => {
        let out = null
        try { out = JSON.parse(String(ran?.stdout ?? '').trim().split(/\r?\n/).at(-1)) } catch {}
        ai[port] = out?.ok ? { ...out, state: 'done' } : { state: 'failed', reason: out?.reason ?? 'error' }
      })
      .catch(() => { ai[port] = { state: 'failed', reason: 'timeout' } })
      .finally(() => quietly(() => publish()))
  }

  function confirmFlash(port) {
    const draft = flashDraft[port]
    if (!draft?.confirming || !python) return
    const size = flashSizeOf(port)
    flashDraft[port] = { path: draft.path, confirming: false }
    void io.run([...python, script(), 'flash', '--port', port, draft.path, '--yes', '--wait', '--json',
      ...(size ? ['--flash-size', size] : [])], { timeoutMs: FLASH_TIMEOUT_MS })
      .then(ran => {
        let out = null
        try { out = JSON.parse(String(ran?.stdout ?? '').trim().split(/\r?\n/).at(-1)) } catch {}
        // A refusal before flashing (bad image, already flashing) has no job state; a job result shows from its file.
        if (out && !out.ok && !out.state) flashDraft[port] = { path: draft.path, confirming: false, error: out.detail ?? out.reason }
      })
      .catch(() => undefined)
      .finally(async () => {
        await readMonitors()
        await quietly(() => publish())
      })
  }

  async function publish() {
    const view = currentView()
    publishing = publishing.catch(() => undefined).then(() => io.setView(view))
    await publishing
    if (STATUS_LINE) await quietly(() => io.status(statusText(view, t)))
  }

  async function resolvePython() {
    pythonResolved = true
    const env = {
      ESP_PYTHON: await quietly(() => io.env.ESP_PYTHON()),
      LOCALAPPDATA: await quietly(() => io.env.LOCALAPPDATA()),
    }
    let runnable = null
    for (const candidate of pythonCandidates(env)) {
      if (candidate.length === 1 && !(await quietly(() => io.exists(candidate[0]), false))) continue
      const ran = await quietly(() => io.run([...candidate, '-c', 'import serial, esptool'], { timeoutMs: PY_CHECK_TIMEOUT_MS }))
      if (!ran || ran.exitCode === STORE_ALIAS_EXIT) continue
      if (ran.exitCode === 0) {
        python = candidate
        pythonState = { state: 'ok' }
        return true
      }
      runnable ??= candidate.join(' ')
    }
    python = null
    pythonState = runnable ? { state: 'deps', detail: runnable } : { state: 'missing' }
    return false
  }

  async function runScript(args, timeoutMs) {
    const ran = await io.run([...python, script(), ...args], { timeoutMs })
    return { exitCode: ran?.exitCode, json: JSON.parse(String(ran?.stdout ?? '').trim().split(/\r?\n/).at(-1)) }
  }

  async function doScan(withDrivers) {
    if (scanning) return
    scanning = true
    try {
      if (!python && (pythonResolved || !(await resolvePython()))) return
      // Velloc does not pass LOCALAPPDATA to mods, so the data folder comes from the script that writes it.
      if (!home) home = (await quietly(() => runScript(['home', '--json'], PORTS_TIMEOUT_MS)))?.json?.home ?? ''
      let result
      try {
        result = await runScript(['ports', '--json', ...(withDrivers ? ['--drivers'] : [])], PORTS_TIMEOUT_MS)
      } catch (error) {
        pythonState = { state: 'error', detail: String(error?.message ?? error) }
        return
      }
      if (result.exitCode !== 0 || !Array.isArray(result.json?.ports)) {
        pythonState = { state: 'error', detail: `exit ${result.exitCode}` }
        return
      }
      pythonState = { state: 'ok' }
      const added = newPorts(scan.map(p => p.port), result.json.ports)
      scan = result.json.ports
      if (result.json.missing_driver !== null) missingDriver = result.json.missing_driver
      const present = new Set(scan.map(p => p.port))
      transient = Object.fromEntries(Object.entries(transient).filter(([port]) => present.has(port)))
      records = (await quietly(() => io.storeGet(STORE_KEY))) ?? records
      stoppedPorts = forgetStopped(stoppedPorts, scan)
      await readMonitors()
      autostart()
      if (added.length && !firstScan && !paneOpen) await quietly(() => io.open({ id: PANE_ID, title: t('pane.title') }))
      firstScan = false
    } finally {
      scanning = false
      await quietly(() => publish())
    }
  }

  async function probe(portName) {
    const port = scan.find(p => p.port === portName)
    if (!port || transient[portName]?.state === 'probing' || !python) return
    transient = { ...transient, [portName]: { state: 'probing' } }
    await quietly(() => publish())
    let result
    try {
      result = (await runScript(['probe', '--port', portName, '--json'], PROBE_TIMEOUT_MS)).json
    } catch (error) {
      result = { ok: false, reason: 'no_response', detail: String(error?.message ?? error) }
    }
    if (result?.ok) {
      const stored = (await quietly(() => io.storeGet(STORE_KEY))) ?? records
      records = applyProbe(stored, port, result)
      await quietly(() => io.storeSet(STORE_KEY, records))
      const { [portName]: _done, ...rest } = transient
      // A device with no serial number has no record; keep its result for this session.
      transient = recordKey(port) ? rest : { ...rest, [portName]: { state: 'checked', info: result, probedAt: result.probed_at } }
    } else {
      transient = { ...transient, [portName]: { state: 'failed', reason: result?.reason ?? 'error', detail: result?.detail ?? null } }
    }
    await quietly(() => publish())
  }

  const actions = {
    probe: portName => { void probe(portName) },
    refresh: () => {
      python = null
      pythonResolved = false
      void doScan(true)
    },
    monitorStart: port => {
      stoppedPorts = stoppedPorts.filter(p => p !== port)
      startMonitor(port)
    },
    monitorStop: port => {
      if (!stoppedPorts.includes(port)) stoppedPorts = [...stoppedPorts, port]
      void control(port, 'stop')
    },
    monitorPause: port => { void control(port, 'pause') },
    monitorResume: port => { void control(port, 'resume') },
    monitorReset: port => { void control(port, 'reset') },
    monitorRetry: port => { void control(port, 'retry') },
    clear: port => {
      const lines = monitors[port]?.lines ?? []
      clearAt[port] = { at: lines.length ? lines.at(-1).i + 1 : 0, startedAt: monitors[port]?.monitor?.startedAt ?? null }
      void quietly(() => publish())
    },
    flashConfirm: port => {
      confirmFlash(port)
      void quietly(() => publish())
    },
    aiExplain: port => explainBoard(port),
    aiDismiss: port => {
      delete ai[port]
      void quietly(() => publish())
    },
    toggleDetails: port => {
      expanded[port] = !expanded[port]
      void quietly(() => publish())
    },
    setLogFilter: (port, filter) => {
      logFilter[port] = filter
      void quietly(() => publish())
    },
    toggleLogMore: port => {
      logMore[port] = !logMore[port]
      void quietly(() => publish())
    },
    flashDismiss: port => {
      flashDismissed[port] = monitors[port]?.flash?.startedAt ?? null
      delete flashDraft[port]
      void quietly(() => publish())
    },
    flashCancel: port => {
      delete flashDraft[port]
      void quietly(() => publish())
    },
  }

  on('session.start', async ($, e, next) => {
    pluginRoot = $.plugin.root
    io = {
      locale: $.plugin.locale,
      run: (argv, options) => $.process.run(argv, options),
      read: path => $.fs.read(path),
      exists: path => $.fs.exists(path),
      env: {
        ESP_PYTHON: () => $.env.get('ESP_PYTHON'),
        LOCALAPPDATA: () => $.env.get('LOCALAPPDATA'),
      },
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      setView: value => $.state.set(VIEW, value),
      status: text => $.ui.status(text),
      open: options => $.ui.open(options),
    }
    t = await loadTexts(path => $.fs.read(path), pluginRoot, $.plugin.locale)
    await quietly(() => $.command.register({ name: COMMAND, description: t('command.description'), argumentHint: '[flash <file.bin> [COMx]]' }))
    records = (await quietly(() => $.store.get(STORE_KEY))) ?? {}
    void doScan(true) // finding Python and asking Windows for drivers takes seconds; don't hold the session start
    $.clock.every(TICK_MS, () => {
      if (!BACKGROUND_POLL && !paneOpen) return
      ticks += 1
      if (ticks % SCAN_EVERY === 0) {
        void doScan(ticks % DRIVER_EVERY === 0)
      } else if (paneOpen || ticks % STATUS_CLOSED_EVERY === 1) {
        void readMonitors().then(() => quietly(() => publish()))
      }
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (!python) pythonResolved = false
    await doScan(true)
    const request = parseFlashArgs(e?.args ?? '', scan)
    if (request?.error) return { text: t(`flash.error.${request.error}`) }
    if (request) {
      await askFlash(request.port, request.path)
      await quietly(() => publish())
    }
    await $.ui.open({ id: PANE_ID, title: t('pane.title'), focus: true })
    return {}
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result?.deny === undefined) paneOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    paneOpen = true
    const read = await quietly(() => $.state.get(VIEW))
    const view = read && read.value && typeof read.value === 'object' ? read.value : currentView()
    return paneTree(await $.ui.resolve(e), view, t, actions)
  })
}
