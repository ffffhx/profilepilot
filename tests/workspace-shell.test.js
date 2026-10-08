const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isWorkspaceShell, protectWorkspaceShell } = require('../dist/main/workspace-shell');
const { workspaceRoute } = require('../dist/shared/workspaces');
const { IPC_CHANNELS } = require('../dist/shared/ipc');
const base = pathToFileURL(path.resolve('public/workspace.html')).href;

test('desktop shell only accepts bundled workspace documents, including encoded Windows/macOS paths', () => {
  for (const root of [base, 'file:///C:/Project%20Files/ProfilePilot/public/workspace.html', 'file:///Applications/ProfilePilot.app/Contents/Resources/app.asar/public/workspace.html']) {
    assert.equal(workspaceRoute('./tasks.html?task=example', root).id, 'agent');
    for (const url of ['https://example.com/tasks.html', '../tasks.html', './workspace.html', './index.html?mode=mini', 'data:text/html,test']) assert.equal(workspaceRoute(url, root), undefined);
  }
  assert.equal(isWorkspaceShell(base + '?workspace=phones'), true);
  assert.equal(isWorkspaceShell(pathToFileURL(path.resolve('artifacts/workspace.html')).href), false);
  assert.equal(isWorkspaceShell('https://example.com/workspace.html'), false);
});

test('native navigation redirects cross-workspace links to the shell and rejects remote/frame escapes', () => {
  const handlers = new Map(), messages = [];
  const window = { webContents: {
    on: (event, callback) => handlers.set(event, callback),
    setWindowOpenHandler: callback => handlers.set('open', callback),
    send: (...args) => messages.push(args)
  } };
  protectWorkspaceShell(window);
  const navigate = (url, current = 'about:blank', isMainFrame = false) => {
    let blocked = false;
    handlers.get('will-frame-navigate')({ url, isMainFrame, frame: { url: current }, preventDefault() { blocked = true; } });
    return blocked;
  };
  const browser = new URL('index.html', base).href, phone = new URL('phones.html', base).href;
  assert.equal(navigate(phone), false, 'initial lazy load is allowed');
  assert.equal(navigate(phone, browser), true, 'existing frame cannot become a different workspace');
  assert.deepEqual(messages, [[IPC_CHANNELS.navigateWorkspace, phone]]);
  assert.equal(navigate('https://example.com/'), true);
  assert.equal(navigate(new URL('../README.md', base).href), true);
  assert.equal(navigate(phone, base, true), true, 'outer document stays mounted');
  assert.deepEqual(handlers.get('open')(), { action: 'deny' });
});
