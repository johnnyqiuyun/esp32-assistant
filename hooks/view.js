/**
 * The ESP32 pane and status line, as pure functions of the view:
 * `{ boards: Board[], missingDriver: object[] | null, python: { state, detail? }, polling: 'background' | 'pane' }`.
 * `ui` is `{ Box, Text, Button }` from `$.ui.resolve(e)`.
 */

import { monitorTree } from './monitor-view.js'

const STATE_COLOR = { known: 'green', probing: 'yellow', failed: 'red' }

function localTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso ?? '')
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function boardTree(ui, b, t, actions) {
  const { Box, Text, Button } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const name = b.info?.chip ?? t(`bridge.${b.bridge}`)
  const children = [
    Text({ weight: 'semibold', size: 'body', color: STATE_COLOR[b.state], wrap: 'wrap',
      children: [`${name} · ${b.port} · ● ${t(`state.${b.state}`)}`] }),
  ]
  if (b.state === 'failed') {
    children.push(caption(t(`fail.${b.reason}`), { color: 'red' }))
    if (b.detail) children.push(caption(b.detail, { dimColor: true }))
  }
  const i = b.info
  if (i && (b.state === 'known' || b.state === 'failed')) {
    children.push(
      caption(t('field.chip', { chip: i.chip, package: i.package ?? '—', revision: i.revision ?? '—' })),
      caption(t('field.cpu', { mhz: i.cpu_mhz ?? '—' })),
      caption(t('field.flash', { size: i.flash?.size ?? '—', type: i.flash?.type ?? '—', voltage: i.flash?.voltage ?? '—' })),
      caption(t('field.psram', { psram: i.psram ?? t('psram.none') })),
      caption(t('field.crystal', { mhz: i.crystal_mhz ?? '—' })),
      caption(t('field.mac', { mac: i.mac ?? '—' }), { mono: true }),
      caption(t('field.probedAt', { time: localTime(b.probedAt) }), { dimColor: true }),
    )
  }
  if (b.state !== 'probing') {
    children.push(
      Button({ key: `probe:${b.port}`, label: t(b.state === 'unprobed' ? 'btn.probe' : 'btn.reprobe'),
        variant: b.state === 'unprobed' ? 'primary' : 'secondary', onPress: () => actions.probe(b.port) }),
      caption(t('probe.resetsBoard'), { dimColor: true }),
    )
  }
  return Box({ key: `board:${b.port}`, flexDirection: 'column', children })
}

export function paneTree(ui, view, t, actions) {
  const { Box, Text, Button } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const children = view.boards.map(b => {
    const card = boardTree(ui, b, t, actions)
    if (!view.monitors) return card
    const opts = { clearAt: view.clearAt?.[b.port] ?? 0, draft: view.flashDraft?.[b.port] ?? null,
      linkOpensFolder: !!view.linkOpensFolder, logDir: view.logDir ?? '', now: view.now ?? Date.now() }
    return Box({ key: `card:${b.port}`, flexDirection: 'column', gap: 1,
      children: [card, monitorTree(ui, b, view.monitors[b.port], t, actions, opts)] })
  })
  for (const m of view.missingDriver ?? []) {
    children.push(Box({ key: `driver:${m.vid}:${m.pid}:${m.name}`, flexDirection: 'column', children: [
      caption(t('driver.missing', { name: m.name, code: m.error_code }), { color: 'red' }),
      caption(t('driver.howto')),
    ] }))
  }
  if (view.python && view.python.state !== 'ok') {
    children.push(caption(t(`python.${view.python.state}`, { detail: view.python.detail ?? '' }), { color: 'yellow' }))
  }
  if (!view.boards.length && !(view.missingDriver ?? []).length) children.push(caption(t('empty'), { dimColor: true }))
  children.push(Button({ key: 'refresh', label: t('btn.refresh'), plain: true, onPress: actions.refresh }))
  if (view.polling === 'pane') children.push(caption(t('polling.paneOnly'), { dimColor: true }))
  return Box({ flexDirection: 'column', gap: 1, paddingX: 1, children })
}

export function statusText(view, t) {
  const boards = view.boards ?? []
  if (!boards.length) return t('status.none')
  if (boards.length > 1) return t('status.many', { n: boards.length })
  const b = boards[0]
  return `${b.info?.chip ?? t(`bridge.${b.bridge}`)} · ${b.port} · ${t(`state.${b.state}`)}`
}
