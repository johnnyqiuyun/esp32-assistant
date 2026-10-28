import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { monitorTree } from '../hooks/monitor-view.js'
import { paneTree } from '../hooks/view.js'
import { translator } from '../hooks/texts.js'

const zh = JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8'))
const t = translator([zh])
const component = type => props => ({ type, props })
const ui = { Box: component('Box'), Text: component('Text'), Button: component('Button'), Input: component('Input'), Link: component('Link') }

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

const board = { port: 'COM4', bridge: 'cp210x', state: 'known', info: { chip: 'ESP32-S3' } }
const summary = over => ({ status: 'running', boots: 2, last_reset: '0x1 (POWERON)', last_boot_at: 1000, errors: 0, warnings: 0,
  wifi: { state: 'connected', ssid: 'MyAP', ip: '192.168.1.23', reason: null, rssi: -58 }, ...over })
const mon = (over = {}, lines = []) => ({ monitor: { state: 'running', summary: summary(), log: 'C:\\logs\\a.log', ...over }, alive: true, lines, flash: null })
const opts = over => ({ clearAt: 0, draft: null, linkOpensFolder: false, logDir: 'C:\\data\\logs', now: 1065000, ...over })
const noop = new Proxy({}, { get: () => () => {} })
const render = (m, o) => monitorTree(ui, board, m, t, noop, opts(o))

test('test_running_summary', () => {
  const tree = render(mon())
  const s = texts(tree)
  for (const want of ['MyAP', '192.168.1.23', '-58']) assert.ok(s.includes(want), want)
  for (const key of ['mon-stop:COM4', 'mon-pause:COM4', 'mon-reset:COM4', 'clear:COM4']) assert.ok(find(tree, key), key)
})

test('test_uptime_shown', () => {
  assert.ok(texts(render(mon())).includes('1m 5s'))
})

test('test_crashed_red', () => {
  const tree = render(mon({ summary: summary({ status: 'crashed' }) }))
  assert.equal(textNode(tree, zh['mon.status.crashed']).props.color, 'red')
})

test('test_disconnected_reason_text', () => {
  const m = mon({ summary: summary({ wifi: { state: 'disconnected', ssid: 'MyAP', ip: null, reason: 201, rssi: null } }) })
  assert.ok(texts(render(m)).includes(zh['wifi.reason.201']))
})

test('test_line_colors', () => {
  const lines = [{ i: 0, text: '12:00:00.000 E (1) a: b' }, { i: 1, text: '12:00:00.000 W (1) a: b' },
    { i: 2, text: "12:00:00.000 Guru Meditation Error: Core  0 panic'ed" }, { i: 3, text: '12:00:00.000 RSSI: 3' }]
  const tree = render(mon({}, lines))
  assert.equal(textNode(tree, 'E (1)').props.color, 'red')
  assert.equal(textNode(tree, 'W (1)').props.color, 'yellow')
  const panic = textNode(tree, 'Guru Meditation')
  assert.equal(panic.props.color, 'red')
  assert.equal(panic.props.weight, 'bold')
  assert.equal(textNode(tree, 'RSSI: 3').props.color, 'cyan')
})

test('test_clear_hides_old_lines', () => {
  const lines = [3, 4, 5, 6, 7].map(i => ({ i, text: `line-${i}` }))
  const s = texts(render(mon({}, lines), { clearAt: 5 }))
  assert.ok(!s.includes('line-3') && !s.includes('line-4'))
  assert.ok(s.includes('line-5') && s.includes('line-7'))
})

test('test_busy_buttons', () => {
  const tree = render(mon({ state: 'busy' }))
  assert.ok(find(tree, 'mon-retry:COM4'))
  assert.ok(texts(tree).includes(zh['mon.busyHint']))
})

test('test_paused_buttons', () => {
  const tree = render(mon({ state: 'paused' }))
  assert.ok(find(tree, 'mon-resume:COM4'))
  assert.equal(find(tree, 'mon-pause:COM4'), undefined)
})

test('test_no_monitor_start_button', () => {
  const tree = render(undefined)
  assert.ok(find(tree, 'mon-start:COM4'))
  assert.equal(find(tree, 'mon-stop:COM4'), undefined)
})

test('test_flash_input_and_ask', () => {
  const tree = render(mon())
  assert.equal(find(tree, 'flash-path:COM4').type, 'Input')
  assert.ok(find(tree, 'flash-ask:COM4'))
})

test('test_flash_confirm_flow', () => {
  const tree = render(mon(), { draft: { path: 'C:\\fw\\a.merged.bin', confirming: true } })
  const s = texts(tree)
  assert.ok(s.includes('a.merged.bin') && s.includes('COM4'))
  assert.ok(find(tree, 'flash-confirm:COM4'))
  assert.ok(find(tree, 'flash-cancel:COM4'))
})

test('test_flash_error_shown', () => {
  const s = texts(render(mon(), { draft: { path: 'x.elf', confirming: false, error: 'not_esp_image' } }))
  assert.ok(s.includes(zh['flash.error.not_esp_image']))
})

test('test_flash_progress', () => {
  const m = { ...mon(), flash: { state: 'running', percent: 42, file: 'C:\\fw\\a.bin' } }
  const tree = render(m)
  assert.ok(texts(tree).includes('42'))
  assert.equal(find(tree, 'flash-ask:COM4'), undefined)
})

test('test_log_dir_link_or_text', () => {
  assert.ok(texts(render(mon())).includes('C:\\data\\logs'))
  assert.equal(find(render(mon(), { linkOpensFolder: true }), 'logdir:COM4').type, 'Link')
})

test('test_pane_includes_monitor_section', () => {
  const view = { boards: [{ ...board, serial: 'S', key: 'K', probedAt: null, reason: null, detail: null, info: null, state: 'unprobed' }],
    missingDriver: [], python: { state: 'ok' }, polling: 'background', monitors: {}, clearAt: {}, flashDraft: {}, logDir: 'C:\\d', linkOpensFolder: false }
  assert.ok(find(paneTree(ui, view, t, noop), 'mon-start:COM4'))
})

test('test_pane_without_monitors_has_no_monitor_section', () => {
  const view = { boards: [{ ...board, serial: 'S', key: 'K', probedAt: null, reason: null, detail: null, info: null, state: 'unprobed' }],
    missingDriver: [], python: { state: 'ok' }, polling: 'background' }
  assert.equal(find(paneTree(ui, view, t, noop), 'mon-start:COM4'), undefined)
})
