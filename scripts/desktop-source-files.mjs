// Keep production compilation and native integration tests on the same driver.
export const desktopSourceFiles = Object.freeze([
  'host.cs', 'windows.cs', 'diagnostics.cs', 'input-state.cs',
  'input-delivery.cs', 'pointer-coordinates.cs', 'capture-wgc.cs', 'window-state.cs', 'shell-invocation.cs'
]);
