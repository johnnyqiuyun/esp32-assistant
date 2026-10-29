// Regression tests for the v0.3 UX review findings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { health, overview } from '../hooks/ux.js'
import { paneTree } from '../hooks/view.js'
import { translator } from '../hooks/texts.js'

const zh = JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))
const t = translator([zh])
const component = type => props => ({ type, props })
const ui = { Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') }
function nodes(tree, out = []) {
  if (tree && typeof tree === 'object') {
    out.push(tree)
    for (const child of tree.props?.children ?? []) nodes(child, out)
  }
  return out
}
const texts = tree => nodes(tree).flatMap(n => [n.props?.label, ...(n.props?.children ?? []).filter(c => typeof c === 'string')]).filter(Boolean).join('\n')
const find = (tree, key) => nodes(tree).find(n => n.props?.key === key)
const textNode = (tree, includes) => nodes(tree).find(n => n.type === 'Text' && (n.props.children ?? []).some(c => typeof c === 'string' && c.includes(includes)))
const noop = new Proxy({}, { get: () => () => {} })

const INFO = { chip: 'ESP32-S3', revision: 'v0.2', cpu_mhz: 240, psram: '8MB', flash: { size: '16MB' } }
const board = over => ({ port: 'COM4', bridge: 'cp210x', serial: 'S', key: 'K', state: 'known', info: INFO, probedAt: null, reason: null, detail: null, ...over })
const summary = over => ({ status: 'running', boots: 1, last_reset: '0x1 (POWERON)', last_boot_at: 1000, errors: 0, warnings: 0,
  wifi: { state: 'unknown', ssid: null, ip: null, reason: null, rssi: null }, ...over })
const monitor = (over = {}, sum = {}) => ({ state: 'running', startedAt: 900, summary: summary(sum), ...over })
const NOW = 1300_000
const view = over => ({ boards: [board()], missingDriver: [], python: { state: 'ok' }, polling: 'background',
  monitors: { COM4: { monitor: monitor(), lines: [], flash: null } }, clearAt: {}, flashDraft: {}, logDir: 'C:\\d', now: NOW,
  expanded: {}, logFilter: {}, logMore: {}, flashDismissed: {}, ...over })
const render = over => paneTree(ui, view(over), t, noop)

// C1
test('test_rebooted_other_reason_shows_raw_text', () => {
  const h = health(board(), monitor({}, { last_reset: '0x9 (GLITCH_RTC_RST)', last_boot_at: 1295 }), NOW)
  assert.equal(h.key, 'health.rebooted')
  const s = texts(render({ monitors: { COM4: { monitor: monitor({}, { last_reset: '0x9 (GLITCH_RTC_RST)', last_boot_at: 1295 }), lines: [] } } }))
  assert.ok(s.includes('0x9 (GLITCH_RTC_RST)'))
  assert.ok(!s.includes('reset.other'))
})

// C2
test('test_flashing_verdict_and_no_monitor_buttons', () => {
  const flash = { state: 'running', percent: 40, file: 'a.bin', startedAt: 1290 }
  const h = health(board(), monitor({ state: 'paused' }), NOW, { flash })
  assert.deepEqual([h.tone, h.key, h.vars.percent], ['warn', 'health.flashing', 40])
  const tree = render({ monitors: { COM4: { monitor: monitor({ state: 'paused' }), lines: [], flash } } })
  assert.equal(find(tree, 'mon-resume:COM4'), undefined)
  assert.equal(find(tree, 'mon-start:COM4'), undefined)
})

test('test_failed_flash_is_red_until_dismissed', () => {
  const flash = { state: 'failed', reason: 'interrupted', startedAt: 1000 }
  assert.equal(health(board(), monitor(), NOW, { flash }).key, 'health.flashFailed')
  assert.equal(health(board(), monitor(), NOW, { flash, dismissed: 1000 }).key, 'health.running')
})

// C3
test('test_silent_board_is_not_running_normally', () => {
  const h = health(board(), monitor({}, { status: 'unknown', last_boot_at: null, last_reset: null }), NOW)
  assert.equal(h.key, 'health.silent')
})

test('test_download_mode_detected', () => {
  const lines = [{ i: 0, text: '12:00:00.000 rst:0x1 (POWERON),boot:0x0 (DOWNLOAD(USB/UART0))' }, { i: 1, text: '12:00:00.000 waiting for download' }]
  assert.equal(health(board(), monitor(), NOW, { lines }).key, 'health.download')
})

test('test_blank_flash_detected', () => {
  const lines = [{ i: 0, text: '12:00:00.000 invalid header: 0xffffffff' }]
  assert.equal(health(board(), monitor(), NOW, { lines }).tone, 'error')
  assert.equal(health(board(), monitor(), NOW, { lines }).key, 'health.noFirmware')
})

// I1
test('test_live_monitor_beats_old_probe_failure', () => {
  const h = health(board({ state: 'failed', reason: 'busy' }), monitor({}, { status: 'crashed' }), NOW)
  assert.equal(h.key, 'health.crashed')
  const s = texts(render({ boards: [board({ state: 'failed', reason: 'busy' })] }))
  assert.ok(s.includes(t('health.probeFailed', { reason: t('fail.busy') })))
})

// I2
test('test_boot_loop_is_red', () => {
  const h = health(board(), monitor({}, { boots: 4, last_reset: '0xc (RTC_SW_CPU_RST)', last_boot_at: 1298 }), NOW)
  assert.deepEqual([h.tone, h.key, h.vars.n], ['error', 'health.bootLoop', 4])
})

test('test_bad_reset_reason_row_is_yellow', () => {
  const tree = render({ monitors: { COM4: { monitor: monitor({}, { last_reset: '0x7 (TG0WDT_SYS_RST)', last_boot_at: 1000 }), lines: [] } } })
  assert.equal(textNode(tree, zh['reset.watchdog']).props.color, 'yellow')
})

// I3
test('test_cpu_reset_text_mentions_esp_restart', () => {
  assert.ok(zh['reset.crash'].includes('esp_restart'))
  assert.ok(en['reset.crash'].includes('esp_restart'))
})

// I4
test('test_log_counts_from_stopped_monitor', () => {
  const stopped = { monitor: monitor({ state: 'stopped' }, { errors: 2, warnings: 1 }), lines: [{ i: 0, text: 'E (1) a: b' }] }
  assert.ok(texts(render({ monitors: { COM4: stopped } })).includes(t('log.title', { errors: 2, warnings: 1 })))
})

// I5
test('test_empty_log_texts_per_situation', () => {
  const lines = [{ i: 0, text: 'I (1) a: fine' }]
  const mon = { monitor: monitor(), lines }
  assert.ok(texts(render({ monitors: { COM4: mon }, logFilter: { COM4: 'problems' } })).includes(zh['log.noProblems']))
  assert.ok(texts(render({ monitors: { COM4: mon }, logFilter: { COM4: 'wifi' } })).includes(zh['log.noWifi']))
  assert.ok(texts(render({ monitors: { COM4: mon }, clearAt: { COM4: { at: 1, startedAt: 900 } } })).includes(zh['log.cleared']))
})

// I6
test('test_no_stale_signal_when_disconnected_and_reason_code_text', () => {
  const sum = { wifi: { state: 'disconnected', reason: 4, rssi: -58 } }
  const s = texts(render({ monitors: { COM4: { monitor: monitor({}, sum), lines: [] } } }))
  assert.ok(!s.includes('-58 dBm'))
  assert.ok(s.includes(t('wifi.reason.other', { code: 4 })))
})

// I7
test('test_no_cable_checklist_when_python_missing', () => {
  const s = texts(render({ boards: [], monitors: {}, python: { state: 'missing' } }))
  assert.ok(!s.includes(zh['empty.step1']))
  assert.ok(s.includes(zh['footer.noScan']))
})

// I8
test('test_overview_ignores_probing_and_recent_reboot', () => {
  const o = overview([board()], [{ tone: 'warn', key: 'health.probing' }], [], { state: 'ok' })
  assert.equal(o.key, 'overview.ok')
  assert.equal(overview([board()], [{ tone: 'warn', key: 'health.busy' }], [], { state: 'ok' }).key, 'overview.issues')
})

// I9
test('test_draft_error_can_be_dismissed', () => {
  const tree = render({ flashDraft: { COM4: { path: 'x.bin', confirming: false, error: 'not_merged' } } })
  assert.ok(find(tree, 'flash-error-dismiss:COM4'))
})

test('test_old_done_result_hidden', () => {
  const flash = { state: 'done', file: 'a.bin', startedAt: 600, finishedAt: 624 }
  assert.ok(!texts(render({ monitors: { COM4: { monitor: monitor(), lines: [], flash } } })).includes('a.bin'))
})

// I10
test('test_starting_state', () => {
  const tree = render({ monitors: { COM4: { monitor: monitor({ state: 'starting' }), lines: [] } } })
  assert.ok(texts(tree).includes(zh['health.starting']))
  assert.equal(find(tree, 'mon-start:COM4'), undefined)
  assert.ok(find(tree, 'mon-stop:COM4'))
})

// Minor copy fixes
test('test_copy_consistency', () => {
  assert.ok(!zh['fail.busy'].includes('monitor'))
  assert.ok(!zh['state.unprobed'].includes('检测'))
  assert.notEqual(en['psram.none'], 'none')
  assert.ok(!zh['flash.done'].includes('已启动'))
})

test('test_spec_line_skips_unknown_parts', () => {
  const s = texts(render({ boards: [board({ info: { chip: 'ESP32-S3', flash: { size: '16MB' } } })] }))
  assert.ok(s.includes('16MB Flash'))
  assert.ok(!s.includes('— MHz') && !s.includes('· —'))
})

test('test_wifi_row_hidden_without_wifi_info', () => {
  assert.ok(!texts(render()).includes(zh['wifi.row.unknown']))
})

test('test_reset_hint_only_before_first_identify', () => {
  assert.ok(!texts(render()).includes(zh['probe.resetsBoard']))
  assert.ok(texts(render({ boards: [board({ state: 'unprobed', info: null })], monitors: {} })).includes(zh['probe.resetsBoard']))
})

test('test_log_lines_rendered_without_control_chars', () => {
  // Lines written before the monitor cleaned resets: "\ufffd\x00\ufffdESP-ROM:…" broke Velloc's pane.
  const lines = [{ i: 0, text: '12:00:00.000 \ufffd\u0000\ufffdESP-ROM:esp32s3-20210327' }]
  const s = texts(render({ monitors: { COM4: { monitor: monitor(), lines, flash: null } } }))
  assert.ok(s.includes('ESP-ROM:esp32s3-20210327'))
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f\ufffd]/.test(s))
})
