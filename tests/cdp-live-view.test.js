const test = require('node:test');
const assert = require('node:assert/strict');
const cdp = require('../dist/main/cdp-client');
const { captureCdpLiveView } = require('../dist/main/cdp-live-view');

function fixture(t, { legacy = false, activeError = false, duplicate = false } = {}) {
  const calls = [], closed = [];
  const pages = ['sleeping', 'active'].map(id => ({ id, type: 'page', title: id,
    url: `https://${duplicate ? 'same' : id}.example/`, webSocketDebuggerUrl: `ws://gateway/${id}` }));
  t.mock.method(cdp, 'requestCdpTargets', async () => pages);
  t.mock.method(cdp, 'requestCdpJson', async () => ({ webSocketDebuggerUrl: 'ws://gateway/browser' }));
  t.mock.method(cdp.CdpBrowserClient, 'connect', async url => ({
    close: () => closed.push(url),
    send: async (method, params) => {
      calls.push({ url, method, params });
      if (method === 'Target.getTargets') {
        if (legacy) throw Error('Unsupported filter');
        return { targetInfos: [
          ...pages.map(p => ({ targetId: p.id, type: 'page', url: p.url })),
          { targetId: 'tab', type: 'tab', url: pages[1].url, embedderData: { tabActive: true } }
        ] };
      }
      assert.equal(method, 'Page.captureScreenshot', 'preview never activates, navigates or emulates page focus');
      if (url.endsWith('/sleeping') || activeError) throw Error('Internal error');
      return { data: 'current-frame' };
    }
  }));
  return { calls, closed };
}

test('automatic preview captures the active page instead of the first restored tab', async t => {
  const f = fixture(t);
  const result = await captureCdpLiveView(9223, { screenshot: true });
  assert.equal(result.screenshot, 'data:image/jpeg;base64,current-frame');
  assert.equal(result.primaryTitle, 'active');
  assert.equal(result.tabs.find(tab => tab.primary).targetId, 'active');
  assert.deepEqual(f.calls.filter(c => c.method === 'Page.captureScreenshot').map(c => c.url), ['ws://gateway/active']);
  assert.equal(f.closed.length, 2, 'both observer connections are released');
});

test('older Chromium recovers from unrendered pages and keeps frame metadata consistent', async t => {
  const f = fixture(t, { legacy: true });
  const result = await captureCdpLiveView(9223, { screenshot: true });
  assert.ok(result.screenshot);
  assert.equal(result.screenshotError, null);
  assert.equal(result.primaryTitle, 'active');
  assert.equal(f.closed.length, 3, 'failed and successful captures both release their observers');
});

test('an explicitly selected unavailable tab never silently shows a different tab', async t => {
  const f = fixture(t);
  const result = await captureCdpLiveView(9223, { screenshot: true, targetId: 'sleeping' });
  assert.equal(result.screenshot, null);
  assert.equal(result.primaryTitle, 'sleeping');
  assert.match(result.screenshotError, /尚未生成画面/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed.length, 1);
});

test('an identified active tab failure is not replaced with another page', async t => {
  const f = fixture(t, { activeError: true });
  const result = await captureCdpLiveView(9223, { screenshot: true });
  assert.equal(result.screenshot, null);
  assert.equal(result.primaryTitle, 'active');
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 1);
});

test('duplicate URLs do not falsely identify a background page as the active tab', async t => {
  fixture(t, { duplicate: true });
  const result = await captureCdpLiveView(9223, { screenshot: true });
  assert.ok(result.screenshot);
  assert.equal(result.primaryTitle, 'active');
});

test('metadata-only observation never captures a screenshot', async t => {
  const f = fixture(t);
  const result = await captureCdpLiveView(9223);
  assert.equal(result.screenshot, null);
  assert.equal(result.primaryTitle, 'active');
  assert.ok(f.calls.every(c => c.method !== 'Page.captureScreenshot'));
});
