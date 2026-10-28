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
