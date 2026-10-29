/**
 * The monitor and flash part of one board card, as a pure function of the `monitor status`
 * result for its port (`mon`, may be undefined). Design: docs/design-ux.md.
 * `opts`: `{ clearAt, draft: { path, bytes?, confirming, error? } | null, linkOpensFolder, logDir, now,
 *            filter: 'all'|'problems'|'wifi', more, dismissed }`.
 */

import { lineLevel } from './core.js'
import {
  estimateFlashSeconds, filterLines, flashResultVisible, formatBytes, formatDuration, isBadReset, progressBar, resetKind, rssiQuality,
  signalBars,
} from './ux.js'

const LINE_STYLE = {
  panic: { color: 'red', weight: 'bold' },
  error: { color: 'red' },
  warn: { color: 'yellow' },
  wifi: { color: 'cyan' },
  info: {},
}
const LOG_LINES = 30
const LOG_LINES_MORE = 200
const FILTERS = [['all', 'btn.filterAll'], ['problems', 'btn.filterProblems'], ['wifi', 'btn.filterWifi']]

const fileName = path => String(path ?? '').split(/[\\/]/).at(-1)

function wifiRow(ui, w, t) {
  const { Text } = ui
  let row
  if (w.state === 'connected') row = t('wifi.row.connected', { ssid: w.ssid ?? '?', ip: w.ip ?? '—' })
  else if (w.state === 'disconnected') {
    const reason = t(`wifi.reason.${w.reason}`)
    row = t('wifi.row.disconnected', { text: reason === `wifi.reason.${w.reason}` ? t('wifi.reason.other', { code: w.reason }) : reason })
  } else row = t('wifi.row.unknown')
  const q = rssiQuality(w.rssi)
  // A signal reading is only current while connected; the program's own non-dBm print is shown as is.
  if (q && (w.state === 'connected' || q.key === 'nonstandard')) {
    row += ' · ' + (q.key === 'nonstandard'
      ? t('signal.nonstandard', { rssi: w.rssi, quality: t('rssi.nonstandard') })
      : t('signal', { bars: signalBars(q.bars), quality: t(`rssi.${q.key}`), rssi: w.rssi }))
  }
  return Text({ size: 'caption', wrap: 'wrap', color: w.state === 'disconnected' ? 'yellow' : undefined, children: [row] })
}

function buttons(ui, port, state, t, actions) {
  const { Box, Button } = ui
  const b = (key, label, onPress, variant = 'secondary') => Button({ key: `${key}:${port}`, label: t(label), variant, onPress })
  const list = {
    running: [b('mon-pause', 'btn.monPause', () => actions.monitorPause(port)), b('mon-reset', 'btn.monReset', () => actions.monitorReset(port)),
      b('clear', 'btn.clear', () => actions.clear(port)), b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
    paused: [b('mon-resume', 'btn.monResume', () => actions.monitorResume(port), 'primary'), b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
    busy: [b('mon-retry', 'btn.monRetry', () => actions.monitorRetry(port), 'primary'), b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
    waiting: [b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
    starting: [b('mon-stop', 'btn.monStop', () => actions.monitorStop(port))],
  }[state] ?? [b('mon-start', 'btn.monStart', () => actions.monitorStart(port), 'primary')]
  return Box({ key: `mon-buttons:${port}`, flexDirection: 'row', gap: 1, children: list })
}

/**
 * AI diagnosis by NVIDIA Nemotron on Nebius Token Factory (`esp32_bringup.py explain`).
 * `opts.ai`: undefined | { state: 'running' } | { state: 'done', cause, steps, confidence, model, seconds, sent }
 *            | { state: 'failed', reason }. The button is the main action when the verdict is a problem.
 */
function aiSection(ui, port, t, actions, opts) {
  const { Box, Text, Button } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const ai = opts.ai
  if (ai?.state === 'running') return Box({ key: `ai:${port}`, children: [caption(t('ai.running'), { color: 'cyan' })] })
  const children = []
  if (ai?.state === 'done') {
    children.push(
      Text({ size: 'caption', weight: 'semibold', color: 'cyan', children: [t('ai.title')] }),
      Text({ size: 'body', wrap: 'wrap', children: [ai.cause] }),
      ...(ai.steps ?? []).map((step, n) => caption(`${n + 1}. ${step}`)),
      caption(t(`ai.confidence.${ai.confidence}`), { dimColor: true }),
      caption(t('ai.credit', { model: ai.model, seconds: ai.seconds }), { dimColor: true }),
      caption(t('ai.sent', { lines: ai.sent?.lines ?? 0 }), { dimColor: true }),
    )
  } else if (ai?.state === 'failed') {
    children.push(caption(t(`ai.error.${ai.reason}`), { color: 'red' }))
  }
  const problem = opts.tone === 'error' || opts.tone === 'warn'
  children.push(Box({ flexDirection: 'row', gap: 1, children: [
    Button({ key: `ai-explain:${port}`, label: t(ai?.state === 'done' ? 'btn.aiAgain' : 'btn.ai'),
      variant: problem && ai?.state !== 'done' ? 'primary' : 'secondary', onPress: () => actions.aiExplain(port) }),
    ...(ai ? [Button({ key: `ai-dismiss:${port}`, label: t('btn.dismiss'), variant: 'secondary', onPress: () => actions.aiDismiss(port) })] : []),
  ] }))
  return Box({ key: `ai:${port}`, flexDirection: 'column', children })
}

function logSection(ui, port, mon, t, actions, opts) {
  const { Box, Text, Button } = ui
  const s = mon?.monitor?.summary ?? {} // a stopped monitor still describes the lines it left
  const all = mon?.lines ?? []
  const shown = filterLines(all, { filter: opts.filter, clearAt: opts.clearAt, limit: opts.more ? LOG_LINES_MORE : LOG_LINES })
  const total = filterLines(all, { filter: opts.filter, clearAt: opts.clearAt, limit: Infinity }).length
  const children = [
    Text({ size: 'caption', weight: 'semibold', children: [t('log.title', { errors: s.errors ?? 0, warnings: s.warnings ?? 0 })] }),
    Box({ flexDirection: 'row', gap: 1, children: FILTERS.map(([id, label]) => Button({ key: `filter-${id}:${port}`, label: t(label),
      variant: opts.filter === id ? 'primary' : 'secondary', onPress: () => actions.setLogFilter(port, id) })) }),
  ]
  if (!shown.length) {
    const hasOutput = all.some(line => line.i >= (opts.clearAt ?? 0))
    const empty = opts.filter === 'problems' && hasOutput ? 'log.noProblems'
      : opts.filter === 'wifi' && hasOutput ? 'log.noWifi'
        : !hasOutput && all.length ? 'log.cleared' : 'log.empty'
    children.push(Text({ size: 'caption', dimColor: true, children: [t(empty)] }))
  }
  for (const line of shown) {
    children.push(Text({ key: `line:${port}:${line.i}`, size: 'caption', mono: true, wrap: 'wrap', ...LINE_STYLE[lineLevel(line.text)], children: [line.text] }))
  }
  if (total > LOG_LINES) {
    children.push(Button({ key: `more:${port}`, label: t(opts.more ? 'btn.less' : 'btn.more'), variant: 'secondary',
      onPress: () => actions.toggleLogMore(port) }))
  }
  return Box({ key: `log:${port}`, flexDirection: 'column', children })
}

function flashSection(ui, port, flash, t, actions, opts) {
  const { Box, Text, Button } = ui
  const caption = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const draft = opts.draft
  const nowS = opts.now / 1000
  if (flash?.state === 'running') {
    return Box({ key: `flash:${port}`, flexDirection: 'column', children: [
      Text({ size: 'caption', weight: 'semibold', children: [t('flash.title')] }),
      Text({ size: 'caption', mono: true, color: 'yellow', wrap: 'wrap',
        children: [t('flash.progress', { bar: progressBar(flash.percent ?? 0), percent: flash.percent ?? 0, file: fileName(flash.file) })] }),
      ...(flash.startedAt ? [caption(t('flash.elapsed', { time: formatDuration(nowS - flash.startedAt, t) }), { dimColor: true })] : []),
      caption(t('flash.dontUnplug'), { color: 'red' }),
    ] })
  }
  const children = []
  if (draft?.confirming) {
    children.push(
      Text({ size: 'caption', weight: 'semibold', color: 'red', children: [t('flash.confirmTitle')] }),
      caption(t('flash.confirmBody', { file: fileName(draft.path), size: formatBytes(draft.bytes), port })),
      caption(draft.path, { mono: true, dimColor: true }),
      caption(t('flash.overwrite'), { color: 'red' }),
      ...(draft.bytes ? [caption(t('flash.estimate', { time: formatDuration(estimateFlashSeconds(draft.bytes), t) }), { dimColor: true })] : []),
      Box({ flexDirection: 'row', gap: 1, children: [
        Button({ key: `flash-confirm:${port}`, label: t('btn.flashConfirm'), variant: 'primary', onPress: () => actions.flashConfirm(port) }),
        Button({ key: `flash-cancel:${port}`, label: t('btn.flashCancel'), variant: 'secondary', onPress: () => actions.flashCancel(port) }),
      ] }),
    )
  } else if (flashResultVisible(flash, opts.dismissed, opts.now)) {
    if (flash.state === 'done') {
      const took = flash.finishedAt && flash.startedAt ? formatDuration(flash.finishedAt - flash.startedAt, t) : '—'
      children.push(caption(`✅ ${t('flash.done', { file: fileName(flash.file), time: took })}`, { color: 'green' }))
    } else {
      children.push(caption(`❌ ${t('flash.failed', { reason: t(`flash.error.${flash.reason}`) })}`, { color: 'red' }))
      const advice = t(`flash.advice.${flash.reason}`)
      if (advice !== `flash.advice.${flash.reason}`) children.push(caption(advice))
    }
    children.push(Button({ key: `flash-dismiss:${port}`, label: t('btn.dismiss'), variant: 'secondary', onPress: () => actions.flashDismiss(port) }))
  }
  if (!draft?.confirming) {
    // Velloc shows no Input in a pane (spike 2), so the file comes from `/esp32 flash <path>`.
    children.push(caption(t('flash.hint', { port }), { dimColor: true }))
    if (draft?.error) {
      children.push(Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
        caption(t(`flash.error.${draft.error}`), { color: 'red' }),
        Button({ key: `flash-error-dismiss:${port}`, label: t('btn.dismiss'), variant: 'secondary', onPress: () => actions.flashCancel(port) }),
      ] }))
    }
  }
  return Box({ key: `flash:${port}`, flexDirection: 'column', children })
}

export function monitorTree(ui, board, mon, t, actions, opts) {
  const { Box, Text, Link } = ui
  const port = board.port
  const monitor = mon?.monitor && mon.monitor.state !== 'stopped' ? mon.monitor : null
  const children = []
  const flashing = mon?.flash?.state === 'running'
  if (monitor?.state === 'running' && monitor.summary) {
    const w = monitor.summary.wifi ?? {}
    // Firmware that never mentions Wi-Fi gets no Wi-Fi row at all.
    if (w.state !== 'unknown' || (w.rssi !== null && w.rssi !== undefined)) children.push(wifiRow(ui, w, t))
    const kind = resetKind(monitor.summary.last_reset)
    if (kind) {
      const text = kind === 'other' ? monitor.summary.last_reset : t(`reset.${kind}`)
      children.push(Text({ size: 'caption', wrap: 'wrap', ...(isBadReset(kind) ? { color: 'yellow' } : { dimColor: true }),
        children: [t('reset.title', { text })] }))
    }
  }
  // While flashing, the flash job owns the port; monitor controls would only confuse.
  const hasOutput = !!monitor || (mon?.lines ?? []).length > 0
  if (hasOutput && !flashing) children.push(aiSection(ui, port, t, actions, opts))
  if (!flashing) children.push(buttons(ui, port, monitor?.state, t, actions))
  if (hasOutput) children.push(logSection(ui, port, mon, t, actions, opts))
  children.push(flashSection(ui, port, mon?.flash, t, actions, opts))
  children.push(opts.linkOpensFolder
    ? Link({ key: `logdir:${port}`, href: `file:///${opts.logDir.replace(/\\/g, '/')}`, label: t('mon.logDir', { dir: opts.logDir }) })
    : Text({ key: `logdir:${port}`, size: 'caption', dimColor: true, wrap: 'wrap', children: [t('mon.logDir', { dir: opts.logDir })] }))
  return Box({ key: `monitor:${port}`, flexDirection: 'column', gap: 1, children })
}
