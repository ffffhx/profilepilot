import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { embedGpuiDpiManifest } from './gpui-windows-manifest.mjs';

// Explicit optional build: normal ProfilePilot builds do not install Rust or fetch GPUI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'eb248ccf43847797b9067c47eeef1dd188dc03a6';
const repository = 'https://github.com/themixednuts/gpui-mcp';
const source = path.join(root, '.tools/artifacts/acceptance/gpui-backend-' + revision.slice(0, 12), 'source');
const output = path.join(root, 'dist/native/gpui');
const cargo = process.env.CARGO || path.join(os.homedir(), '.cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
function run(exe, args, cwd = root) {
  const result = spawnSync(exe, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(exe)} failed (${result.status})`);
}
if (!existsSync(source)) {
  mkdirSync(source, { recursive: true }); run('git', ['init', source]);
  run('git', ['remote', 'add', 'origin', repository], source);
  run('git', ['fetch', '--depth', '1', 'origin', revision], source);
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], source);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true });
if (head.status !== 0 || head.stdout.trim() !== revision) throw new Error('GPUI backend source revision mismatch.');
const changes = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: source, encoding: 'utf8', windowsHide: true });
if (changes.status !== 0 || changes.stdout.trim()) throw new Error('GPUI backend source has local changes; preserve them before rebuilding from the pinned revision.');
run(cargo, ['+1.96.0', 'build', '--release', '--locked', '-p', 'gpui-mcp-server', ...(process.argv.includes('--demo') ? ['-p', 'gpui-mcp-demo'] : [])], source);
mkdirSync(output, { recursive: true });
const binary = process.platform === 'win32' ? 'gpui-mcp.exe' : 'gpui-mcp';
copyFileSync(path.join(source, 'target/release', binary), path.join(output, binary));
if (process.platform !== 'win32') chmodSync(path.join(output, binary), 0o755);
embedGpuiDpiManifest(path.join(output, binary), root);
copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-gpui-mcp'));
writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ repository, revision, protocol: 14, platform: process.platform, arch: process.arch, rust: '1.96.0', profile: 'release', dpiManifest: process.platform === 'win32' ? 'PerMonitorV2' : null, sha256: createHash('sha256').update(readFileSync(path.join(output, binary))).digest('hex') }, null, 2) + '\n');
console.log(`Built ${path.join(output, binary)}. Source/build cache remains in ${source}; remove after acceptance when no process uses it.`);
