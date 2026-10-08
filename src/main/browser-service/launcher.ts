import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startService, type ServiceLaunchInfo } from '../cli/service-launcher';
import { BROWSER_SERVICE_VERSION, browserServiceRoot, processAlive, readBrowserServiceConnection, serviceRequest, type BrowserServiceConnection } from './connection';

export function browserServiceLaunchInfo(projectRoot: string, executable = process.execPath): ServiceLaunchInfo {
  const packaged = projectRoot.includes('.asar');
  return {
    executable: packaged ? executable : path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [...(packaged ? [] : [projectRoot]), '--profilepilot-browser-service'],
    cwd: packaged ? path.dirname(executable) : projectRoot
  };
}
export function saveBrowserServiceLaunch(root: string, info: ServiceLaunchInfo): void {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, 'browser-service-launch.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(info), { mode: 0o600 }); renameSync(temporary, file);
}
function launchInfo(root: string): ServiceLaunchInfo {
  const files = [path.join(root, 'browser-service-launch.json'), path.join(os.homedir(), '.profilepilot', 'cli', 'browser-service-launch.json')];
  for (const file of files) if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  // Development CLI entrypoints need no globally installed launcher.
  for (const project of [path.resolve(__dirname, '../../..'), path.resolve(__dirname, '../..')]) {
    if (existsSync(path.join(project, 'dist/main/entry.js')) && existsSync(path.join(project, 'node_modules/electron'))) return browserServiceLaunchInfo(project);
  }
  throw new Error('找不到浏览器服务启动信息，请更新 ProfilePilot 的终端命令安装。');
}
const starts = new Map<string, Promise<BrowserServiceConnection>>();
export function ensureBrowserService(root = browserServiceRoot()): Promise<BrowserServiceConnection> {
  root = path.resolve(root);
  const existing = starts.get(root); if (existing) return existing;
  const pending = ensure(root);
  starts.set(root, pending);
  void pending.finally(() => { if (starts.get(root) === pending) starts.delete(root); }).catch(() => {});
  return pending;
}
async function ensure(root: string): Promise<BrowserServiceConnection> {
  const probe = async (): Promise<BrowserServiceConnection | undefined> => {
    const connection = readBrowserServiceConnection(root);
    if (!connection || !processAlive(connection.pid)) return;
    if (connection.service !== 'browser') throw new Error('旧版 App 仍持有扩展连接，请退出并重新启动更新后的 ProfilePilot。');
    if (connection.serviceVersion !== BROWSER_SERVICE_VERSION) throw new Error('浏览器服务版本不兼容，请结束浏览器会话后重启服务。');
    const { result } = await serviceRequest(connection, 'ping', [], 1500);
    if (result.service !== 'browser' || result.version !== BROWSER_SERVICE_VERSION || result.pid !== connection.pid || path.resolve(result.root) !== root) throw new Error('浏览器服务身份不匹配。');
    return connection;
  };
  const current = await probe(); if (current) return current;
  const info = launchInfo(root);
  await startService({ ...info, args: [...info.args, '--browser-service-root', root] });
  // The service owns an OS-visible lock. Concurrent CLI processes may launch
  // candidates, but only the lock owner can open the port or mutate the vault.
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const connection = await probe(); if (connection) return connection;
    const errorFile = path.join(root, 'browser-service-error.json');
    if (existsSync(errorFile)) {
      const failure = JSON.parse(readFileSync(errorFile, 'utf8'));
      if (Date.now() - failure.at < 25000) throw new Error(`浏览器服务启动失败：${failure.error}`);
    }
  }
  throw new Error('浏览器服务启动超时，请查看 browser-service.log。');
}
