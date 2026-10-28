/**
 * The ESP32 pane and status line, as pure functions of the view (design: docs/design-ux.md):
 * `{ boards, missingDriver, python, polling, monitors?, clearAt?, flashDraft?, logDir?, linkOpensFolder?, now?,
 *    expanded?, logFilter?, logMore?, flashDismissed? }`.
 * `ui` is `{ Box, Text, Button, Link }` from `$.ui.resolve(e)`.
 */

import { monitorTree } from './monitor-view.js'
import { formatDuration, health, overview } from './ux.js'

const TONE_COLOR = { ok: 'green', warn: 'yellow', error: 'red' }

function localTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso ?? '')
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The monitor state that counts as running (a stopped one is shown as none). */
function liveMonitor(mon) {
  return mon?.monitor && mon.monitor.state !== 'stopped' ? mon.monitor : null
}

/** "16MB Flash · 8MB PSRAM · 240 MHz · v0.2", leaving out whatever the probe did not report. */
function specLine(i, t) {
  const parts = []
  if (i.flash?.size) parts.push(t('spec.flash', { size: i.flash.size }))
  if ('psram' in i) parts.push(t('spec.psram', { psram: i.psram ?? t('psram.none') })) // null = the probe found none
  if (i.cpu_mhz) parts.push(t('spec.mhz', { mhz: i.cpu_mhz }))
  if (i.revision) parts.push(i.revision)
  return parts.length ? parts.join(' · ') : i.chip ?? ''
}

function resetText(kind, raw, t) {
  return kind === 'other' ? raw : t(`reset.${kind}`)
}

function healthText(h, t) {
  if (h.key === 'health.probeFailed') return t(h.key, { reason: t(`fail.${h.vars.reason}`) })
  if (h.key === 'health.rebooted') return t(h.key, { reason: resetText(h.vars.kind, h.vars.raw, t) })
  if (h.key === 'health.bootLoop') return t(h.key, { n: h.vars.n, reason: resetText(h.vars.kind, h.vars.raw, t) })
  if (h.key === 'health.flashFailed') return t(h.key, { reason: t(`flash.error.${h.vars.reason}`) })
  if (h.key === 'health.flashing' || h.key === 'health.idle') return t(h.key, h.vars)
  if (h.key === 'health.running') {
    return h.vars.seconds === null ? t('health.runningShort') : t(h.key, { time: formatDuration(h.vars.seconds, t) })
  }
  if (h.key === 'health.watching') return t(h.key, { time: formatDuration(h.vars.watched, t) })
  return t(h.key)
}

function boardHead(ui, b, h, expanded, t, actions) {
  const { Box, Text, Button } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const color = TONE_COLOR[h.tone]
  const children = [
    Text({ weight: 'semibold', size: 'body', color, wrap: 'wrap', children: [`● ${b.info?.chip ?? t(`bridge.${b.bridge}`)} · ${b.port}`] }),
    Text({ size: 'body', color, wrap: 'wrap', children: [healthText(h, t)] }),
  ]
  // A live verdict wins; an earlier identification failure stays visible underneath.
  if (b.state === 'failed' && h.key !== 'health.probeFailed') {
    children.push(caption(t('health.probeFailed', { reason: t(`fail.${b.reason}`) }), { dimColor: true }))
  }
  if (b.state === 'failed' && b.detail) children.push(caption(b.detail, { dimColor: true }))
  const i = b.info
  if (i) {
    children.push(Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
      caption(specLine(i, t)),
      Button({ key: `details:${b.port}`, label: t(expanded ? 'btn.hideDetails' : 'btn.details'), variant: 'secondary',
        onPress: () => actions.toggleDetails(b.port) }),
    ] }))
    if (expanded) {
      children.push(
        caption(t('field.chip', { chip: i.chip, package: i.package ?? '—', revision: i.revision ?? '—' }), { dimColor: true }),
        caption(t('field.crystal', { mhz: i.crystal_mhz ?? '—' }), { dimColor: true }),
        caption(t('field.flash', { size: i.flash?.size ?? '—', type: i.flash?.type ?? '—', voltage: i.flash?.voltage ?? '—' }), { dimColor: true }),
        caption(t('field.mac', { mac: i.mac ?? '—' }), { mono: true, dimColor: true }),
        caption(t('field.probedAt', { time: localTime(b.probedAt) }), { dimColor: true }),
      )
    }
  }
  if (b.state !== 'probing') {
    const first = b.state === 'unprobed'
    children.push(Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
      Button({ key: `probe:${b.port}`, label: t(first ? 'btn.probe' : 'btn.reprobe'), variant: first ? 'primary' : 'secondary',
        onPress: () => actions.probe(b.port) }),
      ...(first ? [caption(t('probe.resetsBoard'), { dimColor: true })] : []),
    ] }))
  }
  return children
}

export function paneTree(ui, view, t, actions) {
  const { Box, Text, Button } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const now = view.now ?? Date.now()
  const healths = view.boards.map(b => {
    const mon = view.monitors?.[b.port]
    return health(b, liveMonitor(mon), now, { flash: mon?.flash, dismissed: view.flashDismissed?.[b.port] ?? null, lines: mon?.lines ?? [] })
  })
  const pythonOk = !view.python || view.python.state === 'ok'
  const head = overview(view.boards, healths, view.missingDriver, view.python)
  const children = [
    Text({ weight: 'semibold', size: 'body', children: [t('pane.heading')] }),
    Text({ size: 'body', color: TONE_COLOR[head.tone], wrap: 'wrap', children: [t(head.key, head.vars)] }),
  ]
  view.boards.forEach((b, n) => {
    const card = boardHead(ui, b, healths[n], !!view.expanded?.[b.port], t, actions)
    if (view.monitors) {
      const mon = view.monitors[b.port]
      const cleared = view.clearAt?.[b.port]
      // Line numbers restart with every monitor process, so a Clear applies only to the run it was made in.
      const clearAt = cleared && cleared.startedAt === mon?.monitor?.startedAt ? cleared.at : 0
      card.push(monitorTree(ui, b, mon, t, actions, {
        clearAt, draft: view.flashDraft?.[b.port] ?? null, linkOpensFolder: !!view.linkOpensFolder, logDir: view.logDir ?? '', now,
        filter: view.logFilter?.[b.port] ?? 'all', more: !!view.logMore?.[b.port], dismissed: view.flashDismissed?.[b.port] ?? null,
      }))
    }
    children.push(Box({ key: `card:${b.port}`, flexDirection: 'column', gap: 1, children: card }))
  })
  for (const m of view.missingDriver ?? []) {
    children.push(Box({ key: `driver:${m.vid}:${m.pid}:${m.name}`, flexDirection: 'column', children: [
      Text({ weight: 'semibold', color: 'red', children: [t('driver.title')] }),
      caption(t('driver.missing', { name: m.name, code: m.error_code }), { color: 'red' }),
      caption(t('driver.howto')),
    ] }))
  }
  if (view.python && view.python.state !== 'ok') {
    children.push(Box({ key: 'python', flexDirection: 'column', children: [
      Text({ weight: 'semibold', color: 'yellow', children: [t('python.title')] }),
      caption(t(`python.${view.python.state}`, { detail: view.python.detail ?? '' }), { color: 'yellow' }),
    ] }))
  }
  // Without Python nothing is scanned, so an empty list says nothing about the cable.
  if (pythonOk && !view.boards.length && !(view.missingDriver ?? []).length) {
    children.push(Box({ key: 'empty', flexDirection: 'column', children: [
      caption(t('empty.title')), caption(t('empty.step1')), caption(t('empty.step2')), caption(t('empty.step3')),
    ] }))
  }
  children.push(Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
    Button({ key: 'refresh', label: t('btn.refresh'), plain: true, onPress: actions.refresh }),
    caption(t(!pythonOk ? 'footer.noScan' : view.polling === 'pane' ? 'polling.paneOnly' : 'footer.autoScan'), { dimColor: true }),
  ] }))
  return Box({ flexDirection: 'column', gap: 1, paddingX: 1, children })
}

export function statusText(view, t) {
  const boards = view.boards ?? []
  if (!boards.length) return t('status.none')
  if (boards.length > 1) return t('status.many', { n: boards.length })
  const b = boards[0]
  return `${b.info?.chip ?? t(`bridge.${b.bridge}`)} · ${b.port} · ${t(`state.${b.state}`)}`
}
