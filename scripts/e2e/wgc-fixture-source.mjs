// Pure owned-fixture evidence. Matching current marker positions proves only
// this known DOM revision, never generic image freshness or input coordinates.
export function evaluateWgcMarkerEvidence(decoded, page, content, capture) {
  if (!Array.isArray(page?.markers) || page.markers.length !== 3 || !Array.isArray(decoded?.markers) || decoded.markers.length !== 3
    || ![decoded.width, decoded.height, page.dpr, capture?.width, capture?.height].every(value => Number.isFinite(value) && value > 0)
    || ![content?.x, content?.y, capture?.x, capture?.y].every(Number.isFinite)
    || page.markers.some(marker => !marker || ![marker.x, marker.y].every(Number.isFinite))) {
    return { expectedRevision: page?.contentRevision, matches: false, classification: 'invalid_marker_evidence', measurements: [] };
  }
  const measurements = page.markers.map((css, index) => {
    const marker = decoded.markers[index];
    const present = Boolean(marker && marker.count >= 300);
    const measured = present ? { x: capture.x + marker.x * capture.width / decoded.width,
      y: capture.y + marker.y * capture.height / decoded.height } : null;
    const expected = { x: content.x + css.x * page.dpr, y: content.y + css.y * page.dpr };
    const error = measured ? { x: measured.x - expected.x, y: measured.y - expected.y } : null;
    return { marker: css.id, count: marker?.count ?? 0, measured, expected, error,
      matches: Boolean(error && Math.abs(error.x) <= 3 && Math.abs(error.y) <= 3), coordinateAuthority: false };
  });
  return { expectedRevision: page.contentRevision, matches: measurements.every(marker => marker.matches),
    classification: measurements.some(marker => marker.count < 300) ? 'markers_missing'
      : measurements.every(marker => marker.matches) ? 'current_markers_match' : 'markers_mismatch', measurements };
}

// Shared owned Electron marker surface; importing this module does not launch it.
export const fixtureSource = String.raw`
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', process.argv[2]);
let window, cover, last, configuration, startupEvidence, lastPageCapture, layerLease, exposure, queue = Promise.resolve();
let lastCommand, lastRequestAt = Date.now();
const commandFile = path.join(process.argv[3], 'command.json');
const responseFile = path.join(process.argv[3], 'response.json');
const heartbeatFile = path.join(process.argv[3], 'heartbeat');
function emit(value) { fs.writeFileSync(responseFile + '.tmp', JSON.stringify(value)); fs.renameSync(responseFile + '.tmp', responseFile); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, timeout = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' deadline')), timeout); })]); }
  finally { clearTimeout(timer); }
}
const html = '<!doctype html><meta charset="utf-8"><title>ProfilePilot WGC owned fixture</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(243,240,220)}.marker{position:absolute;width:48px;height:48px}#green{left:40px;top:55px;background:rgb(33,160,80)}#blue{left:290px;top:140px;background:rgb(34,119,187)}#red{left:540px;top:280px;background:rgb(215,50,70)}</style><div class="marker" id="green"></div><div class="marker" id="blue"></div><div class="marker" id="red"></div><output id="revision" style="position:absolute;left:20px;bottom:12px;color:#222">revision 0</output><script>window.fixtureRevision=0;window.fixtureAnimationFrames=0;window.fixtureTimers=0;function frame(){window.fixtureAnimationFrames++;requestAnimationFrame(frame)}requestAnimationFrame(frame);setInterval(()=>window.fixtureTimers++,100);</script>';
function handle(w) { const value = w.getNativeWindowHandle(); return value.length === 8 ? value.readBigUInt64LE().toString() : String(value.readUInt32LE()); }
function pageState() {
  const frame = document.getElementById('fixture-frame');
  const doc = frame ? frame.contentDocument : document;
  const view = doc.defaultView;
  const offset = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
  return { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, visibilityState: document.visibilityState,
    contentVisibilityState: doc.visibilityState, readyState: doc.readyState, contentRevision: view.fixtureRevision,
    mutationAt: view.fixtureMutationAt || null, animationFrames: view.fixtureAnimationFrames, timers: view.fixtureTimers,
    markers: ['green', 'blue', 'red'].map(id => { const r = doc.getElementById(id).getBoundingClientRect(); return { id, x: offset.x + r.x + r.width / 2, y: offset.y + r.y + r.height / 2, width: r.width, height: r.height }; }) };
}
function mutatePage() {
  const frame = document.getElementById('fixture-frame');
  const doc = frame ? frame.contentDocument : document;
  const revision = ++doc.defaultView.fixtureRevision;
  const positions = [[40 + revision * 40, 55 + revision * 12], [290 - revision * 15, 140 + revision * 25], [540 - revision * 25, 280 - revision * 30]];
  ['green', 'blue', 'red'].forEach((id, index) => { const element = doc.getElementById(id); element.style.left = positions[index][0] + 'px'; element.style.top = positions[index][1] + 'px'; });
  doc.getElementById('revision').textContent = 'revision ' + revision;
  doc.defaultView.fixtureMutationAt = Date.now();
  return revision;
}
async function createCover(bounds) {
  if (cover) cover.close();
  cover = new BrowserWindow({ ...bounds, show: false, frame: false, alwaysOnTop: true, focusable: false, backgroundColor: '#202020',
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await bounded(cover.loadURL('data:text/html,<body style="margin:0;background:%23202020;color:white">Owned capture occluder</body>'), 'owned cover load');
  cover.showInactive();
}
function restoreOwnedTargetLayer() {
  const lease = layerLease; layerLease = undefined;
  if (!lease) return;
  if (!lease.window.isDestroyed()) {
    lease.window.setAlwaysOnTop(lease.alwaysOnTop);
    if (!lease.visible) lease.window.hide();
    exposure = { ...exposure, restoredAt: Date.now(), restoredAlwaysOnTop: lease.window.isAlwaysOnTop(), restoredVisible: lease.window.isVisible() };
  }
}
function revealOwnedTarget() {
  if (!window || window.isDestroyed() || layerLease) throw new Error('Owned target exposure is unavailable or already active');
  if (cover) { cover.close(); cover = undefined; }
  layerLease = { window, alwaysOnTop: window.isAlwaysOnTop(), visible: window.isVisible() };
  exposure = { requestedAt: Date.now(), originalAlwaysOnTop: layerLease.alwaysOnTop, originalVisible: layerLease.visible,
    mechanism: 'owned target setAlwaysOnTop(true) then showInactive', physicalVisibility: 'not_independently_sampled',
    note: 'Only removing the owned cover does not prove visibility above other applications. This temporary topmost request is evaluated separately using DOM scheduling and captured markers.' };
  try {
    window.setAlwaysOnTop(true); window.showInactive();
    exposure.requestedAlwaysOnTop = window.isAlwaysOnTop(); exposure.requestedVisible = window.isVisible(); exposure.focused = window.isFocused();
    if (!exposure.requestedAlwaysOnTop || !exposure.requestedVisible || exposure.focused) throw new Error('Owned exposure must be topmost and visible without focus');
  } catch (error) { restoreOwnedTargetLayer(); throw error; }
}
async function create(frame, mode = 'unthrottled', iframe = false, startupOccluded = false) {
  restoreOwnedTargetLayer(); exposure = undefined;
  if (cover) { cover.close(); cover = undefined; }
  if (window) window.close();
  configuration = { backgroundThrottlingOption: mode === 'default' ? 'omitted' : false, iframe, frame, startupOccluded,
    showAtConstruction: startupOccluded, focusableOption: startupOccluded ? false : 'omitted' };
  lastPageCapture = undefined;
  startupEvidence = startupOccluded ? { events: [], focusableDifference: 'Target is non-focusable to avoid activating it; the production App normally permits focus.',
    targetCreatedAfterVisibleCover: false, loadStartedWhileCovered: false } : undefined;
  const evidence = startupEvidence;
  const recordStartup = (event, detail = {}) => { if (evidence) evidence.events.push({ order: evidence.events.length + 1, event, at: Date.now(), ...detail }); };
  let startupBounds;
  if (startupOccluded) {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(820, area.width - 80), height = Math.min(570, area.height - 80);
    if (width < 650 || height < 440) throw new Error('Working area is too small for the owned startup marker fixture');
    startupBounds = { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
    await createCover({ x: startupBounds.x - 24, y: startupBounds.y - 24, width: width + 48, height: height + 48 });
    await delay(220);
    recordStartup('cover-visible-before-target', { bounds: cover.getBounds(), visible: cover.isVisible(), alwaysOnTop: cover.isAlwaysOnTop() });
    if (!cover.isVisible() || !cover.isAlwaysOnTop()) throw new Error('Owned startup cover was not visible before target creation');
    startupEvidence.targetCreatedAfterVisibleCover = true;
  }
  window = new BrowserWindow({ title: 'ProfilePilot WGC owned fixture', width: 800, height: 500, useContentSize: !startupOccluded,
    ...(startupOccluded ? { ...startupBounds, focusable: false } : {}), frame, show: startupOccluded, backgroundColor: '#f3f0dc',
    ...(iframe ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#eeeeee', symbolColor: '#333333', height: 58 } } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, ...(mode === 'default' ? {} : { backgroundThrottling: false }) } });
  if (startupOccluded) {
    recordStartup('target-created-visible', { hwnd: handle(window), bounds: window.getBounds(), visible: window.isVisible(), focused: window.isFocused() });
    if (!window.isVisible() || window.isFocused()) throw new Error('Startup target must be visible without receiving focus');
    window.once('ready-to-show', () => recordStartup('ready-to-show-observed'));
    window.webContents.once('did-finish-load', () => recordStartup('did-finish-load-observed'));
  }
  const document = iframe ? '<!doctype html><meta charset="utf-8"><title>ProfilePilot WGC owned fixture</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}header{position:absolute;inset:0 0 auto;height:58px;background:#eee}iframe{position:absolute;left:0;top:58px;width:100%;height:calc(100% - 58px);border:0}</style><header>Owned iframe freshness fixture</header><iframe id="fixture-frame" srcdoc="' + html.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></iframe>' : html;
  if (startupOccluded) {
    const bounds = window.getBounds(), obstruction = cover.getBounds();
    startupEvidence.loadStartedWhileCovered = cover.isVisible() && cover.isAlwaysOnTop()
      && obstruction.x <= bounds.x && obstruction.y <= bounds.y && obstruction.x + obstruction.width >= bounds.x + bounds.width && obstruction.y + obstruction.height >= bounds.y + bounds.height;
    if (!startupEvidence.loadStartedWhileCovered) throw new Error('Owned cover does not contain the startup target bounds');
    recordStartup('target-load-started-under-cover', { bounds, coverBounds: obstruction });
  }
  await bounded(window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document)), 'fixture load');
  recordStartup('target-load-completed');
  if (!startupOccluded) window.showInactive();
  await delay(220);
}
async function state() {
  if (!window || window.isDestroyed()) return { ...last, closed: true };
  const page = await bounded(window.webContents.executeJavaScript('(' + pageState.toString() + ')()'), 'fixture DOM state');
  const display = screen.getDisplayMatching(window.getBounds());
  const contentBounds = window.getContentBounds();
  const webContentsPhysicalBounds = screen.dipToScreenRect(window, contentBounds);
  return last = { hwnd: handle(window), pid: process.pid, bounds: window.getBounds(), contentBounds, webContentsPhysicalBounds, minimized: window.isMinimized(), visible: window.isVisible(), maximized: window.isMaximized(), covered: Boolean(cover),
    configuration: { ...configuration, effectiveBackgroundThrottling: window.webContents.backgroundThrottling }, startupEvidence, pageCapture: lastPageCapture, exposure,
    alwaysOnTop: window.isAlwaysOnTop(), focused: window.isFocused(),
    occluder: cover ? { hwnd: handle(cover), bounds: cover.getBounds(), visible: cover.isVisible(), alwaysOnTop: cover.isAlwaysOnTop() } : null,
    display: { id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea }, page };
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const initialMode = process.argv[4];
  if (initialMode !== undefined && initialMode !== 'startup-occluded') throw new Error('Unknown initial fixture mode');
  if (initialMode === 'startup-occluded') await create(true, 'default', false, true);
  else await create(true);
  emit({ id: 'ready', state: await state() });
  setInterval(() => {
    let heartbeat = lastRequestAt;
    try { heartbeat = Math.max(heartbeat, fs.statSync(heartbeatFile).mtimeMs); } catch (error) { if (error.code !== 'ENOENT') { app.quit(); return; } }
    if (Date.now() - heartbeat > 90000) { app.quit(); return; }
    let request;
    try { request = JSON.parse(fs.readFileSync(commandFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) { process.stderr.write(error.stack); app.quit(); } return; }
    if (request.id === lastCommand) return;
    lastCommand = request.id; lastRequestAt = Date.now();
    queue = queue.then(async () => {
    switch (request.action) {
      case 'normal': break;
      case 'menu-less': window.removeMenu(); break;
      case 'resize': window.setContentSize(720, 460); break;
      case 'move': { const work = screen.getDisplayMatching(window.getBounds()).workArea; window.setPosition(work.x + 90, work.y + 70); break; }
      case 'maximize': window.maximize(); break;
      case 'restore': window.restore(); window.showInactive(); break;
      case 'cover': await createCover(window.getBounds()); break;
      case 'uncover': if (cover) cover.close(); cover = undefined; break;
      case 'expose-topmost': revealOwnedTarget(); break;
      case 'restore-layer': restoreOwnedTargetLayer(); break;
      case 'frameless': await create(false); break;
      case 'default-throttle': await create(true, 'default'); break;
      case 'default-throttle-iframe': await create(true, 'default', true); break;
      case 'startup-occluded': await create(true, 'default', false, true); break;
      case 'startup-occluded-iframe': await create(true, 'default', true, true); break;
      case 'mutate': await bounded(window.webContents.executeJavaScript('(' + mutatePage.toString() + ')()'), 'fixture DOM mutation'); break;
      case 'capture-page': {
        const before = await state();
        const startedAt = Date.now();
        const file = path.join(process.argv[3], 'capture-page-' + String(request.id).replace(/[^a-zA-Z0-9_-]/g, '') + '.jpg');
        try {
          const captured = await bounded(window.capturePage(undefined, { stayHidden: true, stayAwake: true }), 'owned capturePage');
          if (captured.isEmpty()) throw new Error('owned capturePage returned an empty image');
          const bytes = captured.toJPEG(90); fs.writeFileSync(file, bytes, { flag: 'wx' });
          lastPageCapture = { ok: true, path: file, ...captured.getSize(), bytes: bytes.length, startedAt, finishedAt: Date.now(),
            contentRevision: before.page.contentRevision, stayHidden: true, stayAwake: true, visibleBefore: before.visible, minimizedBefore: before.minimized, coveredBefore: before.covered };
        } catch (error) { lastPageCapture = { ok: false, error: error.message, startedAt, finishedAt: Date.now(), contentRevision: before.page.contentRevision }; }
        break;
      }
      case 'minimize': window.minimize(); break;
      case 'hide': window.hide(); break;
      case 'show': window.showInactive(); break;
      case 'protect': window.setContentProtection(true); break;
      case 'unprotect': window.setContentProtection(false); break;
      case 'close': window.close(); window = undefined; break;
      case 'quit': restoreOwnedTargetLayer(); app.quit(); return;
      default: throw new Error('Unknown fixture command');
    }
    await delay(200);
    emit({ id: request.id, state: await state() });
  }).catch(error => { emit({ id: request.id, error: error.message }); process.exitCode = 1; app.quit(); });
  }, 25);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
`;
