export type Item = { text: string; notes: string[] }

declare module 'claude-code' {
  interface PluginState {
    'decision-pane': { items: Item[] }
  }
}
