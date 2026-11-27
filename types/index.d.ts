declare module 'claude-code' {
  interface PluginState {
    session: { filter: Shaped<string>; view: Shaped<string>; search: Shaped<string> }
  }
}
