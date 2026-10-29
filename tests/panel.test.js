// The pane module end to end against a fake engine: it must reach the engine only through `$` in hooks
// (Claude Code refuses a module that stores or passes `$`), scan, open on /esp32 and draw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { register } from '../hooks/panel.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const PORT = { port: 'COM4', vid: 0x10c4, pid: 0xea60, serial: 'S1', bridge: 'cp210x', description: 'CP2102N' }

function fakeEngine() {
  const hooks = []
  const state = new Map()
  const opened = []
  const ran = []
  const component = type => props => ({ type, props })
  const $ = {
    plugin: { name: 'esp32s3-bringup', root: ROOT, locale: 'zh-CN' },
    process: {
      run: async argv => {
        ran.push(argv)
        const sub = argv[argv.indexOf(`${ROOT}/scripts/esp32_bringup.py`) + 1]
        if (argv.includes('-c')) return { exitCode: 0, stdout: '' }
        if (sub === 'home') return { exitCode: 0, stdout: JSON.stringify({ home: 'C:\\data' }) }
        if (sub === 'ports') return { exitCode: 0, stdout: JSON.stringify({ ports: [PORT], missing_driver: [] }) }
        if (sub === 'monitor') return new Promise(() => {}) // the long monitor run never returns in a test
        return { exitCode: 1, stdout: '{}' }
      },
    },
    fs: { read: async path => readFileSync(path, 'utf8'), exists: async () => true },
    env: { get: async () => undefined },
    store: { get: async () => undefined, set: async () => {} },
    state: { get: async ref => ({ value: state.get(ref.key) }), set: async (ref, value) => { state.set(ref.key, value) } },
    command: { register: async () => {} },
    clock: { every: () => ({ cancel() {} }) },
    ui: {
      open: async options => { opened.push(options); return { isPlaced: true } },
      status: async () => {},
      resolve: () => ({ Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') }),
    },
  }
  const on = (event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : null, hook: hook ?? matcher })
  register(on)
  const fire = async (event, e) => {
    const h = hooks.find(x => x.event === event && (!x.matcher || Object.entries(x.matcher).every(([k, v]) => e[k] === v)))
    return h.hook($, e, async () => ({}))
  }
  return { fire, state, opened, ran }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('test_command_opens_pane_and_draws_the_board', async () => {
  const engine = fakeEngine()
  await engine.fire('session.start', {})
  await engine.fire('command.run', { command: 'esp32', args: '' })
  await settle()
  assert.equal(engine.opened.at(-1).id, 'esp32')
  assert.ok(engine.ran.some(argv => argv.includes('ports')))
  const tree = await engine.fire('ui.render', { component: 'Pane', requestId: 'esp32', surface: 'terminal' })
  assert.ok(JSON.stringify(tree).includes('COM4'))
  assert.equal(engine.state.get('view').boards[0].port, 'COM4')
})
