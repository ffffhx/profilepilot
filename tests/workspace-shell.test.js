const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isWorkspaceShell, protectWorkspaceShell } = require('../dist/main/workspace-shell');
const { workspaceRoute, workspaceNavigationId } = require('../dist/shared/workspaces');
const { IPC_CHANNELS } = require('../dist/shared/ipc');
const { agentZoomCommand } = require('../dist/shared/workspace-zoom');
const base = pathToFileURL(path.resolve('public/workspace.html')).href;

test('console tabs share a navigation entry and retain their own routes', () => {
  for (const [id, file] of [['browser','index.html'],['local-apps','local-apps.html'],['phones','phones.html']]) {
    assert.equal(workspaceNavigationId(id), 'browser');
    assert.equal(workspaceRoute(file,base).id,id);
  }
  assert.equal(workspaceNavigationId('tools'),'tools');
});

test('Agent zoom recognizes Windows/Linux Ctrl and macOS Command without intercepting text or IME', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const input = { key: '=', control: platform !== 'darwin', meta: platform === 'darwin', alt: false, isComposing: false };
    for (const key of ['=', '+']) assert.equal(agentZoomCommand({ ...input, key }, platform), 'in');
    assert.equal(agentZoomCommand({ ...input, key: '-' }, platform), 'out');
    assert.equal(agentZoomCommand({ ...input, key: '0' }, platform), 'reset');
    assert.equal(agentZoomCommand({ ...input, key: 'Add', code: 'NumpadAdd' }, platform), 'in');
    assert.equal(agentZoomCommand({ ...input, key: 'Subtract', code: 'NumpadSubtract' }, platform), 'out');
    for (const ignored of [{ alt: true }, { isComposing: true }, { control: false, meta: false }, { key: 'k' }]) {
      assert.equal(agentZoomCommand({ ...input, ...ignored }, platform), undefined);
    }
  }
});

test('native zoom accelerators cannot resize the shared desktop and fire only on keyDown', () => {
  const handlers = new Map(), messages = [];
  protectWorkspaceShell({ webContents: {
    on: (name, callback) => handlers.set(name, callback),
    setWindowOpenHandler() {}, send: (...args) => messages.push(args)
  } });
  let blocked = 0;
  const input = { key: '+', control: true, meta: true, alt: false, isComposing: false };
  for (const type of ['keyDown', 'keyUp']) handlers.get('before-input-event')({ preventDefault() { blocked++; } }, { ...input, type });
  assert.equal(blocked, 2);
  assert.deepEqual(messages, [[IPC_CHANNELS.zoomAgentWorkspace, 'in']]);
});

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
