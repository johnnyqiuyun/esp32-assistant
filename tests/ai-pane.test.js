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
const noop = new Proxy({}, { get: () => () => {} })

const board = { port: 'COM4', bridge: 'cp210x', serial: 'S', key: 'K', state: 'known', info: { chip: 'ESP32-S3' }, probedAt: null, reason: null, detail: null }
const summary = over => ({ status: 'running', boots: 1, last_reset: '0x1 (POWERON)', last_boot_at: 1000, errors: 0, warnings: 0,
  wifi: { state: 'unknown', rssi: null }, ...over })
const mon = (sum = {}) => ({ monitor: { state: 'running', startedAt: 900, summary: summary(sum) }, lines: [{ i: 0, text: 'I (1) a: b' }], flash: null })
const view = over => ({ boards: [board], missingDriver: [], python: { state: 'ok' }, polling: 'background', monitors: { COM4: mon() },
  clearAt: {}, flashDraft: {}, logDir: 'C:\\d', now: 1300_000, expanded: {}, logFilter: {}, logMore: {}, flashDismissed: {}, ai: {}, ...over })
const render = over => paneTree(ui, view(over), t, noop)

test('test_ai_button_secondary_when_healthy', () => {
  const b = find(render(), 'ai-explain:COM4')
  assert.equal(b.props.label, zh['btn.ai'])
  assert.equal(b.props.variant, 'secondary')
})

test('test_ai_button_primary_when_crashed', () => {
  assert.equal(find(render({ monitors: { COM4: mon({ status: 'crashed' }) } }), 'ai-explain:COM4').props.variant, 'primary')
})

test('test_no_ai_button_without_any_output', () => {
  assert.equal(find(render({ monitors: {} }), 'ai-explain:COM4'), undefined)
})

test('test_ai_running', () => {
  const tree = render({ ai: { COM4: { state: 'running' } } })
  assert.ok(texts(tree).includes(zh['ai.running']))
  assert.equal(find(tree, 'ai-explain:COM4'), undefined)
})

test('test_ai_result_card', () => {
  const result = { state: 'done', ok: true, cause: 'Null pointer in app_main', steps: ['Check the pointer', 'Add a guard'],
    confidence: 'high', model: 'nvidia/Nemotron-3_5-Lightning', seconds: 3.2, sent: { lines: 80 } }
  const tree = render({ ai: { COM4: result } })
  const s = texts(tree)
  for (const want of ['Null pointer in app_main', '1. Check the pointer', '2. Add a guard', zh['ai.confidence.high'],
    t('ai.credit', { model: 'nvidia/Nemotron-3_5-Lightning', seconds: 3.2 }), t('ai.sent', { lines: 80 })]) assert.ok(s.includes(want), want)
  assert.ok(find(tree, 'ai-dismiss:COM4'))
  assert.equal(find(tree, 'ai-explain:COM4').props.label, zh['btn.aiAgain'])
})

test('test_ai_no_key_help', () => {
  const s = texts(render({ ai: { COM4: { state: 'failed', ok: false, reason: 'no_key' } } }))
  assert.ok(s.includes(zh['ai.error.no_key']))
  assert.ok(zh['ai.error.no_key'].includes('setx NEBIUS_API_KEY'))
})

test('test_ai_error_texts_exist', () => {
  for (const r of ['no_key', 'bad_key', 'bad_model', 'network', 'timeout', 'server', 'error']) assert.equal(typeof zh[`ai.error.${r}`], 'string', r)
})
