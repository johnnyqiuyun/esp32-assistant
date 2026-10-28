/**
 * Pure state for the ESP32 pane: merges a `ports --json` scan with the
 * remembered probe records and the in-flight probes. No `$`, no I/O.
 *
 * - A board is remembered by its USB serial number (`VID:PID:SERIAL`), so it
 *   is recognised on any COM port. A device without a serial number is never
 *   remembered: two of them could not be told apart.
 * - A failed probe never touches the record; the board keeps showing what was
 *   last read from it, with the failure on top.
 */

/** `VID:PID:SERIAL`, or null when the device reports no serial number. */
export function recordKey(port) {
  return port.serial ? `${port.vid}:${port.pid}:${port.serial}` : null
}

/**
 * One Board per scanned port, in scan order.
 * `transient`: `{ [port]: { state: 'probing' } | { state: 'failed', reason, detail } | { state: 'checked', info, probedAt } }`.
 */
export function reconcile(scan, records, transient) {
  return scan.map(port => {
    const key = recordKey(port)
    const record = key ? records[key] : undefined
    const live = transient[port.port]
    // 'checked': a device with no serial number, checked in this session only.
    const checked = live?.state === 'checked' ? live : null
    return {
      port: port.port,
      bridge: port.bridge,
      serial: port.serial ?? null,
      key,
      state: checked ? 'known' : live?.state ?? (record ? 'known' : 'unprobed'),
      info: checked?.info ?? record?.info ?? null,
      probedAt: checked?.probedAt ?? record?.probedAt ?? null,
      reason: live?.state === 'failed' ? live.reason : null,
      detail: live?.state === 'failed' ? live.detail ?? null : null,
    }
  })
}

/** Records with a successful probe result stored; anything else returns `records` unchanged. */
export function applyProbe(records, port, result) {
  const key = recordKey(port)
  if (!key || !result?.ok) return records
  return { ...records, [key]: { info: result, probedAt: result.probed_at } }
}

/** Interpreters to try, best first: `$ESP_PYTHON`, python.org installs (3.14 → 3.10), the `py` launcher. */
export function pythonCandidates(env) {
  const out = []
  if (env.ESP_PYTHON) out.push([env.ESP_PYTHON])
  if (env.LOCALAPPDATA) {
    for (let minor = 14; minor >= 10; minor--) out.push([`${env.LOCALAPPDATA}\\Programs\\Python\\Python3${minor}\\python.exe`])
  }
  out.push(['py', '-3'])
  return out
}

/** Port names in `scan` that were not in `prevPortNames`. */
export function newPorts(prevPortNames, scan) {
  const before = new Set(prevPortNames)
  return scan.map(p => p.port).filter(name => !before.has(name))
}
