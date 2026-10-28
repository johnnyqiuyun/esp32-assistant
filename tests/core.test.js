import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyProbe, newPorts, pythonCandidates, recordKey, reconcile } from '../hooks/core.js'

const SERIAL = 'E4DAC533F165EE11B81F966293CD958C'
const cp = (port = 'COM4') => ({ port, vid: '10C4', pid: 'EA60', bridge: 'cp210x', serial: SERIAL, description: 'CP210x' })
const ch = port => ({ port, vid: '1A86', pid: '7523', bridge: 'ch34x', serial: null, description: 'CH340' })
const info = (at = '2026-10-28T10:00:00+08:00') => ({ ok: true, port: 'COM4', chip: 'ESP32-S3', probed_at: at })
const KEY = `10C4:EA60:${SERIAL}`
const known = () => ({ [KEY]: { info: info(), probedAt: '2026-10-28T10:00:00+08:00' } })

test('test_unknown_board_is_unprobed', () => {
  const [b] = reconcile([cp()], {}, {})
  assert.equal(b.state, 'unprobed')
  assert.equal(b.info, null)
  assert.equal(b.key, KEY)
})

test('test_known_board_shows_record', () => {
  const [b] = reconcile([cp()], known(), {})
  assert.equal(b.state, 'known')
  assert.equal(b.info.chip, 'ESP32-S3')
  assert.equal(b.probedAt, '2026-10-28T10:00:00+08:00')
})

test('test_same_serial_new_port_is_known', () => {
  const [b] = reconcile([cp('COM7')], known(), {})
  assert.equal(b.state, 'known')
  assert.equal(b.port, 'COM7')
})

test('test_no_serial_never_known', () => {
  const records = known()
  const boards = reconcile([ch('COM5'), ch('COM6')], records, {})
  assert.deepEqual(boards.map(b => [b.port, b.state, b.key]), [['COM5', 'unprobed', null], ['COM6', 'unprobed', null]])
  assert.deepEqual(applyProbe(records, ch('COM5'), info()), records)
})

test('test_probing_overrides', () => {
  const [b] = reconcile([cp()], known(), { COM4: { state: 'probing' } })
  assert.equal(b.state, 'probing')
})

test('test_failed_probe_keeps_known_info', () => {
  const records = known()
  const [b] = reconcile([cp()], records, { COM4: { state: 'failed', reason: 'busy', detail: 'x' } })
  assert.equal(b.state, 'failed')
  assert.equal(b.reason, 'busy')
  assert.equal(b.detail, 'x')
  assert.equal(b.info.chip, 'ESP32-S3')
  assert.deepEqual(applyProbe(records, cp(), { ok: false, reason: 'busy' }), known())
})

test('test_apply_probe_ok_overwrites', () => {
  const next = applyProbe(known(), cp(), info('B'))
  assert.equal(next[KEY].probedAt, 'B')
  assert.equal(next[KEY].info.probed_at, 'B')
})

test('test_reconcile_keeps_scan_order', () => {
  assert.deepEqual(reconcile([ch('COM9'), cp('COM4')], {}, {}).map(b => b.port), ['COM9', 'COM4'])
})

test('test_python_candidates_order', () => {
  const c = pythonCandidates({ ESP_PYTHON: 'X', LOCALAPPDATA: 'L' })
  assert.deepEqual(c[0], ['X'])
  assert.deepEqual(c[1], ['L\\Programs\\Python\\Python314\\python.exe'])
  assert.deepEqual(c.at(-2), ['L\\Programs\\Python\\Python310\\python.exe'])
  assert.deepEqual(c.at(-1), ['py', '-3'])
  assert.deepEqual(pythonCandidates({ LOCALAPPDATA: 'L' })[0], ['L\\Programs\\Python\\Python314\\python.exe'])
  assert.deepEqual(pythonCandidates({}), [['py', '-3']])
})

test('test_new_ports', () => {
  assert.deepEqual(newPorts(['COM4'], [{ port: 'COM4' }, { port: 'COM7' }]), ['COM7'])
})

test('test_record_key', () => {
  assert.equal(recordKey(cp()), KEY)
  assert.equal(recordKey(ch('COM5')), null)
})

test('test_keyless_checked_in_session_shows_info', () => {
  const [b] = reconcile([ch('COM5')], {}, { COM5: { state: 'checked', info: info(), probedAt: 'T' } })
  assert.equal(b.state, 'known')
  assert.equal(b.info.chip, 'ESP32-S3')
  assert.equal(b.probedAt, 'T')
})

// ---- phase 2: autostart and line levels
import { forgetStopped, lineLevel, shouldAutostart } from '../hooks/core.js'

const boardOf = over => ({ port: 'COM4', bridge: 'cp210x', serial: SERIAL, key: KEY, state: 'known', info: info(), probedAt: 'T', reason: null, detail: null, ...over })

test('test_autostart_known', () => {
  assert.equal(shouldAutostart(boardOf(), null, []), true)
})

test('test_autostart_native_usb_unprobed', () => {
  assert.equal(shouldAutostart(boardOf({ bridge: 'espressif-usb', state: 'unprobed', info: null }), null, []), true)
})

test('test_no_autostart_unprobed_cp210x', () => {
  assert.equal(shouldAutostart(boardOf({ state: 'unprobed', info: null }), null, []), false)
})

test('test_no_autostart_when_running', () => {
  assert.equal(shouldAutostart(boardOf(), { state: 'running' }, []), false)
  assert.equal(shouldAutostart(boardOf(), { state: 'busy' }, []), false)
})

test('test_no_autostart_after_manual_stop', () => {
  assert.equal(shouldAutostart(boardOf(), null, ['COM4']), false)
})

test('test_autostart_when_monitor_stopped', () => {
  assert.equal(shouldAutostart(boardOf(), { state: 'stopped' }, []), true)
})

test('test_no_autostart_while_probing', () => {
  assert.equal(shouldAutostart(boardOf({ state: 'probing' }), null, []), false)
})

test('test_line_level_panic', () => {
  assert.equal(lineLevel("12:00:00.000 Guru Meditation Error: Core  0 panic'ed (LoadProhibited)."), 'panic')
  assert.equal(lineLevel('abort() was called at PC 0x4200'), 'panic')
})

test('test_line_level_error_warn', () => {
  assert.equal(lineLevel('12:00:00.000 E (100) app: bad'), 'error')
  assert.equal(lineLevel('W (100) spi_flash: Detected size'), 'warn')
})

test('test_line_level_wifi', () => {
  assert.equal(lineLevel('12:00:00.000 I (900) wifi:connected with MyAP'), 'wifi')
  assert.equal(lineLevel('I (1500) esp_netif_handlers: sta ip: 192.168.1.23'), 'wifi')
  assert.equal(lineLevel('RSSI: 3 '), 'wifi')
})

test('test_line_level_info', () => {
  assert.equal(lineLevel('12:00:00.000 I (1) main_task: Calling app_main()'), 'info')
})

test('test_forget_stopped_on_unplug', () => {
  assert.deepEqual(forgetStopped(['COM4', 'COM7'], [{ port: 'COM7' }]), ['COM7'])
})

// ---- phase 2: /esp32 flash arguments and monitor liveness
import { liveMonitor, parseFlashArgs } from '../hooks/core.js'

test('test_flash_args_single_board', () => {
  assert.deepEqual(parseFlashArgs('flash C:\fw\a.merged.bin', [boardOf()]), { port: 'COM4', path: 'C:\fw\a.merged.bin' })
})

test('test_flash_args_quoted_path_with_spaces_and_port', () => {
  const boards = [boardOf(), boardOf({ port: 'COM7' })]
  assert.deepEqual(parseFlashArgs('flash "C:\My FW\a.bin" com7', boards), { port: 'COM7', path: 'C:\My FW\a.bin' })
})

test('test_flash_args_ambiguous_board', () => {
  assert.deepEqual(parseFlashArgs('flash a.bin', [boardOf(), boardOf({ port: 'COM7' })]), { error: 'no_board', path: 'a.bin' })
  assert.deepEqual(parseFlashArgs('flash a.bin', []), { error: 'no_board', path: 'a.bin' })
})

test('test_flash_args_not_flash', () => {
  assert.equal(parseFlashArgs('', [boardOf()]), null)
  assert.equal(parseFlashArgs('flash', [boardOf()]), null)
})

test('test_live_monitor_fresh_and_stale', () => {
  const st = { state: 'running', updatedAt: 1000 }
  assert.equal(liveMonitor(st, 1003_000), st)
  assert.equal(liveMonitor(st, 1010_000), null)
  assert.equal(liveMonitor(null, 1000_000), null)
})

// ---- final review: stale flash jobs
import { liveJob } from '../hooks/core.js'

test('test_live_job_running_fresh', () => {
  const job = { state: 'running', percent: 37, updatedAt: 1000 }
  assert.equal(liveJob(job, 1030_000), job)
})

test('test_live_job_running_stale_is_interrupted', () => {
  const out = liveJob({ state: 'running', percent: 37, updatedAt: 1000 }, 1100_000)
  assert.equal(out.state, 'failed')
  assert.equal(out.reason, 'interrupted')
  assert.equal(liveJob({ state: 'running', percent: 5 }, 1100_000).reason, 'interrupted')
})

test('test_live_job_done_untouched', () => {
  const job = { state: 'done', updatedAt: 1 }
  assert.equal(liveJob(job, 1100_000), job)
  assert.equal(liveJob(null, 1), null)
})
