import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { DesktopControlNotice } from '../../src/main/desktop/notice';
import type { DesktopStatus } from '../../src/shared/desktop';

export const faultCases = ['missing-js', 'script-throw', 'no-ack', 'missing-preload'] as const;
export const postReadyCases = ['post-ready-throw', 'post-ready-rejection'] as const;
export function postReadyFaultSource(name: string) {
  if (!postReadyCases.includes(name as any)) throw new Error('Unknown post-ready fault');
  const failure = name === 'post-ready-throw' ? "throw new Error('Owned post-ready script failure')" : "void Promise.reject(new Error('Owned post-ready rejection'))";
  return `setTimeout(() => { window.__noticeFixtureFaultFired = true; console.log('notice-fixture:${name}'); ${failure}; }, 0); true`;
}
export function isFixtureEntry(argv: string[], filename: string, electron?: string, type?: string) {
  return !!electron && type === 'browser' && typeof argv[1] === 'string' && path.resolve(argv[1]).toLowerCase() === path.resolve(filename).toLowerCase();
}
export function fixtureState(nonce: string, generation: string, phase: 'arming' | 'ready' | 'idle' | 'paused'): DesktopStatus {
  return { supported: true, available: true, platform: 'win32', stopShortcutAvailable: false,
    inputObservation: { available: true, phase, ...(phase === 'idle' ? {} : { generation, epoch: 'fixture-only' }) },
    session: phase === 'idle' ? null : { name: 'notice-fixture-' + nonce, state: phase === 'ready' ? 'active' : 'paused',
      expiresAt: 9999999999999, window: { id: 'a'.repeat(32), pid: process.pid, process: 'fixture-only', className: 'Fixture',
        title: '隔离提示条测试 · 此处为模拟会话，不控制桌面' } } };
}
export function validateReady(value: unknown) {
  const item = value as any;
  if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'documentNonce,generation' ||
      typeof item.generation !== 'string' || item.generation.length < 1 || item.generation.length > 128 ||
      typeof item.documentNonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.documentNonce)) throw new Error('Invalid readiness envelope');
  return item as { generation: string; documentNonce: string };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function run(args: string[]) {
  const { app, BrowserWindow, ipcMain, screen } = require('electron') as typeof import('electron');
  if (args.length !== 3 || !/^[a-f0-9]{32}$/.test(args[1])) throw new Error('Expected owned directory, nonce and config');
  const home = path.resolve(args[0]), nonce = args[1], configFile = path.resolve(args[2]), base = path.join(home, 'fixture');
  if (path.dirname(configFile) !== home) throw new Error('Config must belong to fixture');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.nonce !== nonce || path.dirname(config.identityExe) !== home || path.dirname(config.preload) !== home) throw new Error('Invalid owned config');
  const started = performance.now(); let identity: any, window: BrowserWindow | undefined, notice: DesktopControlNotice | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, controller: AbortController | undefined, closing = false, caseName = 'normal';
  let state = fixtureState(nonce, 'first', 'arming'), activeFile = '', readyCount = 0;
  const cases: any[] = [], messages: any[] = [], controls: string[] = [], windows: BrowserWindow[] = [];
  const meta = () => ({ nonce, pid: process.pid, startedUtcTicks: identity?.startedUtcTicks,
    realDesktopService: false, realObserver: false, realDriver: false, hooksInstalled: false, inputInjected: false });
  const save = (suffix: string, value: unknown) => fs.writeFileSync(base + suffix, JSON.stringify(value, null, 2));
  const boot = (phase: string) => save('.boot.json', { ...meta(), phase, at: new Date().toISOString() });
  const log = (item: unknown) => { if (messages.length < 64) messages.push(item); };
  const publish = (next: DesktopStatus) => {
    state = next;
    if (window && !window.isDestroyed()) window.webContents.send('desktop:changed', state);
    notice?.update(state);
  };
  const fail = (error: any) => {
    save('.failure.json', { ...meta(), case: caseName, message: String(error?.message || error).slice(0, 1000), code: error?.code, cases, messages, controls });
    close('failure');
  };
  function close(reason: string) {
    if (closing) return; closing = true; clearInterval(timer); controller?.abort(); notice?.close();
    const windowsDestroyed = windows.every(value => value.isDestroyed());
    save('.closed.json', { ...meta(), reason, windowsDestroyed, cases, messages, controls }); app.quit();
  }
  function trusted(event: IpcMainInvokeEvent) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame ||
        path.resolve(fileURLToPath(event.senderFrame!.url)) !== activeFile) throw new Error('Untrusted fixture caller');
  }
  ipcMain.handle('desktop:request', (event, method: string, arg?: any) => {
    trusted(event);
    if (method === 'notice-unavailable') {
      if (!arg || Object.keys(arg).join(',') !== 'documentNonce' || typeof arg.documentNonce !== 'string') throw new Error('Invalid unavailable envelope');
      notice!.documentUnavailable(event.sender, arg.documentNonce); log({ case: caseName, type: method }); return;
    }
    const cancel = method === 'control' && (arg === 'takeover' || arg === 'stop');
    if (!notice?.acceptsToolbar(event.sender, method !== 'status' && method !== 'notice-ready' && !cancel)) throw new Error('Stale fixture toolbar');
    if (method === 'status') return state;
    if (method === 'notice-ready') {
      const value = validateReady(arg); notice.acknowledge(event.sender, value.generation, value.documentNonce);
      log({ case: caseName, type: method, ...value }); return;
    }
    if (cancel) {
      controls.push(arg); controller?.abort(); publish(fixtureState(nonce, state.inputObservation.generation!, arg === 'stop' ? 'idle' : 'paused'));
      return state;
    }
    throw new Error('Fixture does not implement desktop control');
  });
  app.on('window-all-closed', () => {});
  app.setPath('userData', path.join(home, 'user-data'));
  boot('entry-loaded');
  timer = setInterval(() => {
    try {
      if (fs.existsSync(base + '.close') && fs.readFileSync(base + '.close', 'utf8') === nonce) return close('requested');
      if (performance.now() - started > 180000) return close('hard_ttl');
      if (!fs.existsSync(base + '.heartbeat') || fs.readFileSync(base + '.heartbeat', 'utf8') !== nonce || Date.now() - fs.statSync(base + '.heartbeat').mtimeMs > 30000) close('heartbeat_expired');
    } catch (error) { fail(error); }
  }, 100);
  async function destroyed() {
    const deadline = performance.now() + 1500;
    while (window && !window.isDestroyed() && performance.now() < deadline) await delay(25);
    if (window && !window.isDestroyed()) throw new Error('Notice window destruction unconfirmed');
  }
  function createNotice(name: string) {
    caseName = name; activeFile = path.join(home, 'assets', name, 'desktop-control.html');
    notice = new DesktopControlNotice({ file: activeFile, status: () => state,
      onUnavailable() { log({ case: caseName, type: 'on-unavailable' }); publish(fixtureState(nonce, state.inputObservation.generation!, 'paused')); },
      onUserClose() { controls.push('window-close'); controller?.abort(); publish(fixtureState(nonce, state.inputObservation.generation!, 'paused')); },
      diagnostic(error: any) { log({ case: caseName, type: 'diagnostic', code: error?.code, message: String(error?.message || error).slice(0, 240) }); },
      create() {
        const area = screen.getPrimaryDisplay().workArea;
        window = new BrowserWindow({ ...config.viewport, x: area.x + area.width - config.viewport.width - 16, y: area.y + 16,
          show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#ffffff',
          title: 'Isolated notice fixture ' + nonce, webPreferences: { preload: name === 'missing-preload' ? path.join(home, 'absent-preload.cjs') : config.preload,
            contextIsolation: true, sandbox: true, nodeIntegration: false } });
        windows.push(window); window.webContents.on('page-title-updated', event => event.preventDefault());
        window.webContents.on('console-message', event => {
          if (postReadyCases.some(name => event.message === 'notice-fixture:' + name)) log({ case: name, type: 'fault-fired' });
        });
        return window;
      } });
  }
  async function prepare(name: string, generation: string, expectedReady: boolean) {
    if (closing) throw new Error('Fixture closing');
    const before = readyCount, start = performance.now(); controller = new AbortController();
    state = fixtureState(nonce, generation, 'arming');
    let code: string | undefined;
    try { await notice!.prepare(controller.signal); readyCount++; }
    catch (error: any) { code = error.code; }
    if (controls.length) throw new Error('User control interrupted fixture; no automatic recovery');
    const record: any = { case: name, generation, expectedReady, ready: readyCount > before, code,
      elapsedMs: performance.now() - start, messages: messages.filter(item => item.case === caseName),
      visible: !!window && !window.isDestroyed() && window.isVisible(), focused: !!window && !window.isDestroyed() && window.isFocused() };
    cases.push(record); save('.cases.json', { ...meta(), cases, messages });
    if (expectedReady ? !record.ready || code : record.ready || code !== 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE') throw new Error('Unexpected notice outcome for ' + name);
    if (!expectedReady) { await destroyed(); Object.assign(record, { windowDestroyed: true }); }
    return record;
  }
  async function postReadyMatrix() {
    for (const name of postReadyCases) {
      if (closing) return;
      createNotice(name); const record = await prepare(name, name, true);
      publish(fixtureState(nonce, name, 'ready'));
      const contents = window!.webContents, start = performance.now();
      record.faultScheduled = await contents.executeJavaScript(postReadyFaultSource(name)) === true;
      const deadline = performance.now() + 2500;
      while (!closing && !window!.isDestroyed() && performance.now() < deadline) await delay(25);
      const autoDestroyed = window!.isDestroyed();
      record.postFault = { elapsedMs: performance.now() - start, automaticallyDestroyed: autoDestroyed,
        authorityRevoked: !notice!.acceptsToolbar(contents), phase: state.inputObservation.phase,
        unavailableCallback: messages.some(item => item.case === name && item.type === 'on-unavailable'),
        unavailableMessage: messages.some(item => item.case === name && item.type === 'notice-unavailable'),
        faultFired: messages.some(item => item.case === name && item.type === 'fault-fired') };
      if (!autoDestroyed) record.postFault.faultFired = await contents.executeJavaScript('window.__noticeFixtureFaultFired === true');
      record.messages = messages.filter(item => item.case === name);
      // This is cleanup after evidence, not recovery or a successful fault
      // response. Preserve an unreclaimed ready toolbar as a failed case.
      notice!.close(); await destroyed(); record.windowDestroyed = true;
      save('.cases.json', { ...meta(), cases, messages });
    }
    const ok = cases.length === 2 && cases.every(item => item.faultScheduled && item.postFault?.faultFired && item.postFault.automaticallyDestroyed &&
      item.postFault.authorityRevoked && item.postFault.phase === 'paused' && item.postFault.unavailableCallback && item.postFault.unavailableMessage);
    save('.done.json', { ...meta(), ok, suite: 'post-ready', cases, messages, controls, readyCount, windowsDestroyed: windows.every(value => value.isDestroyed()) });
    boot('post-ready-complete-awaiting-parent-close');
  }
  try {
    await app.whenReady(); boot('app-ready');
    identity = JSON.parse(execFileSync(config.identityExe, ['--inspect', String(process.pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    if (!identity.ok || identity.integrityRid !== 8192 || identity.elevated || identity.uiAccess) throw new Error('Fixture must be ordinary Medium');
    if (config.suite === 'post-ready') { await postReadyMatrix(); return; }
    createNotice('normal'); const first = await prepare('normal-first', 'first', true);
    publish(fixtureState(nonce, 'first', 'ready'));
    save('.ready.json', { ...meta(), identity, hwnd: window!.getNativeWindowHandle().readBigUInt64LE().toString(), first, messages }); boot('normal-ready-awaiting-parent');
    while (!closing && (!fs.existsSync(base + '.advance') || fs.readFileSync(base + '.advance', 'utf8') !== nonce)) await delay(50);
    if (closing) return;
    const original = window, firstNonce = messages.find(item => item.type === 'notice-ready')?.documentNonce;
    publish(fixtureState(nonce, 'first', 'idle')); const hiddenBetween = !window!.isVisible();
    publish(fixtureState(nonce, 'second', 'arming')); // Production broadcasts before prepare retags its record.
    const second = await prepare('normal-reuse', 'second', true);
    const secondAck = messages.find(item => item.type === 'notice-ready' && item.generation === 'second');
    Object.assign(second, { sameWindow: window === original, sameDocumentNonce: firstNonce === secondAck?.documentNonce, hiddenBetween });
    if (!second.sameWindow || !second.sameDocumentNonce || !hiddenBetween) throw new Error('Reused document readiness was not independently proven');
    notice!.close(); await destroyed(); Object.assign(second, { windowDestroyed: true });
    for (const name of faultCases) {
      if (closing) return; createNotice(name); await prepare(name, name, false); notice!.close(); await destroyed();
    }
    if (readyCount !== 2) throw new Error('Unexpected ready success count');
    save('.done.json', { ...meta(), ok: true, cases, messages, controls, readyCount, windowsDestroyed: windows.every(value => value.isDestroyed()) });
    boot('complete-awaiting-parent-close');
  } catch (error) { fail(error); }
}

if (isFixtureEntry(process.argv, __filename, process.versions.electron, (process as any).type)) {
  void run(process.argv.slice(2)).catch(error => {
    const args = process.argv.slice(2);
    if (args.length === 3 && /^[a-f0-9]{32}$/.test(args[1])) try { fs.writeFileSync(path.join(path.resolve(args[0]), 'fixture.failure.json'), JSON.stringify({ nonce: args[1], pid: process.pid, message: error.message, phase: 'entry-failed' })); } catch {}
    require('electron').app.exit(1);
  });
}
