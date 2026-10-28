/**
 * Turning raw board facts into plain-language verdicts for the pane (design: docs/design-ux.md).
 * Pure functions, no `$`, no I/O. Text comes back as locale keys with vars.
 */

import { lineLevel } from './core.js'

const JUST_REBOOTED_S = 15
const FLASH_BYTES_PER_S = 220_000 // measured on COM4: 4 MiB written and verified in ~19 s at 460800 baud
const FLASH_OVERHEAD_S = 5 // connect, stub upload, reset

/** A reset reason from the boot log (e.g. "0xc (RTC_SW_CPU_RST)") as a kind with a plain explanation. */
export function resetKind(lastReset) {
  if (!lastReset) return null
  const name = lastReset.toUpperCase()
  if (name.includes('BROWN_OUT')) return 'brownout'
  if (name.includes('WDT')) return 'watchdog'
  if (name.includes('SLEEP')) return 'deepsleep'
  if (name.includes('USB')) return 'usb'
  if (name.includes('SW_CPU')) return 'crash'
  if (name.includes('SW')) return 'software'
  if (name.includes('POWERON')) return 'poweron'
  return 'other'
}

/** Wi-Fi signal strength in bars (0–4) and a word; a non-negative value is not a real dBm reading. */
export function rssiQuality(rssi) {
  if (rssi === null || rssi === undefined) return null
  if (rssi >= 0) return { bars: 0, key: 'nonstandard' }
  if (rssi >= -55) return { bars: 4, key: 'excellent' }
  if (rssi >= -67) return { bars: 3, key: 'good' }
  if (rssi >= -75) return { bars: 2, key: 'fair' }
  return { bars: 1, key: 'weak' }
}

export function signalBars(bars) {
  return ['▂', '▄', '▆', '█'].map((glyph, n) => (n < bars ? glyph : '·')).join('')
}

export function progressBar(percent, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export function estimateFlashSeconds(bytes) {
  return Math.round(bytes / FLASH_BYTES_PER_S) + FLASH_OVERHEAD_S
}

export function formatDuration(seconds, t) {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return t('dur.s', { s })
  if (s < 3600) return t('dur.ms', { m: Math.floor(s / 60), s: s % 60 })
  return t('dur.hm', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })
}

const BAD_RESETS = ['crash', 'watchdog', 'brownout']
const BOOT_LOOP_BOOTS = 3
const RECENT_LINES = 10
const DONE_RESULT_MAX_AGE_S = 10 * 60

/** Whether a flash job's result card should still be shown. */
export function flashResultVisible(flash, dismissed, nowMs) {
  if (!flash || (flash.state !== 'done' && flash.state !== 'failed')) return false
  if (dismissed != null && dismissed === flash.startedAt) return false
  if (flash.state === 'done' && flash.finishedAt && nowMs / 1000 - flash.finishedAt > DONE_RESULT_MAX_AGE_S) return false
  return true
}

/**
 * The one-line verdict for a board: `{ tone: 'ok'|'warn'|'error'|'idle', key, vars? }`.
 * `monitor` is the live monitor state (null when none runs); `extra` carries `{ flash, dismissed, lines }`.
 * Order follows docs/design-ux.md: what is happening now beats what happened before.
 */
export function health(board, monitor, nowMs, extra = {}) {
  const { flash, dismissed, lines = [] } = extra
  if (flash?.state === 'running') return { tone: 'warn', key: 'health.flashing', vars: { percent: flash.percent ?? 0 } }
  if (flash?.state === 'failed' && flashResultVisible(flash, dismissed, nowMs)) {
    return { tone: 'error', key: 'health.flashFailed', vars: { reason: flash.reason } }
  }
  if (board.state === 'probing') return { tone: 'warn', key: 'health.probing' }
  if (monitor) {
    const s = monitor.summary ?? {}
    if (monitor.state === 'starting') return { tone: 'idle', key: 'health.starting' }
    if (monitor.state === 'busy') return { tone: 'warn', key: 'health.busy' }
    if (monitor.state === 'waiting') return { tone: 'warn', key: 'health.waiting' }
    if (s.status === 'crashed') return { tone: 'error', key: 'health.crashed' }
    if (monitor.state === 'paused') return { tone: 'idle', key: 'health.paused' }
    const recent = lines.slice(-RECENT_LINES).map(l => l.text).join('\n')
    if (/waiting for download/i.test(recent)) return { tone: 'warn', key: 'health.download' }
    if (/invalid header/i.test(recent)) return { tone: 'error', key: 'health.noFirmware' }
    if (s.status === 'unknown') return { tone: 'idle', key: 'health.silent' }
    const kind = resetKind(s.last_reset)
    if ((s.boots ?? 0) >= BOOT_LOOP_BOOTS && BAD_RESETS.includes(kind)) {
      return { tone: 'error', key: 'health.bootLoop', vars: { n: s.boots, kind, raw: s.last_reset } }
    }
    const uptime = s.last_boot_at ? Math.max(0, Math.floor(nowMs / 1000 - s.last_boot_at)) : null
    if (uptime !== null && uptime < JUST_REBOOTED_S && kind && kind !== 'poweron') {
      return { tone: 'warn', key: 'health.rebooted', vars: { kind, raw: s.last_reset } }
    }
    if (uptime === null && monitor.startedAt) {
      // The board booted before monitoring began, so only the watch time is known.
      return { tone: 'ok', key: 'health.watching', vars: { watched: Math.max(0, Math.floor(nowMs / 1000 - monitor.startedAt)) } }
    }
    return { tone: 'ok', key: 'health.running', vars: { seconds: uptime } }
  }
  if (board.state === 'failed') return { tone: 'error', key: 'health.probeFailed', vars: { reason: board.reason } }
  if (board.state === 'unprobed') return { tone: 'idle', key: 'health.unprobed' }
  return { tone: 'ok', key: 'health.idle', vars: { chip: board.info?.chip ?? 'ESP' } }
}

/** A reset kind whose restart is worth a second look (shown in yellow). */
export function isBadReset(kind) {
  return BAD_RESETS.includes(kind)
}

/** Lines to show: after the last Clear, matching the filter, the newest `limit` of them. */
export function filterLines(lines, { filter, clearAt, limit }) {
  const keep = {
    all: () => true,
    problems: line => ['panic', 'error', 'warn'].includes(lineLevel(line.text)),
    wifi: line => lineLevel(line.text) === 'wifi',
  }[filter] ?? (() => true)
  return lines.filter(line => line.i >= (clearAt ?? 0) && keep(line)).slice(-limit)
}

/** The pane's headline: how many things need the person's attention. */
export function overview(boards, healths, missingDriver, python) {
  // Probing or a restart the person just caused are not problems; errors and a held port are.
  const issues = healths.filter(h => h.tone === 'error' || h.key === 'health.busy' || h.key === 'health.download').length
    + (missingDriver ?? []).length + (python && python.state !== 'ok' ? 1 : 0)
  if (issues) return { tone: healths.some(h => h.tone === 'error') || (missingDriver ?? []).length ? 'error' : 'warn',
    key: 'overview.issues', vars: { n: issues } }
  if (!boards.length) return { tone: 'idle', key: 'overview.none' }
  return { tone: 'ok', key: 'overview.ok', vars: { n: boards.length } }
}
