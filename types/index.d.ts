export type Kind = 'page' | 'mermaid' | 'md'
export type Item = { path: string; name: string; kind: Kind; text?: string }

declare module 'claude-code' {
  interface PluginState {
    'artifact-viewer': { items: Item[]; current: string }
  }
}
