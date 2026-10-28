import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { paneTree } from '../hooks/view.js'
import { translator } from '../hooks/texts.js'

const zh = JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8'))
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

const INFO = { ok: true, chip: 'ESP32-S3', package: 'QFN56', revision: 'v0.2', cpu_mhz: 240, psram: '8MB', crystal_mhz: 40,
  mac: '74:4d:bd:9d:b5:44', flash: { size: '16MB', type: 'quad', voltage: '3.3V' } }
const board = over => ({ port: 'COM4', bridge: 'cp210x', serial: 'S', key: 'K', state: 'known', info: INFO,
  probedAt: '2026-10-28T10:00:00+08:00', reason: null, detail: null, ...over })
const NOW = 1300_000
const summary = over => ({ status: 'running', boots: 1, last_reset: '0x1 (POWERON)', last_boot_at: 1000, errors: 0, warnings: 0,
  wifi: { state: 'unknown', ssid: null, ip: null, reason: null, rssi: null }, ...over })
const mon = (over = {}, sum = {}, lines = []) => ({ monitor: { state: 'running', startedAt: 1, summary: summary(sum), ...over }, lines, flash: null })
const view = over => ({ boards: [board()], missingDriver: [], python: { state: 'ok' }, polling: 'background',
  monitors: { COM4: mon() }, clearAt: {}, flashDraft: {}, logDir: 'C:\\data\\logs', linkOpensFolder: false, now: NOW,
  expanded: {}, logFilter: {}, logMore: {}, flashDismissed: {}, ...over })
const render = over => paneTree(ui, view(over), t, noop)

test('test_overview_ok_headline', () => {
  const tree = render()
  assert.ok(texts(tree).includes(t('overview.ok', { n: 1 })))
  assert.equal(textNode(tree, t('overview.ok', { n: 1 })).props.color, 'green')
})

test('test_overview_issues_with_missing_driver', () => {
  const tree = render({ missingDriver: [{ name: 'CP2102N', vid: '10C4', pid: 'EA60', error_code: 28 }] })
  assert.ok(texts(tree).includes(t('overview.issues', { n: 1 })))
})

test('test_health_running_with_uptime', () => {
  assert.ok(texts(render()).includes(t('health.running', { time: t('dur.ms', { m: 5, s: 0 }) })))
})

test('test_health_watching_when_boot_not_seen', () => {
  const tree = render({ monitors: { COM4: mon({ startedAt: 1180 }, { last_boot_at: null, last_reset: null }) } })
  assert.ok(texts(tree).includes(t('health.watching', { time: t('dur.ms', { m: 2, s: 0 }) })))
  assert.ok(!texts(tree).includes('—'))
})

test('test_health_crashed_red', () => {
  const tree = render({ monitors: { COM4: mon({}, { status: 'crashed' }) } })
  assert.equal(textNode(tree, zh['health.crashed']).props.color, 'red')
})

test('test_spec_summary_and_hidden_details', () => {
  const s = texts(render())
  for (const want of ['16MB', '8MB', '240 MHz']) assert.ok(s.includes(want), want)
  assert.ok(!s.includes('74:4d:bd:9d:b5:44'))
})

test('test_details_toggle', () => {
  const closed = render()
  assert.equal(find(closed, 'details:COM4').props.label, zh['btn.details'])
  const open = render({ expanded: { COM4: true } })
  assert.ok(texts(open).includes('74:4d:bd:9d:b5:44'))
  assert.equal(find(open, 'details:COM4').props.label, zh['btn.hideDetails'])
})

test('test_wifi_row_connected', () => {
  const s = texts(render({ monitors: { COM4: mon({}, { wifi: { state: 'connected', ssid: 'MyAP', ip: '192.168.1.23', reason: null, rssi: -58 } }) } }))
  for (const want of ['MyAP', '192.168.1.23', '▂▄▆·', zh['rssi.good'], '-58 dBm']) assert.ok(s.includes(want), want)
})

test('test_wifi_row_nonstandard_rssi', () => {
  const s = texts(render({ monitors: { COM4: mon({}, { wifi: { state: 'unknown', rssi: 3 } }) } }))
  assert.ok(s.includes(zh['rssi.nonstandard']))
})

test('test_wifi_row_disconnected_reason', () => {
  const s = texts(render({ monitors: { COM4: mon({}, { wifi: { state: 'disconnected', reason: 202, rssi: null } }) } }))
  assert.ok(s.includes(zh['wifi.reason.202']))
})

test('test_reset_reason_plain_words', () => {
  const s = texts(render({ monitors: { COM4: mon({}, { last_reset: '0x7 (TG0WDT_SYS_RST)', last_boot_at: 1000 }) } }))
  assert.ok(s.includes(zh['reset.watchdog']))
})

test('test_buttons_have_borders', () => {
  const plain = nodes(render()).filter(n => n.type === 'Button' && n.props.plain && n.props.key !== 'refresh')
  assert.deepEqual(plain.map(n => n.props.key), [])
})

test('test_busy_retry_is_primary', () => {
  const tree = render({ monitors: { COM4: mon({ state: 'busy' }) } })
  assert.equal(find(tree, 'mon-retry:COM4').props.variant, 'primary')
  assert.ok(texts(tree).includes(zh['health.busy']))
})

test('test_unprobed_probe_primary', () => {
  const tree = render({ boards: [board({ state: 'unprobed', info: null })], monitors: {} })
  const b = find(tree, 'probe:COM4')
  assert.equal(b.props.variant, 'primary')
  assert.equal(b.props.label, zh['btn.probe'])
  assert.ok(texts(tree).includes(zh['health.unprobed']))
})

const many = n => Array.from({ length: n }, (_, i) => ({ i, text: `12:00:00.000 I (${i}) app: line-${i}` }))

test('test_log_default_limit_and_more', () => {
  const short = render({ monitors: { COM4: mon({}, {}, many(50)) } })
  assert.ok(!texts(short).includes('line-19') && texts(short).includes('line-20'))
  assert.ok(find(short, 'more:COM4'))
  const long = render({ monitors: { COM4: mon({}, {}, many(50)) }, logMore: { COM4: true } })
  assert.ok(texts(long).includes('line-0'))
})

test('test_log_filter_problems', () => {
  const lines = [{ i: 0, text: 'I (1) a: fine' }, { i: 1, text: 'E (2) a: broken' }, { i: 2, text: 'W (3) a: careful' }]
  const tree = render({ monitors: { COM4: mon({}, { errors: 1, warnings: 1 }, lines) }, logFilter: { COM4: 'problems' } })
  const s = texts(tree)
  assert.ok(!s.includes('fine') && s.includes('broken') && s.includes('careful'))
  assert.equal(find(tree, 'filter-problems:COM4').props.variant, 'primary')
  assert.equal(find(tree, 'filter-all:COM4').props.variant, 'secondary')
  assert.ok(s.includes(t('log.title', { errors: 1, warnings: 1 })))
})

test('test_flash_confirm_card', () => {
  const tree = render({ flashDraft: { COM4: { path: 'C:\\fw\\a.merged.bin', bytes: 4194304, confirming: true } } })
  const s = texts(tree)
  for (const want of ['a.merged.bin', '4.0 MB', 'COM4', zh['flash.overwrite']]) assert.ok(s.includes(want), want)
  assert.ok(s.includes(t('flash.estimate', { time: t('dur.s', { s: 24 }) })))
  assert.equal(find(tree, 'flash-confirm:COM4').props.variant, 'primary')
})

test('test_flash_progress_bar', () => {
  const m = { ...mon(), flash: { state: 'running', percent: 50, file: 'C:\\fw\\a.bin', startedAt: 1290 } }
  const s = texts(render({ monitors: { COM4: m } }))
  assert.ok(s.includes('██████████░░░░░░░░░░'))
  assert.ok(s.includes('50%'))
  assert.ok(s.includes(zh['flash.dontUnplug']))
})

test('test_flash_done_card_and_dismiss', () => {
  const m = { ...mon(), flash: { state: 'done', percent: 100, file: 'C:\\fw\\a.bin', startedAt: 1000, finishedAt: 1024 } }
  const tree = render({ monitors: { COM4: m } })
  assert.ok(texts(tree).includes(t('flash.done', { file: 'a.bin', time: t('dur.s', { s: 24 }) })))
  assert.ok(find(tree, 'flash-dismiss:COM4'))
  const dismissed = render({ monitors: { COM4: m }, flashDismissed: { COM4: 1000 } })
  assert.ok(!texts(dismissed).includes(t('flash.done', { file: 'a.bin', time: t('dur.s', { s: 24 }) })))
})

test('test_flash_failed_advice', () => {
  const m = { ...mon(), flash: { state: 'failed', reason: 'busy', file: 'a.bin', startedAt: 1000 } }
  const s = texts(render({ monitors: { COM4: m } }))
  assert.ok(s.includes(zh['flash.advice.busy']))
})

test('test_empty_state_checklist', () => {
  const s = texts(render({ boards: [], monitors: {} }))
  for (const key of ['empty.title', 'empty.step1', 'empty.step2', 'empty.step3']) assert.ok(s.includes(zh[key]), key)
})

test('test_footer_auto_scan_note', () => {
  assert.ok(texts(render()).includes(zh['footer.autoScan']))
})
