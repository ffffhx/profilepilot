import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Compilation never starts hooks. --production selects the distributable path;
// default/--check keep isolated acceptance preparation outside dist/native.
const arguments_ = process.argv.slice(2);
if (arguments_.some(value => !['--check', '--compile-only', '--production'].includes(value))) throw new Error('Use --check, --compile-only or --production. This script never runs hooks.');
if (process.platform !== 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: 'Windows x64 helper; existing macOS guard is unchanged', hookStarted: false }));
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = path.join(root, 'native', 'input-observer-win.cs');
  const production = arguments_.includes('--production');
  const outputDirectory = production ? path.join(root, 'dist', 'native') : path.join(root, '.tools', 'input-observer-build');
  const output = path.join(outputDirectory, production ? 'ProfilePilot.InputObserver.exe' : 'profilepilot-input-observer.exe');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  await mkdir(outputDirectory, { recursive: true });
  const compiler = path.join(framework, 'csc.exe');
  const reference = path.join(framework, 'System.Web.Extensions.dll');
  const options = [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+',
    '/main:ProfilePilot.InputObservation.InputObserverWindowsProgram'
  ];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const sourceSha256 = hash(await readFile(source));
  const buildId = hash(JSON.stringify({ format: 'input-observer-v1-x64', options, sourceSha256,
    compiler: hash(await readFile(compiler)), reference: hash(await readFile(reference)) }));
  const infoPath = production ? output + '.build.json' : path.join(outputDirectory, 'build.json');
  let cached = false, outputSha256;
  try {
    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    outputSha256 = hash(await readFile(output));
    cached = info.buildId === buildId && info.outputSha256 === outputSha256;
  } catch { /* Missing or incomplete metadata requires compilation. */ }
  if (!cached) {
    const temporary = `${output}.${randomUUID()}.tmp.exe`;
    try {
      await promisify(execFile)(compiler, [...options, `/out:${temporary}`, `/r:${reference}`, source],
        { cwd: root, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
      outputSha256 = hash(await readFile(temporary));
      await rename(temporary, output);
    } finally { await rm(temporary, { force: true }); }
  }
  const result = { ok: true, mode: 'compile-only', production, output, sourceSha256, buildId, outputSha256, hookStarted: false };
  const temporaryInfo = `${infoPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryInfo, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    await rename(temporaryInfo, infoPath);
  } finally { await rm(temporaryInfo, { force: true }); }
  console.log(JSON.stringify(result));
}
