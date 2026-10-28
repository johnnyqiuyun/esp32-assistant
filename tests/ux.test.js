import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateFlashSeconds, filterLines, formatBytes, formatDuration, health, overview, progressBar, resetKind, rssiQuality, signalBars,
} from '../hooks/ux.js'

const t = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key)
const board = over => ({ port: 'COM4', bridge: 'cp210x', state: 'known', info: { chip: 'ESP32-S3' }, reason: null, ...over })
const summary = over => ({ status: 'running', boots: 1, last_reset: '0x1 (POWERON)', last_boot_at: 1000, errors: 0, warnings: 0,
  wifi: { state: 'unknown' }, ...over })
const monitor = (over = {}, sum = {}) => ({ state: 'running', summary: summary(sum), ...over })

test('test_reset_kind', () => {
  assert.equal(resetKind('0x1 (POWERON)'), 'poweron')
  assert.equal(resetKind('0x3 (RTC_SW_SYS_RST)'), 'software')
  assert.equal(resetKind('0xc (RTC_SW_CPU_RST)'), 'crash')
  assert.equal(resetKind('0x7 (TG0WDT_SYS_RST)'), 'watchdog')
  assert.equal(resetKind('0xf (RTCWDT_BROWN_OUT_RST)'), 'brownout')
  assert.equal(resetKind('0x5 (DSLEEP)'), 'deepsleep')
  assert.equal(resetKind('0x15 (USB_UART_CHIP_RESET)'), 'usb')
  assert.equal(resetKind('0x99 (SOMETHING)'), 'other')
  assert.equal(resetKind(null), null)
})

test('test_rssi_quality', () => {
  assert.deepEqual(rssiQuality(-50), { bars: 4, key: 'excellent' })
  assert.deepEqual(rssiQuality(-60), { bars: 3, key: 'good' })
  assert.deepEqual(rssiQuality(-70), { bars: 2, key: 'fair' })
  assert.deepEqual(rssiQuality(-85), { bars: 1, key: 'weak' })
  assert.deepEqual(rssiQuality(3), { bars: 0, key: 'nonstandard' })
  assert.equal(rssiQuality(null), null)
})

test('test_signal_bars', () => {
  assert.equal(signalBars(3), '▂▄▆·')
  assert.equal(signalBars(0), '····')
})

test('test_progress_bar', () => {
  assert.equal(progressBar(50, 10), '█████░░░░░')
  assert.equal(progressBar(0, 4), '░░░░')
  assert.equal(progressBar(130, 4), '████')
})

test('test_format_bytes_and_estimate', () => {
  assert.equal(formatBytes(4194304), '4.0 MB')
  assert.equal(formatBytes(524288), '512 KB')
  assert.equal(formatBytes(null), '—')
  assert.equal(estimateFlashSeconds(4194304), 24)
})

test('test_format_duration', () => {
  assert.equal(formatDuration(45, t), 'dur.s{"s":45}')
  assert.equal(formatDuration(303, t), 'dur.ms{"m":5,"s":3}')
  assert.equal(formatDuration(7500, t), 'dur.hm{"h":2,"m":5}')
})

test('test_health_unprobed_and_probing', () => {
  assert.deepEqual(health(board({ state: 'unprobed', info: null }), null, 0), { tone: 'idle', key: 'health.unprobed' })
  assert.equal(health(board({ state: 'probing' }), monitor(), 0).key, 'health.probing')
})

test('test_health_probe_failed_without_monitor', () => {
  // With a live monitor the monitor's verdict wins (ux-review.test.js: test_live_monitor_beats_old_probe_failure).
  const h = health(board({ state: 'failed', reason: 'busy' }), null, 0)
  assert.equal(h.tone, 'error')
  assert.equal(h.key, 'health.probeFailed')
})

test('test_health_crashed', () => {
  assert.deepEqual(health(board(), monitor({}, { status: 'crashed' }), 2000_000).tone, 'error')
})

test('test_health_busy_waiting_paused', () => {
  assert.equal(health(board(), monitor({ state: 'busy' }), 0).key, 'health.busy')
  assert.equal(health(board(), monitor({ state: 'waiting' }), 0).key, 'health.waiting')
  assert.equal(health(board(), monitor({ state: 'paused' }), 0).key, 'health.paused')
})

test('test_health_just_rebooted_by_watchdog', () => {
  const h = health(board(), monitor({}, { last_reset: '0x7 (TG0WDT_SYS_RST)', last_boot_at: 1000 }), 1005_000)
  assert.equal(h.tone, 'warn')
  assert.equal(h.key, 'health.rebooted')
  assert.equal(h.vars.kind, 'watchdog')
})

test('test_health_poweron_reboot_is_fine', () => {
  const h = health(board(), monitor({}, { last_reset: '0x1 (POWERON)', last_boot_at: 1000 }), 1005_000)
  assert.equal(h.tone, 'ok')
  assert.equal(h.key, 'health.running')
})

test('test_health_running_without_boot_uses_watch_time', () => {
  const h = health(board(), monitor({ startedAt: 1000 }, { last_boot_at: null, last_reset: null }), 1120_000)
  assert.deepEqual([h.tone, h.key, h.vars.watched], ['ok', 'health.watching', 120])
})

test('test_health_running_and_known_idle', () => {
  const h = health(board(), monitor({}, { last_boot_at: 1000 }), 1300_000)
  assert.deepEqual([h.tone, h.key, h.vars.seconds], ['ok', 'health.running', 300])
  assert.deepEqual(health(board(), null, 0), { tone: 'ok', key: 'health.idle', vars: { chip: 'ESP32-S3' } })
})

test('test_filter_lines', () => {
  const lines = [
    { i: 0, text: '12:00:00.000 I (1) boot: hi' }, { i: 1, text: '12:00:00.000 E (2) app: bad' },
    { i: 2, text: '12:00:00.000 W (3) x: y' }, { i: 3, text: '12:00:00.000 RSSI: 3' }, { i: 4, text: 'plain' },
  ]
  assert.deepEqual(filterLines(lines, { filter: 'all', clearAt: 0, limit: 2 }).map(l => l.i), [3, 4])
  assert.deepEqual(filterLines(lines, { filter: 'problems', clearAt: 0, limit: 30 }).map(l => l.i), [1, 2])
  assert.deepEqual(filterLines(lines, { filter: 'wifi', clearAt: 0, limit: 30 }).map(l => l.i), [3])
  assert.deepEqual(filterLines(lines, { filter: 'all', clearAt: 2, limit: 30 }).map(l => l.i), [2, 3, 4])
})

test('test_overview', () => {
  assert.equal(overview([], [], null, { state: 'ok' }).key, 'overview.none')
  assert.deepEqual(overview([board()], [{ tone: 'ok' }], [], { state: 'ok' }), { tone: 'ok', key: 'overview.ok', vars: { n: 1 } })
  const bad = overview([board()], [{ tone: 'error' }], [{ name: 'CP2102N' }], { state: 'ok' })
  assert.deepEqual(bad, { tone: 'error', key: 'overview.issues', vars: { n: 2 } })
  assert.equal(overview([board()], [{ tone: 'ok' }], [], { state: 'deps' }).key, 'overview.issues')
})
