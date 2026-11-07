const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const stages = ['active', 'paused', 'error', 'recovered', 'new-owner', 'idle'];
function isElectronFixtureEntry(argv, filename, electronVersion, processType) {
  return Boolean(electronVersion) && processType === 'browser' && typeof argv[1] === 'string'
    && path.resolve(argv[1]).toLowerCase() === path.resolve(filename).toLowerCase();
}
function makeState(phase, { nonce, reason, message, generation = 'g1', owner = 'a' }) {
  return { supported: true, available: true, platform: 'win32', stopShortcutAvailable: false,
    inputObservation: { available: true, phase, ...(phase === 'idle' ? {} : { generation, epoch: 'fixture-epoch' }),
      ...(phase === 'paused' ? { reason, message, certainty: 'unknown' } : {}) },
    session: phase === 'idle' ? null : { name: 'layout-' + owner + '-' + nonce, state: phase === 'ready' ? 'active' : 'paused',
      expiresAt: 9999999999999, window: { id: 'a'.repeat(32), pid: 1, process: 'stub-only', className: 'Fixture', title: '独立布局夹具 · 展示状态不代表实际 App 暂停' } } };
}
function layoutIssues(measured, stage) {
  const issues = [], viewport = measured.viewport;
  const expectedLabel = stage === 'idle' ? '已结束' : ['paused', 'error'].includes(stage) ? '已暂停' : '正在控制';
  if (measured.nodes['control-state']?.text !== expectedLabel) issues.push('stale_state_label');
  for (const id of ['actions', 'stop', ...(stage === 'active' || stage === 'recovered' || stage === 'new-owner' ? ['takeover'] : stage === 'idle' ? [] : ['return'])]) {
    const item = measured.nodes[id];
    if (!item?.visible || item.rect.left < 0 || item.rect.top < 0 || item.rect.right > viewport.width + .1 || item.rect.bottom > viewport.height + .1) issues.push(id + '_outside_viewport');
    if (id !== 'actions' && item?.visible && !item.centerHits) issues.push(id + '_center_occluded');
  }
  if (measured.documentHeight > viewport.height + .1) issues.push('document_overflows_viewport');
  if (stage === 'error') {
    if (!measured.nodes['control-error'].visible || measured.nodes['control-error'].rect.height < 47.9 || measured.nodes['control-error'].rect.height > 48.1) issues.push('max_error_not_exercised');
  } else if (measured.nodes['control-error'].visible || measured.nodes['control-error'].text) issues.push('stale_error');
  if (['paused', 'error'].includes(stage) && !measured.nodes['control-reason'].visible) issues.push('pause_reason_missing');
  if (['active', 'recovered', 'new-owner', 'idle'].includes(stage) && (measured.nodes['control-reason'].visible || measured.nodes['control-reason'].text)) issues.push('stale_pause_reason');
  return issues;
}

async function run(args, boot = () => {}) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  if (args.length !== 3 || !/^[a-f0-9]{32}$/.test(args[1])) throw new Error('Expected owned home, nonce and message model');
  const home = path.resolve(args[0]), nonce = args[1], modelPath = path.resolve(args[2]);
  if (path.dirname(modelPath) !== home) throw new Error('Message model must belong to fixture directory');
  const base = path.join(home, 'fixture'), model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  if (model.nonce !== nonce || typeof model.reason !== 'string' || typeof model.message !== 'string' || typeof model.error !== 'string'
    || !Number.isInteger(model.viewport?.width) || !Number.isInteger(model.viewport?.height)) throw new Error('Invalid message model');
  app.setPath('userData', path.join(home, 'electron-data')); app.setName('ProfilePilot toolbar layout fixture');
  const save = (suffix, value) => { const file = base + suffix, temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value, null, 2)); fs.renameSync(temporary, file); };
  const meta = () => ({ nonce, pid: process.pid, role: 'isolated-toolbar-layout', realDesktopService: false, hooksInstalled: false, inputInjected: false });
  let window, timer, state = makeState('ready', { nonce, ...model }), sequence = 0, failControl = false, closing = false, processing = false;
  const acknowledgements = new Map(), processed = new Set(), stubCalls = [], started = performance.now();
  const own = (event, token) => { if (token !== nonce || event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted fixture caller'); };
  ipcMain.handle('toolbar-fixture:status', (event, token) => { own(event, token); return state; });
  ipcMain.handle('toolbar-fixture:control', (event, token, action) => {
    own(event, token); if (!['takeover', 'return', 'stop'].includes(action)) throw new Error('Invalid fixture action');
    stubCalls.push({ action, stubOnly: true }); if (failControl) throw new Error(model.error); return state;
  });
  ipcMain.on('toolbar-fixture:applied', (event, token, id) => { own(event, token); acknowledgements.get(id)?.(); });
  const evaluate = source => Promise.race([window.webContents.executeJavaScript(source), new Promise((_, reject) => {
    const deadline = setTimeout(() => reject(new Error('Fixture renderer did not respond')), 8000); deadline.unref();
  })]);
  async function push(next) {
    state = next; const id = ++sequence;
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { acknowledgements.delete(id); reject(new Error('Fixture state ACK missing')); }, 8000);
      acknowledgements.set(id, () => { clearTimeout(deadline); acknowledgements.delete(id); resolve(); });
      window.webContents.send('toolbar-fixture:state', { nonce, sequence: id, state });
    });
  }
  async function injectStubError() {
    failControl = true;
    try { await evaluate("document.getElementById('return').onclick()"); } finally { failControl = false; }
  }
  async function stage(name, requestId) {
    if (!stages.includes(name)) throw new Error('Unknown layout stage');
    const shared = { nonce, ...model };
    if (name === 'active') await push(makeState('ready', shared));
    if (name === 'paused' || name === 'error') await push(makeState('paused', shared));
    if (name === 'error') await injectStubError();
    if (name === 'recovered') await push(makeState('ready', { ...shared, generation: 'g2' }));
    if (name === 'new-owner' || name === 'idle') {
      await push(makeState('paused', { ...shared, generation: 'g2' })); await injectStubError();
      await push(makeState(name === 'idle' ? 'idle' : 'ready', { ...shared, owner: 'b', generation: 'g3' }));
    }
    const measured = await evaluate(`(async () => {
      await document.fonts.ready;
      const ids = ['control-state', 'control-task', 'control-reason', 'control-error', 'takeover', 'return', 'stop'];
      const nodes = {};
      for (const id of [...ids, 'actions']) {
        const node = id === 'actions' ? document.querySelector('.desktop-notice-actions') : document.getElementById(id);
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        nodes[id] = { text: node.textContent, visible: !node.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          centerHits: hit === node || node.contains(hit), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      }
      return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, documentHeight: document.documentElement.scrollHeight, nodes };
    })()`);
    const result = { ...meta(), requestId, stage: name, state, measured, issues: layoutIssues(measured, name), stubCalls: [...stubCalls],
      window: { visible: window.isVisible(), focused: window.isFocused(), bounds: window.getBounds(), contentBounds: window.getContentBounds() } };
    save('.stage.json', result); return result;
  }
  function close(reason) {
    if (closing) return; closing = true; clearInterval(timer);
    save('.closed.json', { ...meta(), reason }); if (window && !window.isDestroyed()) window.destroy(); app.quit();
  }
  try {
    await app.whenReady();
    boot('app-ready');
    window = new BrowserWindow({ ...model.viewport, show: false, frame: false, resizable: false, skipTaskbar: true,
      title: 'ProfilePilot toolbar layout ' + nonce, backgroundColor: '#ffffff',
      webPreferences: { preload: path.join(__dirname, 'desktop-toolbar-layout-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
        additionalArguments: ['--toolbar-fixture-nonce=' + nonce] } });
    boot('window-created');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('page-title-updated', event => event.preventDefault());
    window.on('close', () => close('window_closed'));
    const firstPaint = new Promise((resolve, reject) => { window.once('ready-to-show', resolve); const deadline = setTimeout(() => reject(new Error('Initial paint missing')), 10000); deadline.unref(); });
    await window.loadFile(path.resolve(__dirname, '../../public/desktop-control.html')); boot('document-loaded');
    await firstPaint; boot('first-paint'); window.showInactive();
    const initial = await stage('active', 'initial');
    const native = window.getNativeWindowHandle();
    save('.ready.json', { ...meta(), hwnd: native.readBigUInt64LE().toString(), initial });
    boot('fixture-ready');
    timer = setInterval(() => {
      try {
        if (fs.existsSync(base + '.close') && fs.readFileSync(base + '.close', 'utf8') === nonce) return close('requested');
        if (performance.now() - started > 300000) return close('hard_ttl');
        if (!fs.existsSync(base + '.heartbeat') || Date.now() - fs.statSync(base + '.heartbeat').mtimeMs > 30000) return close('heartbeat_expired');
        if (processing || !fs.existsSync(base + '.request.json')) return;
        const request = JSON.parse(fs.readFileSync(base + '.request.json', 'utf8'));
        if (request.nonce !== nonce || !/^[a-f0-9]{32}$/.test(request.id || '') || processed.has(request.id)) return;
        processed.add(request.id); processing = true;
        stage(request.stage, request.id).catch(error => save('.stage.json', { ...meta(), requestId: request.id, stage: request.stage, error: error.message }))
          .finally(() => { processing = false; });
      } catch (error) { if (!(error instanceof SyntaxError)) { save('.failure.json', { ...meta(), error: error.message }); close('failure'); } }
    }, 100);
  } catch (error) { save('.failure.json', { ...meta(), error: error.message }); close('startup_failure'); }
}

module.exports = { stages, makeState, layoutIssues, isElectronFixtureEntry };
// Electron 42 default_app imports this CJS application via ESM import(), so
// require.main need not be this module. A Node import for pure tests must still
// remain inert: require an actual Electron browser process and this entry path.
if (isElectronFixtureEntry(process.argv, __filename, process.versions.electron, process.type)) {
  const args = process.argv.slice(2);
  let fileBase;
  const diagnostic = (suffix, value) => {
    if (!fileBase) return;
    try { fs.writeFileSync(fileBase + suffix, JSON.stringify({ nonce: args[1], pid: process.pid, ...value }, null, 2)); }
    catch (error) { console.error('Fixture diagnostic write failed:', error.message); }
  };
  const boot = phase => diagnostic('.boot.json', { phase, at: new Date().toISOString(), electron: process.versions.electron,
    processType: process.type, defaultApp: process.defaultApp === true, requireMainMatched: require.main === module });
  try {
    if (args.length !== 3 || !/^[a-f0-9]{32}$/.test(args[1]) || path.dirname(path.resolve(args[2])) !== path.resolve(args[0])) throw new Error('Invalid owned fixture launch arguments');
    fileBase = path.join(path.resolve(args[0]), 'fixture'); boot('entry-loaded');
    void run(args, boot).catch(error => {
      diagnostic('.failure.json', { role: 'isolated-toolbar-layout', phase: 'uncaught-startup', error: error.message });
      console.error(error); require('electron').app.exit(1);
    });
  } catch (error) {
    diagnostic('.failure.json', { role: 'isolated-toolbar-layout', phase: 'entry-failed', error: error.message });
    console.error(error); require('electron').app.exit(1);
  }
}
