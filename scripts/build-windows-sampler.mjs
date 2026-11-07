import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default remains isolated compile-only. --production publishes the packaged
// helper; neither mode executes it or downloads dependencies.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const samplerSources = ['model.cs', 'protocol.cs', 'windows.cs', 'watchdog.cs', 'program.cs'];
const compilerOptions = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:ProfilePilot.WindowsSampler.Program'];
export async function buildWindowsSampler({ projectRoot = root, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: true, skipped: true, reason: 'Windows helper is not required on this platform.' };
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  const references = ['System.Management.dll', 'System.Web.Extensions.dll'].map(name => path.join(framework, name));
  const sources = samplerSources.map(name => path.join(projectRoot, 'native/windows-sampler', name));
  const entries = async files => Promise.all(files.map(async file => ({ name: path.basename(file), sha256: hash(await readFile(file)) })));
  const inputs = { version: 1, options: compilerOptions, sources: await entries(sources), compiler: await entries([compiler]), references: await entries(references) };
  const inputHash = hash(JSON.stringify(inputs)), executable = path.join(projectRoot, 'dist/native/ProfilePilot.WindowsSampler.exe');
  const metadataPath = executable + '.build.json';
  let cached = false;
  try { const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); cached = metadata.inputHash === inputHash
    && /^[a-f0-9]{64}$/.test(metadata.sha256) && metadata.sha256 === hash(await readFile(executable)); } catch { /* Rebuild absent/invalid cache. */ }
  if (!cached) {
    await mkdir(path.dirname(executable), { recursive: true });
    const temporary = `${executable}.${process.pid}.${randomUUID()}.tmp.exe`, metadataTemporary = temporary + '.json';
    try {
      execFileSync(compiler, [...compilerOptions, `/out:${temporary}`, ...references.map(file => `/r:${file}`), ...sources],
        { cwd: projectRoot, windowsHide: true, encoding: 'utf8', timeout: 30000 });
      const sha256 = hash(await readFile(temporary));
      await writeFile(metadataTemporary, JSON.stringify({ inputHash, sha256, inputs }, null, 2) + '\n', { flag: 'wx' });
      // Running helpers use content-addressed runtime copies. If Windows refuses
      // replacement, fail without deleting the previous executable.
      await rename(temporary, executable); await rename(metadataTemporary, metadataPath);
    } finally { await rm(temporary, { force: true }); await rm(metadataTemporary, { force: true }); }
  }
  return { ok: true, mode: 'production-compile-only', executable, inputHash, sha256: hash(await readFile(executable)), cached, helperStarted: false };
}
export async function compileWindowsSampler() {
  assert.equal(process.platform, 'win32', 'The prototype compiler requires Windows.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-windows-sampler-prototype-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(directory)); await mkdir(output, { recursive: true });
  const executable = path.join(directory, 'ProfilePilot.WindowsSampler.Prototype.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const sourceFiles = samplerSources.map(name => path.join(root, 'native/windows-sampler', name));
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file).replaceAll('\\', '/'), hash(await readFile(file))])));
  const options = compilerOptions;
  execFileSync(compiler, [...options, `/out:${executable}`, '/r:System.Management.dll', '/r:System.Web.Extensions.dll', ...sourceFiles],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const report = { ok: true, mode: 'compile-only', prototype: true, executable, output, sources,
    sourceHash: hash(JSON.stringify(sources)), compilerSha256: hash(await readFile(compiler)), options,
    sha256: hash(await readFile(executable)), helperStarted: false, guiStarted: false, hooksInstalled: false };
  await writeFile(path.join(output, 'build.json'), JSON.stringify(report, null, 2)); return report;
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    assert.ok(process.argv.length === 2 || process.argv.length === 3 && ['--check', '--production'].includes(process.argv[2]), 'Use --check or --production; this script never starts the helper.');
    console.log(JSON.stringify(await (process.argv[2] === '--production' ? buildWindowsSampler() : compileWindowsSampler())));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
