import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { nativeRuntimeCopy } from '../native-runtime';
import type { InputBrokerChild } from './input-broker';

export function inputObserverExecutable(): string {
  const packaged = path.join(process.resourcesPath || '', 'native', 'ProfilePilot.InputObserver.exe');
  return existsSync(packaged) ? packaged : path.resolve(__dirname, '../../native/ProfilePilot.InputObserver.exe');
}

// Lazy factory only. Importing this module never installs hooks or starts a
// process. The broker owns the child's protocol, deadlines and confirmed exit.
export function spawnWindowsInputObserver(options: {
  platform?: string; executable?: string; spawnProcess?: typeof spawn;
} = {}): InputBrokerChild {
  if ((options.platform || process.platform) !== 'win32') {
    throw Object.assign(new Error('Windows input observation is unavailable on this platform.'), { code: 'DESKTOP_PLATFORM_UNAVAILABLE' });
  }
  const source = options.executable || inputObserverExecutable();
  if (!existsSync(source)) {
    throw Object.assign(new Error('The Windows input observer component is missing.'), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
  }
  const executable = nativeRuntimeCopy(source, 'profilepilot-input-observer-runtime');
  return (options.spawnProcess || spawn)(executable, ['--stdio-observer'], { windowsHide: true, stdio: 'pipe' }) as InputBrokerChild;
}
