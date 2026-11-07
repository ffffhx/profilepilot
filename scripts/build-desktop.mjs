import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopSourceFiles } from './desktop-source-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Desktop control: Windows helper is not required on this platform.');
} else {
  const { resolveWindowsWinrtReferences } = await import('./windows-winrt-contracts.mjs');
  const sdk = await resolveWindowsWinrtReferences(root);
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const sources = desktopSourceFiles.map(name => path.join(root, 'native', 'desktop', name));
  const compiler = path.join(framework, 'csc.exe');
  const references = [
    ...['System.Web.Extensions.dll', 'System.Drawing.dll'].map(name => path.join(framework, name)),
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => path.join(framework, 'WPF', name)),
    ...sdk.references
  ];
  const options = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+'];
  const destination = path.join(root, 'dist', 'native', 'ProfilePilot.Desktop.exe');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const writeAtomic = (file, value) => {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, value, { flag: 'wx' }); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  };
  const inputs = files => files.map(file => ({ name: path.basename(file), sha256: hash(readFileSync(file)) }));
  const buildId = hash(JSON.stringify({
    format: 'desktop-v2-x64-wgc', options,
    sdk: { version: sdk.version, packageSha256: sdk.packageSha256 },
    compiler: inputs([compiler]), sources: inputs(sources), references: inputs(references)
  }));
  const outputDigestPath = destination + '.output.sha256';
  let cached = false;
  if (existsSync(destination) && existsSync(destination + '.sha256') && existsSync(outputDigestPath)) {
    const outputDigest = readFileSync(outputDigestPath, 'utf8');
    cached = readFileSync(destination + '.sha256', 'utf8') === buildId
      && /^[a-f0-9]{64}$/.test(outputDigest) && hash(readFileSync(destination)) === outputDigest;
  }
  if (!cached) {
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp.exe`;
    try {
      execFileSync(compiler, [...options, `/out:${temporary}`, ...references.map(file => `/r:${file}`), ...sources], { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 30000 });
      const outputDigest = hash(readFileSync(temporary));
      renameSync(temporary, destination);
      // A missing legacy digest or any interrupted publication causes a rebuild.
      // The input identity alone cannot establish that the existing EXE is intact.
      writeAtomic(outputDigestPath, outputDigest);
      writeAtomic(destination + '.sha256', buildId);
    } finally { rmSync(temporary, { force: true }); }
  }
  console.log(`Desktop control: Windows helper ready (SDK contracts ${sdk.version}).`);
}
