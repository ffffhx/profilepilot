// Controllers request a view update without importing the renderer. The entry
// point owns the subscription; dispatch remains synchronous for focus changes.
let update: (() => void) | undefined;
export function onViewInvalidated(listener: () => void): () => void {
  update = listener;
  return () => { if (update === listener) update = undefined; };
}
export function invalidateView(): void { update?.(); }
