/**
 * ESP32 bring-up in the Velloc session: a pane that shows which ESP boards are
 * plugged in and what they are.
 *
 * - Every POLL_MS it runs `esp32_bringup.py ports --json`, which lists USB
 *   serial ports without opening them, so polling never resets a board. Every
 *   DRIVER_EVERY-th scan also asks Windows for devices with a missing driver.
 * - It never opens a serial port on its own. `probe` (which resets the board
 *   once) runs only when the person presses Check / Check again.
 * - Probe results are kept in `$.store` under STORE_KEY by USB serial number,
 *   so a board plugged in again shows its last result without being reset.
 * - `/esp32` scans and opens the pane; a newly plugged port opens it without
 *   taking focus.
 *
 * Runtime facts (worker lifetime, status line) are from docs/spike-notes.md.
 */

import { applyProbe, newPorts, pythonCandidates, reconcile } from './core.js'
import { loadTexts } from './texts.js'
import { paneTree, statusText } from './view.js'

const PANE_ID = 'esp32'
const COMMAND = 'esp32'
const POLL_MS = 2000
const DRIVER_EVERY = 5
const PORTS_TIMEOUT_MS = 10000
const PROBE_TIMEOUT_MS = 40000
const PY_CHECK_TIMEOUT_MS = 10000
const STORE_KEY = 'boards'
const STORE_ALIAS_EXIT = 49 // the Microsoft Store "python" placeholder
const BACKGROUND_POLL = true
const STATUS_LINE = false

export function register(on) {
  let root
  let t = key => key
  let python = null // argv prefix of a working interpreter
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
  const ref = $ => ({ plugin: $.plugin.name, key: 'view' })
  const script = $ => `${$.plugin.root}/scripts/esp32_bringup.py`

  async function quietly(action, fallback) {
    try { return await action() } catch { return fallback }
  }

  function currentView() {
    return {
      boards: reconcile(scan, records, transient),
      missingDriver,
      python: pythonState,
      polling: BACKGROUND_POLL ? 'background' : 'pane',
    }
  }

  async function publish($) {
    const view = currentView()
    publishing = publishing.catch(() => undefined).then(() => $.state.set(ref($), view))
    await publishing
    if (STATUS_LINE) await quietly(() => $.ui.status(statusText(view, t)))
  }

  async function resolvePython($) {
    const env = {
      ESP_PYTHON: await quietly(() => $.env.get('ESP_PYTHON')),
      LOCALAPPDATA: await quietly(() => $.env.get('LOCALAPPDATA')),
    }
    let runnable = null
    for (const candidate of pythonCandidates(env)) {
      if (candidate.length === 1 && !(await quietly(() => $.fs.exists(candidate[0]), false))) continue
      const ran = await quietly(() => $.process.run([...candidate, '-c', 'import serial, esptool'], { timeoutMs: PY_CHECK_TIMEOUT_MS }))
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

  async function runScript($, args, timeoutMs) {
    const ran = await $.process.run([...python, script($), ...args], { timeoutMs })
    return { exitCode: ran?.exitCode, json: JSON.parse(String(ran?.stdout ?? '').trim().split(/\r?\n/).at(-1)) }
  }

  async function doScan($, withDrivers) {
    if (scanning) return
    scanning = true
    try {
      if (!python && !(await resolvePython($))) return
      let result
      try {
        result = await runScript($, ['ports', '--json', ...(withDrivers ? ['--drivers'] : [])], PORTS_TIMEOUT_MS)
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
      records = (await quietly(() => $.store.get(STORE_KEY))) ?? records
      if (added.length && !firstScan && !paneOpen) await quietly(() => $.ui.open({ id: PANE_ID, title: t('pane.title') }))
      firstScan = false
    } finally {
      scanning = false
      await quietly(() => publish($))
    }
  }

  async function probe(portName) {
    const $ = root
    const port = scan.find(p => p.port === portName)
    if (!port || transient[portName]?.state === 'probing' || !python) return
    transient = { ...transient, [portName]: { state: 'probing' } }
    await quietly(() => publish($))
    let result
    try {
      result = (await runScript($, ['probe', '--port', portName, '--json'], PROBE_TIMEOUT_MS)).json
    } catch (error) {
      result = { ok: false, reason: 'no_response', detail: String(error?.message ?? error) }
    }
    if (result?.ok) {
      const stored = (await quietly(() => $.store.get(STORE_KEY))) ?? records
      records = applyProbe(stored, port, result)
      await quietly(() => $.store.set(STORE_KEY, records))
      const { [portName]: _done, ...rest } = transient
      transient = rest
    } else {
      transient = { ...transient, [portName]: { state: 'failed', reason: result?.reason ?? 'error', detail: result?.detail ?? null } }
    }
    await quietly(() => publish($))
  }

  const actions = {
    probe: portName => { void probe(portName) },
    refresh: () => {
      python = null
      void doScan(root, true)
    },
  }

  on('session.start', async ($, e, next) => {
    root = $
    t = await loadTexts($)
    await quietly(() => $.command.register({ name: COMMAND, description: t('command.description') }))
    records = (await quietly(() => $.store.get(STORE_KEY))) ?? {}
    await doScan($, true)
    $.clock.every(POLL_MS, () => {
      if (!BACKGROUND_POLL && !paneOpen) return
      ticks += 1
      void doScan(root, ticks % DRIVER_EVERY === 0)
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await doScan($, true)
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
    const read = await quietly(() => $.state.get(ref($)))
    const view = read && read.value && typeof read.value === 'object' ? read.value : currentView()
    return paneTree(await $.ui.resolve(e), view, t, actions)
  })
}
