import { app, safeStorage, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NativeBrowserBridge, NATIVE_EXTENSION_ID } from '../tasks/native-bridge';
import { NativeExtensionInstaller } from '../tasks/native-installer';
import { openNativeOnboardingTab } from '../tasks/native-onboarding-tab';
import { startNativeExtensionMaintenance } from '../tasks/native-extension-maintenance';
import { nativeChromeUserDataDir } from '../chrome-launch';
import { BrowserServiceHost } from './host';
import { browserServiceRoot } from './connection';
import { acquireBrowserServiceLock } from './lock';

const rootIndex = process.argv.indexOf('--browser-service-root');
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : browserServiceRoot());
mkdirSync(root, { recursive: true });
const log = (error: unknown) => appendFileSync(path.join(root, 'browser-service.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`, { mode: 0o600 });
const releaseLock = acquireBrowserServiceLock(root);
if (!releaseLock) app.exit(0);
else {
  // main.ts uses this exact name. In particular, macOS safeStorage must keep
  // the desktop's Keychain identity to read existing pairing credentials.
  app.name = 'ProfilePilot';
  app.setName('ProfilePilot');
  app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  // No BrowserWindow, tray, global shortcut, model worker or desktop lock.
  app.on('window-all-closed', () => {});
  let bridge: NativeBrowserBridge | undefined, host: BrowserServiceHost | undefined, stopMaintenance: (() => void) | undefined;
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    stopMaintenance?.(); host?.close(); bridge?.close(); releaseLock(); app.quit();
  };
  app.on('before-quit', () => { if (!closing) close(); });
  process.on('SIGTERM', close); process.on('SIGINT', close);
  process.on('exit', releaseLock);
  process.on('uncaughtException', error => { log(error); close(); });
  process.on('unhandledRejection', error => { log(error); close(); });
  void app.whenReady().then(async () => {
    rmSync(path.join(root, 'browser-service-error.json'), { force: true });
    const vault = path.join(root, 'native-browser-credentials.bin');
    const encryption = () => {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，无法读取或保存扩展配对。');
    };
    bridge = new NativeBrowserBridge(root, {
      read: () => { if (!existsSync(vault)) return {}; encryption(); return JSON.parse(safeStorage.decryptString(readFileSync(vault))); },
      write: value => {
        encryption(); const temporary = `${vault}.${process.pid}.tmp`;
        writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 }); renameSync(temporary, vault);
      }
    });
    const packagedExtension = path.join(process.resourcesPath, 'profilepilot-extension');
    const installer = new NativeExtensionInstaller({
      source: existsSync(path.join(packagedExtension, 'manifest.json')) ? packagedExtension : path.resolve(__dirname, '../../../extensions/profilepilot'),
      destination: path.join(root, 'native-extension'), userDataDir: nativeChromeUserDataDir(), extensionId: NATIVE_EXTENSION_ID,
      openSettings: (_id, invitation) => openNativeOnboardingTab(invitation, 'debugging'),
      openExtensions: (_id, invitation) => openNativeOnboardingTab(invitation, 'extensions'),
      revealExtension: async folder => { const error = await shell.openPath(folder); if (error) throw new Error(error); }
    });
    host = new BrowserServiceHost(bridge, root, installer, close);
    await bridge.start();
    stopMaintenance = startNativeExtensionMaintenance(installer, bridge, log);
  }).catch(error => {
    log(error); writeFileSync(path.join(root, 'browser-service-error.json'), JSON.stringify({ at: Date.now(), error: error.message }), { mode: 0o600 }); close();
  });
}
