// Runs in the worker AND in the popup, which must work without the worker.
// Separate event keys avoid lost updates between those independent contexts.
(() => {
  const prefix = 'profilepilotConnectionEvent:', limit = 200, maxAge = 7 * 86400000;
  const source = typeof document === 'undefined' ? 'worker' : 'popup';
  const instance = crypto.randomUUID();
  let queue = Promise.resolve(), storageAvailable = true, writeFailed = false;
  const memory = [];
  const events = new Set(['worker-start', 'worker-ready', 'initialization-failed', 'runtime-error', 'unhandled-rejection',
    'browser-startup', 'extension-installed', 'connect-attempt', 'socket-open', 'authenticated', 'socket-error',
    'socket-close', 'connect-pending', 'heartbeat-checkpoint', 'disconnect-requested', 'reload-requested',
    'popup-unreachable', 'popup-recovered']);
  const errorInfo = error => {
    const text = String(error?.message || error || '');
    const name = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'DOMException'].includes(error?.name) ? error.name : 'Error';
    const kind = /Receiving end does not exist/i.test(text) ? 'receiver-missing' : /diagnostic state timeout/i.test(text) ? 'response-timeout'
      : /message port closed|message channel closed/i.test(text) ? 'channel-closed' : /quota/i.test(text) ? 'storage-quota'
      : /Cannot read properties of (undefined|null)/.test(text) ? 'invalid-property-access' : 'unclassified';
    // Only our source locations, never arbitrary exception messages or stacks.
    const frame = String(error?.stack || '').match(/(?:background(?:-entry)?|connection-diagnostics|popup)\.js:(\d+):(\d+)/);
    return { errorName: name, errorKind: kind, ...(frame ? { script: frame[0].split(':')[0], line: +frame[1], column: +frame[2] } : {}) };
  };
  function clean(value) {
    if (!value || !events.has(value.event) || !/^[a-f0-9-]{36}$/i.test(value.id || '') || !/^[a-f0-9-]{36}$/i.test(value.instance || '') ||
        !['worker', 'popup'].includes(value.source) || !Number.isFinite(Date.parse(value.at))) return;
    const row = { id: value.id, at: new Date(value.at).toISOString(), instance: value.instance, source: value.source, event: value.event };
    for (const key of ['port', 'closeCode', 'line', 'column', 'elapsedMs']) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 2147483647) row[key] = value[key];
    for (const key of ['paired', 'authenticated', 'wasClean']) if (typeof value[key] === 'boolean') row[key] = value[key];
    for (const key of ['step', 'errorName', 'errorKind', 'extensionVersion']) if (typeof value[key] === 'string' && /^[a-zA-Z0-9_.-]{1,60}$/.test(value[key])) row[key] = value[key];
    if (['background.js', 'background-entry.js', 'connection-diagnostics.js', 'popup.js'].includes(value.script)) row.script = value.script;
    return row;
  }
  async function read() {
    try {
      const all = await chrome.storage.local.get(null);
      storageAvailable = true;
      return Object.entries(all).filter(([key]) => key.startsWith(prefix)).map(([, value]) => clean(value)).filter(Boolean);
    } catch { storageAvailable = false; return [...memory]; }
  }
  function record(event, details = {}) {
    const row = clean({ ...details, id: crypto.randomUUID(), instance, source, event, at: new Date().toISOString() });
    if (!row) return Promise.resolve();
    memory.push(row); if (memory.length > limit) memory.shift();
    queue = queue.then(async () => {
      try {
        await chrome.storage.local.set({ [prefix + row.id]: row });
        const rows = (await read()).sort((a, b) => a.at.localeCompare(b.at));
        const remove = rows.filter((item, i) => i < rows.length - limit || Date.now() - Date.parse(item.at) > maxAge).map(item => prefix + item.id);
        if (remove.length) await chrome.storage.local.remove(remove);
        writeFailed = false;
      } catch { storageAvailable = false; writeFailed = true; }
    }).catch(() => { storageAvailable = false; writeFailed = true; });
    return queue;
  }
  async function report() {
    await queue;
    const stored = await read();
    const rows = [...new Map([...stored, ...memory].map(row => [row.id, row])).values()]
      .filter(row => Date.now() - Date.parse(row.at) <= maxAge).sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
    return { version: 1, exportedAt: new Date().toISOString(), storageAvailable: storageAvailable && !writeFailed, events: rows,
      limits: { maxEvents: limit, maxAgeDays: 7 },
      limitation: 'No event proves why Chrome terminated or failed to load a worker before JavaScript ran. Export chrome://extensions errors too.' };
  }
  globalThis.ProfilePilotConnectionDiagnostics = { record, report, errorInfo };
  if (source === 'worker') {
    void record('worker-start', { extensionVersion: chrome.runtime.getManifest().version });
    globalThis.addEventListener('error', event => { void record('runtime-error', { ...errorInfo(event.error),
      ...(Number.isInteger(event.lineno) ? { line: event.lineno, column: event.colno } : {}) }); });
    globalThis.addEventListener('unhandledrejection', event => { void record('unhandled-rejection', errorInfo(event.reason)); });
  }
})();
