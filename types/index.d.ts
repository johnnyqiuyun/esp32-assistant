// The pane's view lives in $.state so a redraw reads the latest scan (see hooks/panel.js).
export type View = Record<string, unknown>

declare module 'claude-code' {
  interface PluginState {
    'esp32s3-bringup': { view: View }
  }
}
