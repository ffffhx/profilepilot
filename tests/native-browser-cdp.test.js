const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { NativeControlService } = require('../dist/main/native-control/service');
const { parseAllowedBrowserUrl, isPrivilegedBrowserUrl } = require('../dist/main/native-control/browser-cdp');

function createFakeBridge() {
  const listeners = new Set();
  const requests = [];
  const state = {
    profileId: 'native:Default',
    connected: true,
    taskTabs: true,
    ownership: 'user',
    pausedByBrowser: false,
    controlGeneration: 'gen-1',
    extensionVersion: '0.2.20',
    capabilities: ['debugCapture', 'extensionUi', 'liveView', 'tabs', 'cdp', 'cdpSessions', 'frameSessionSnapshot', 'history', 'downloads', 'sidePanel', 'taskGroups', 'cookies', 'dialogs', 'multiSession'],
    sessions: []
  };

  const bridge = {
    states: () => [state],
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async (profileId, method, params = {}) => {
      requests.push({ profileId, method, params });
      if (method === 'claim') {
        state.sessions = state.sessions.filter(s => s.sessionId !== params.sessionId);
        state.sessions.push({
          sessionId: params.sessionId,
          tabId: 42,
          tabs: [42],
          ownership: 'agent',
          pausedByBrowser: false,
          controlGeneration: 'gen-1',
          url: 'about:blank',
          tabTitle: 'Blank'
        });
        state.ownership = 'agent';
        state.ownerSessionId = params.sessionId;
        state.tabId = 42;
        return {};
      }
      if (method === 'control' && ['complete', 'release'].includes(params.action)) {
        state.sessions = state.sessions.filter(s => s.sessionId !== params.sessionId);
        return {};
      }
      if (method === 'open') {
        const entry = state.sessions.find(s => s.sessionId === params.sessionId);
        if (entry) entry.url = params.url;
        return { frameId: 'ext-frame-1' };
      }
      if (method === 'cdp') {
        if (params.method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'ext-frame-1', url: 'https://example.com/', loaderId: 'l1' } } };
        }
        if (params.method === 'Page.createIsolatedWorld') return { executionContextId: 101 };
        if (params.method === 'Runtime.evaluate') {
          return { result: { value: { url: 'https://example.com/', title: 'Example', text: 'Example page', candidates: [], totalCandidates: 0, scrollY: 0, scrollHeight: 800, innerHeight: 800 } } };
        }
        return {};
      }
      return {};
    }
  };
  return { bridge, requests, state };
}

function createFakeBrowserCdp() {
  let connectCount = 0;
  let closed = false;
  let nextTarget = 1;
  const calls = [];
  const targets = new Map();

  const client = {
    onEvent: null,
    onDisconnect: null,
    close: () => { closed = true; },
    send: async (method, params = {}, _timeoutMs = 15000, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') {
        const targetId = `target-${nextTarget++}`;
        targets.set(targetId, { url: params.url, title: '1Password Settings', pageSessionId: `ps-${targetId}` });
        return { targetId };
      }
      if (method === 'Target.attachToTarget') {
        const t = targets.get(params.targetId);
        return { sessionId: t.pageSessionId };
      }
      if (method === 'Target.detachFromTarget') {
        return {};
      }
      const target = [...targets.values()].find(t => t.pageSessionId === sessionId);
      if (method === 'Page.navigate') {
        if (target) target.url = params.url;
        return { frameId: 'f-main' };
      }
      if (method === 'Page.enable' || method === 'Target.setAutoAttach') return {};
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'f-main', url: target?.url || 'chrome-extension://ext/settings.html', loaderId: 'ld-1' } } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 };
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('readyState')) {
          return { result: { value: { readyState: 'complete', url: target?.url, title: target?.title } } };
        }
        if (expr.includes('profilepilot')) {
          return {
            result: {
              value: {
                url: target?.url || 'chrome-extension://ext/settings.html',
                title: target?.title || '1Password Settings',
                text: 'Default vault for saving: 员工(Agent)',
                candidates: [],
                totalCandidates: 0,
                truncated: false,
                scrollY: 0,
                scrollHeight: 600,
                innerHeight: 600
              }
            }
          };
        }
        return { result: { value: { url: target?.url, title: target?.title, ok: true } } };
      }
      return {};
    }
  };

  return {
    calls,
    getConnectCount: () => connectCount,
    isClosed: () => closed,
    options: {
      endpoint: async () => 'ws://127.0.0.1:9222/devtools/browser/fake',
      connect: async () => { connectCount++; return client; }
    }
  };
}

test('parseAllowedBrowserUrl accepts http/https/chrome-extension/chrome and rejects file/credentials', () => {
  assert.equal(parseAllowedBrowserUrl('https://example.com/a').protocol, 'https:');
  assert.equal(parseAllowedBrowserUrl('chrome-extension://gejiddohjgogedgjnonbofjigllpkmbf/app/app.html#/page/settings').protocol, 'chrome-extension:');
  assert.equal(parseAllowedBrowserUrl('chrome://extensions/').protocol, 'chrome:');
  assert.equal(isPrivilegedBrowserUrl('chrome-extension://gejiddohjgogedgjnonbofjigllpkmbf/app/app.html'), true);
  assert.equal(isPrivilegedBrowserUrl('chrome://settings'), true);
  assert.equal(isPrivilegedBrowserUrl('https://example.com'), false);
  assert.throws(() => parseAllowedBrowserUrl('file:///etc/passwd'), /只支持/);
  assert.throws(() => parseAllowedBrowserUrl('https://user:pass@example.com'), /只支持/);
  assert.throws(() => parseAllowedBrowserUrl('javascript:alert(1)'), /只支持/);
});

test('NativeControlService keeps one persistent browser CDP connection across sessions for chrome-extension:// and chrome:// pages', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-browser-cdp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { bridge, requests } = createFakeBridge();
  const fakeCdp = createFakeBrowserCdp();
  const service = new NativeControlService(bridge, root, { browserCdp: fakeCdp.options });
  t.after(() => service.close());

  let reqSeq = 1;
  const req = (method, sessionId, params = {}) => service.request({
    requestId: `r-${reqSeq++}`,
    profileId: 'native:Default',
    sessionId,
    method,
    params
  });

  // Session 1: claim -> open chrome-extension:// -> cdp -> open https:// -> complete
  await req('claim', 's1', { newTab: true });
  const extUrl = 'chrome-extension://gejiddohjgogedgjnonbofjigllpkmbf/app/app.html#/page/settings';
  const opened = await req('open', 's1', { url: extUrl });
  assert.equal(opened.transport, 'browser-cdp');
  assert.equal(opened.url, extUrl);
  assert.equal(fakeCdp.getConnectCount(), 1);
  // Extension transport must NOT receive open for chrome-extension://
  assert.equal(requests.some(r => r.method === 'open' && r.params.url === extUrl), false);

  // Direct cdp command routes through browser CDP while bound to privileged page
  const evalResult = await req('cdp', 's1', { method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } });
  assert.equal(evalResult.result.value.url, extUrl);

  // Status reflects active browserCdpTarget
  const status = await req('status', undefined, {});
  const s1Snap = status.sessions.find(s => s.sessionId === 's1');
  assert.equal(s1Snap.browserCdpTarget.url, extUrl);

  // Navigating back to https:// detaches CDP target and routes back through extension
  await req('open', 's1', { url: 'https://example.com/' });
  assert.equal(requests.some(r => r.method === 'open' && r.params.url === 'https://example.com/'), true);
  assert.equal(fakeCdp.calls.some(c => c.method === 'Target.detachFromTarget'), true);

  // Complete session 1: browser CDP WebSocket stays alive!
  await req('control', 's1', { action: 'complete' });
  assert.equal(fakeCdp.isClosed(), false);

  // Session 2: claim -> newTab chrome://settings reuses the SAME persistent WebSocket (connectCount still 1!)
  await req('claim', 's2', { newTab: true });
  const chromeOpened = await req('newTab', 's2', { url: 'chrome://settings/' });
  assert.equal(chromeOpened.transport, 'browser-cdp');
  assert.equal(chromeOpened.url, 'chrome://settings/');
  assert.equal(fakeCdp.getConnectCount(), 1);

  await req('control', 's2', { action: 'complete' });
  service.close();
  assert.equal(fakeCdp.isClosed(), true);
});

test('NativeControlService surfaces clear error when browser CDP endpoint is unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-browser-cdp-err-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { bridge } = createFakeBridge();
  const service = new NativeControlService(bridge, root, {
    browserCdp: {
      endpoint: async () => { throw new Error('ENOENT'); }
    }
  });
  t.after(() => service.close());

  await service.request({ requestId: 'e-1', profileId: 'native:Default', sessionId: 's-err', method: 'claim', params: { newTab: true } });
  await assert.rejects(
    () => service.request({
      requestId: 'e-2',
      profileId: 'native:Default',
      sessionId: 's-err',
      method: 'open',
      params: { url: 'chrome-extension://gejiddohjgogedgjnonbofjigllpkmbf/app/app.html#/page/settings' }
    }),
    err => err.code === 'NATIVE_EXTENSION_UI_NOT_READY'
  );
  await service.request({ requestId: 'e-3', profileId: 'native:Default', sessionId: 's-err', method: 'control', params: { action: 'complete' } });
});
