import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../fs-util';
import { NativeControlError } from '../native-control/errors';

export const BROWSER_SERVICE_VERSION = 1;
export interface BrowserServiceConnection {
  version: number; port: number; token: string; pid: number;
  service?: string; serviceVersion?: number;
}
export function browserServiceRoot(): string {
  return path.resolve(process.env.PROFILEPILOT_NATIVE_ROOT || path.join(process.env.CPM_DATA_DIR || defaultDataDir(), 'browser-tasks'));
}
export function readBrowserServiceConnection(root: string): BrowserServiceConnection | undefined {
  const file = path.join(root, 'native-control.json');
  if (!existsSync(file)) return;
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('本地浏览器服务发现文件无效。');
  return value;
}
export function serviceRequest(connection: BrowserServiceConnection, method: string, args: unknown[] = [], timeoutMs = 20000, clientId?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, args, clientId });
    const req = http.request({ hostname: '127.0.0.1', port: connection.port, path: '/native-service', method: 'POST', headers: {
      Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { res.destroy(); reject(new Error('浏览器服务响应过大。')); } else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value.ok) reject(new NativeControlError(value.code || 'NATIVE_BROWSER_ERROR', value.error || '浏览器服务请求失败。'));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('浏览器服务请求超时，请核查状态；不会重放操作。')));
    req.on('error', reject); req.end(body);
  });
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
