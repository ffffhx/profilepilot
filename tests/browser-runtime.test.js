const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundledBrowserExecutable, browserBinaryName } = require('../dist/main/tasks/browser-runtime');
const { resolveRealAgentBrowser } = require('../dist/main/agent-browser-wrapper');

test('product browser runs from its pinned package with no global CLI or Node on PATH', () => {
  const binary = bundledBrowserExecutable({ resourcesPath: '' });
  assert.ok(binary.includes(path.join('node_modules', 'agent-browser', 'bin')));
  assert.equal(resolveRealAgentBrowser({ PATH: '', PROFILEPILOT_AGENT_BROWSER_REAL: binary }), binary);
  const version = execFileSync(binary, ['--version'], { env: { ...process.env, PATH: '', Path: '' }, encoding: 'utf8', windowsHide: true });
  assert.match(version, /0\.34\.0/);
});

test('packaged Windows and both macOS architectures resolve a physical bundled executable', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const expected = path.join('resources', 'browser-runtime', browserBinaryName(platform, arch));
    assert.equal(bundledBrowserExecutable({ resourcesPath: 'resources', platform, arch, exists: file => file === expected }), expected);
  }
  assert.throws(() => bundledBrowserExecutable({ resourcesPath: 'resources', exists: file => file.endsWith('app.asar') }), /安装包缺少/);
});
