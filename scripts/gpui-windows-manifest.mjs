import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function embedGpuiDpiManifest(executable, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  if (process.platform !== 'win32') return;
  const sdk = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Windows Kits/10/bin');
  const candidates = process.env.PROFILEPILOT_MT ? [process.env.PROFILEPILOT_MT] : readdirSync(sdk).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(sdk, version, 'x64/mt.exe'));
  const compiler = candidates.find(existsSync);
  if (!compiler) throw new Error('Windows SDK mt.exe is required to embed the GPUI backend DPI manifest.');
  const result = spawnSync(compiler, ['-nologo', '-manifest', path.join(root, 'native/gpui/backend.manifest'), '-outputresource:' + path.resolve(executable) + ';#1'], { windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('GPUI backend DPI manifest embedding failed (' + result.status + ').');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) embedGpuiDpiManifest(process.argv[2]);
