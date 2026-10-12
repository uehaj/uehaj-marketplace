export type Mark = 'open' | 'held' | 'done'
// `at`: the time in the line's `(保留 ...)` or `(承認 ...)`, absent on an open line.
export type Item = { text: string; notes: string[]; mark: Mark; at?: string }

declare module 'claude-code' {
  interface PluginState {
    'decision-pane': { items: Item[]; isHeldOpen: boolean; isDoneOpen: boolean }
  }
}
