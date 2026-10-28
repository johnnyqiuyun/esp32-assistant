/**
 * The monitor and flash section of one board card, as a pure function of the
 * `monitor status --json` result for its port (`mon`, may be undefined).
 * `opts`: `{ clearAt, draft: { path, confirming, error? } | null, linkOpensFolder, logDir, now }`.
 */

import { lineLevel } from './core.js'

const LINE_STYLE = {
  panic: { color: 'red', weight: 'bold' },
  error: { color: 'red' },
  warn: { color: 'yellow' },
  wifi: { color: 'cyan' },
  info: {},
}
const STATE_COLOR = { running: 'green', busy: 'yellow', waiting: 'yellow' }

function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}

function summaryLine(monitor, t, now) {
  const parts = [t(`mon.state.${monitor.state}`)]
  const s = monitor.summary
  let color = STATE_COLOR[monitor.state]
  if (monitor.state === 'running' && s) {
    parts.push(t(`mon.status.${s.status}`))
    if (s.status === 'crashed') color = 'red'
    parts.push(t('mon.boots', { n: s.boots }))
    if (s.last_boot_at) parts.push(t('mon.uptime', { time: duration(now / 1000 - s.last_boot_at) }))
    const w = s.wifi ?? {}
    if (w.state === 'connected') parts.push(t('wifi.connected', { ssid: w.ssid ?? '?', ip: w.ip ?? '—' }))
    else if (w.state === 'disconnected') {
      const text = t(`wifi.reason.${w.reason}`)
      parts.push(t('wifi.disconnected', { reason: w.reason, text: text === `wifi.reason.${w.reason}` ? '' : text }))
    } else parts.push(t('wifi.unknown'))
    if (w.rssi !== null && w.rssi !== undefined) parts.push(`RSSI ${w.rssi}`)
  }
  return { text: parts.join(' · '), color }
}

function buttons(ui, port, state, t, actions) {
  const { Box, Button } = ui
  const b = (key, label, onPress) => Button({ key: `${key}:${port}`, label: t(label), plain: true, onPress })
  const list = {
    running: [b('mon-stop', 'btn.monStop', () => actions.monitorStop(port)), b('mon-pause', 'btn.monPause', () => actions.monitorPause(port)),
      b('mon-reset', 'btn.monReset', () => actions.monitorReset(port)), b('clear', 'btn.clear', () => actions.clear(port))],
    paused: [b('mon-resume', 'btn.monResume', () => actions.monitorResume(port)), b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
    busy: [b('mon-retry', 'btn.monRetry', () => actions.monitorRetry(port)), b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
    waiting: [b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
  }[state] ?? [Button({ key: `mon-start:${port}`, label: t('btn.monStart'), variant: 'primary', onPress: () => actions.monitorStart(port) })]
  return Box({ key: `mon-buttons:${port}`, flexDirection: 'row', gap: 1, children: list })
}

function flashSection(ui, port, flash, draft, t, actions) {
  const { Box, Text, Button, Input } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const file = path => String(path ?? '').split(/[\\/]/).at(-1)
  if (flash?.state === 'running') return caption(t('flash.progress', { percent: flash.percent ?? 0, file: file(flash.file) }), { color: 'yellow' })
  const children = []
  if (flash?.state === 'done') children.push(caption(t('flash.done', { file: file(flash.file) }), { color: 'green' }))
  if (flash?.state === 'failed') children.push(caption(t('flash.failed', { reason: t(`fail.${flash.reason}`) }), { color: 'red' }))
  if (draft?.confirming) {
    children.push(
      caption(t('flash.confirm', { file: file(draft.path), path: draft.path, port }), { color: 'red' }),
      Box({ flexDirection: 'row', gap: 1, children: [
        Button({ key: `flash-confirm:${port}`, label: t('btn.flashConfirm'), variant: 'primary', onPress: () => actions.flashConfirm(port) }),
        Button({ key: `flash-cancel:${port}`, label: t('btn.flashCancel'), onPress: () => actions.flashCancel(port) }),
      ] }),
    )
  } else {
    children.push(Box({ flexDirection: 'row', gap: 1, children: [
      Box({ flexGrow: 1, children: [Input({ key: `flash-path:${port}`, value: draft?.path ?? '', placeholder: t('flash.placeholder'),
        onInput: text => actions.flashInput(port, text), onSubmit: () => actions.flashAsk(port) })] }),
      Button({ key: `flash-ask:${port}`, label: t('btn.flash'), onPress: () => actions.flashAsk(port) }),
    ] }))
    if (draft?.error) children.push(caption(t(`flash.error.${draft.error}`), { color: 'red' }))
  }
  return Box({ key: `flash:${port}`, flexDirection: 'column', children })
}

export function monitorTree(ui, board, mon, t, actions, opts) {
  const { Box, Text, Link } = ui
  const port = board.port
  const monitor = mon?.monitor && mon.monitor.state !== 'stopped' ? mon.monitor : null
  const children = []
  if (monitor) {
    const { text, color } = summaryLine(monitor, t, opts.now)
    children.push(Text({ size: 'caption', weight: 'semibold', wrap: 'wrap', color, children: [text] }))
    if (monitor.state === 'busy') children.push(Text({ size: 'caption', wrap: 'wrap', color: 'yellow', children: [t('mon.busyHint')] }))
  }
  children.push(buttons(ui, port, monitor?.state, t, actions))
  for (const line of (mon?.lines ?? []).filter(l => l.i >= (opts.clearAt ?? 0))) {
    children.push(Text({ key: `line:${port}:${line.i}`, size: 'caption', mono: true, wrap: 'wrap', ...LINE_STYLE[lineLevel(line.text)], children: [line.text] }))
  }
  children.push(flashSection(ui, port, mon?.flash, opts.draft, t, actions))
  children.push(opts.linkOpensFolder
    ? Link({ key: `logdir:${port}`, href: `file:///${opts.logDir.replace(/\\/g, '/')}`, label: t('mon.logDir', { dir: opts.logDir }) })
    : Text({ key: `logdir:${port}`, size: 'caption', dimColor: true, wrap: 'wrap', children: [t('mon.logDir', { dir: opts.logDir })] }))
  return Box({ key: `monitor:${port}`, flexDirection: 'column', children })
}
