const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native replies enforce UTF-8 budgets and retain uncertain action outcomes', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-protocol-test-'));
  const executable = path.join(directory, 'DesktopProtocolTests.exe');
  const outputs = ['boundary.json', 'jpeg.json'].map(file => path.join(directory, file));
  t.after(() => {
    for (const file of [executable, ...outputs]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const { resolveWindowsWinrtReferences } = await import('../scripts/windows-winrt-contracts.mjs');
  const winrt = await resolveWindowsWinrtReferences(root, { framework });
  const { desktopSourceFiles } = await import('../scripts/desktop-source-files.mjs');
  const sources = desktopSourceFiles.map(file => path.join(root, 'native', 'desktop', file));
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:DesktopProtocolTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => `/r:${path.join(framework, 'WPF', file)}`),
    ...winrt.references.map(file => `/r:${file}`),
    ...sources, path.join(__dirname, 'helpers', 'desktop-protocol-tests.cs')
  ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const report = JSON.parse(execFileSync(executable, [directory], { windowsHide: true, timeout: 10000, encoding: 'utf8' }));
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 17);
  assert.equal(report.metrics.maximumBytes, 3.5 * 1024 * 1024);
  assert.equal(report.metrics.errorMaximumBytes, 16 * 1024);
  assert.equal(report.metrics.newlineBytes, 2);
  for (const file of outputs) {
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length <= report.metrics.maximumBytes);
    const reply = JSON.parse(bytes.toString('utf8'));
    assert.equal(reply.ok, true);
    // Model the management envelope independently in JavaScript. A native
    // boundary-sized result must still leave room for its outer reply metadata.
    const outer = JSON.stringify({ version: 1, id: 'management-request', ok: true, data: reply.result }) + '\n';
    assert.ok(Buffer.byteLength(outer) < 4 * 1024 * 1024);
  }
  t.diagnostic(JSON.stringify(report.metrics));
  t.diagnostic(report.checks.join('; '));
});
