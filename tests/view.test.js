import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { paneTree, statusText } from '../hooks/view.js'
import { translator } from '../hooks/texts.js'

const locale = tag => JSON.parse(readFileSync(new URL(`../locales/${tag}.json`, import.meta.url), 'utf8'))
const zh = locale('zh')
const t = translator([zh])

const component = type => props => ({ type, props })
const ui = { Box: component('Box'), Text: component('Text'), Button: component('Button') }

function nodes(tree, out = []) {
  if (tree && typeof tree === 'object') {
    out.push(tree)
    for (const child of tree.props?.children ?? []) nodes(child, out)
  }
  return out
}
const texts = tree => {
  const parts = []
  const walk = n => {
    if (typeof n === 'string' || typeof n === 'number') parts.push(String(n))
    else if (n && typeof n === 'object') {
      if (n.props?.label) parts.push(n.props.label)
      for (const c of n.props?.children ?? []) walk(c)
    }
  }
  walk(tree)
  return parts.join('\n')
}
const find = (tree, key) => nodes(tree).find(n => n.props?.key === key)

const INFO = {
  ok: true, port: 'COM4', chip: 'ESP32-S3', package: 'QFN56', revision: 'v0.2', cpu_mhz: 240, psram: '8MB', crystal_mhz: 40,
  mac: '74:4d:bd:9d:b5:44', flash: { manufacturer: 'c8', device: '4018', size: '16MB', type: 'quad', voltage: '3.3V' },
  probed_at: '2026-10-28T10:00:00+08:00',
}
const board = over => ({ port: 'COM4', bridge: 'cp210x', serial: 'S', key: 'K', state: 'known', info: INFO,
  probedAt: INFO.probed_at, reason: null, detail: null, ...over })
const view = over => ({ boards: [board()], missingDriver: [], python: { state: 'ok' }, polling: 'background', ...over })
const noop = { probe() {}, refresh() {} }

test('test_known_board', () => {
  const tree = paneTree(ui, view(), t, noop)
  const s = texts(tree)
  for (const want of ['ESP32-S3', 'COM4', '16MB', '8MB', '74:4d:bd:9d:b5:44']) assert.ok(s.includes(want), want)
  const title = nodes(tree).find(n => n.type === 'Text' && n.props.weight === 'semibold')
  assert.equal(title.props.color, 'green')
  assert.equal(find(tree, 'probe:COM4').props.label, zh['btn.reprobe'])
})

test('test_unprobed_board', () => {
  const tree = paneTree(ui, view({ boards: [board({ state: 'unprobed', info: null, probedAt: null })] }), t, noop)
  assert.equal(find(tree, 'probe:COM4').props.label, zh['btn.probe'])
  assert.ok(texts(tree).includes(zh['probe.resetsBoard']))
})

test('test_probing_has_no_button', () => {
  const tree = paneTree(ui, view({ boards: [board({ state: 'probing' })] }), t, noop)
  assert.equal(find(tree, 'probe:COM4'), undefined)
})

test('test_failed_busy', () => {
  const s = texts(paneTree(ui, view({ boards: [board({ state: 'failed', reason: 'busy', detail: 'd' })] }), t, noop))
  assert.ok(s.includes(zh['fail.busy']))
  assert.ok(s.includes('ESP32-S3'))
})

test('test_missing_driver', () => {
  const v = view({ boards: [], missingDriver: [{ name: 'CP2102N USB to UART Bridge Controller', vid: '10C4', pid: 'EA60', error_code: 28 }] })
  assert.ok(texts(paneTree(ui, v, t, noop)).includes('错误码 28'))
})

test('test_python_deps', () => {
  const v = view({ python: { state: 'deps', detail: 'C:\\Py\\python.exe' } })
  assert.ok(texts(paneTree(ui, v, t, noop)).includes('pip install --user pyserial esptool'))
})

test('test_empty', () => {
  assert.ok(texts(paneTree(ui, view({ boards: [] }), t, noop)).includes(zh.empty))
})

test('test_pane_only_polling_note', () => {
  assert.ok(texts(paneTree(ui, view({ polling: 'pane' }), t, noop)).includes(zh['polling.paneOnly']))
})

test('test_button_calls_action', () => {
  let got
  const tree = paneTree(ui, view(), t, { probe: p => { got = p }, refresh() {} })
  find(tree, 'probe:COM4').props.onPress()
  assert.equal(got, 'COM4')
})

test('test_status_text', () => {
  assert.equal(statusText(view({ boards: [] }), t), zh['status.none'])
  assert.ok(statusText(view(), t).includes('ESP32-S3 · COM4'))
  assert.equal(statusText(view({ boards: [board(), board({ port: 'COM7' })] }), t), t('status.many', { n: 2 }))
})

test('test_locales_same_keys', () => {
  assert.deepEqual(Object.keys(locale('en')).sort(), Object.keys(zh).sort())
})
