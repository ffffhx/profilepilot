// Runs in this extension's isolated world. Only an active, tab-scoped control
// lease allows removing foreign extension frames. Never read their documents.
(async () => {
  const key = '__profilepilotFrameGuardV1';
  if (globalThis[key]) { const existing = globalThis[key]; await existing.ready; return existing.refresh ? existing.refresh() : existing.status(); }
  const token = crypto.randomUUID();
  let stopped = false, timer, expiry, pending = false, removed = 0, lastRemovedAt = 0;
  const saved = new Map(), roots = new Set();
  const record = { ready: undefined, stop, refresh: async () => {
    if (await authorize('renew')) visit(document.documentElement);
    return record.status();
  }, status: () => ({ active: !stopped, removed, lastRemovedAt }) };
  globalThis[key] = record;
  const observer = new MutationObserver(changes => {
    if (stopped) return;
    for (const change of changes) {
      if (change.type === 'attributes') visit(change.target);
      else for (const node of change.addedNodes) visit(node);
    }
  });
  function foreignFrame(node) {
    if (node.tagName !== 'IFRAME') return false;
    try {
      const src = (node.getAttribute('src') || '').replace(/^(?:blob:|filesystem:)/, '');
      const url = new URL(src, document.baseURI);
      return url.protocol === 'chrome-extension:' && url.hostname !== chrome.runtime.id;
    } catch { return false; }
  }
  function watch(root) {
    if (!root || roots.has(root) || stopped) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    for (const node of root.children || []) visit(node);
  }
  function visit(node) {
    if (stopped || node.nodeType !== 1 || !node.isConnected) return;
    if (foreignFrame(node)) {
      const marker = document.createComment('ProfilePilot: temporarily suspended extension frame');
      saved.set(marker, node); node.replaceWith(marker); removed++; lastRemovedAt = Date.now();
      return;
    }
    // chrome.dom accepts HTMLElement only; SVG/MathML occur before overlays
    // on real login pages and must not abort the whole document scan.
    watch((node instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot(node) : null) || node.shadowRoot);
    for (const child of [...node.children]) visit(child);
  }
  function stop() {
    if (stopped) return;
    stopped = true; observer.disconnect(); clearInterval(timer); clearTimeout(expiry);
    chrome.runtime.onMessage.removeListener(onMessage);
    globalThis.removeEventListener('pagehide', stop);
    for (const [marker, frame] of saved) {
      // Don't resurrect an overlay that its owner removed, or move a frame
      // that another script already reinserted elsewhere.
      if (marker.isConnected && !frame.isConnected) marker.replaceWith(frame);
      else marker.remove();
    }
    saved.clear(); roots.clear();
    if (globalThis[key] === record) delete globalThis[key];
  }
  function onMessage(message) {
    if (message?.method === 'frameGuard.release' && message.token === token) stop();
  }
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.addEventListener('pagehide', stop);
  async function authorize(action) {
    try {
      const result = await chrome.runtime.sendMessage({ method: 'frameGuard', action, token });
      if (stopped) return false;
      if (!result?.allowed) { stop(); return false; }
      clearTimeout(expiry); expiry = setTimeout(stop, 12000);
      return true;
    } catch { stop(); return false; }
  }
  record.ready = (async () => {
    if (!await authorize('acquire')) return { active: false };
    watch(document);
    // A lost worker/service cannot leave password-manager UI suppressed.
    timer = setInterval(async () => {
      if (pending || stopped) return;
      pending = true;
      try { await authorize('renew'); } finally { pending = false; }
    }, 3000);
    return record.status();
  })();
  return record.ready;
})();
