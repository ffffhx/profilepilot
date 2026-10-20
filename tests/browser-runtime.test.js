const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundledBrowserExecutable, browserBinaryName } = require('../dist/main/tasks/browser-runtime');
const { resolveRealAgentBrowser } = require('../dist/main/agent-browser-wrapper');

test('product browser runs the TypeScript engine using its host runtime with an empty PATH', () => {
  const binary = bundledBrowserExecutable({ resourcesPath: '' });
  assert.ok(binary.endsWith(path.join('browser-runtime', 'profilepilot-browser-engine.cjs')));
  assert.equal(resolveRealAgentBrowser({ PATH: '', PROFILEPILOT_AGENT_BROWSER_REAL: binary }), binary);
  const version = execFileSync(process.execPath, [binary, '--version'], { env: { ...process.env, PATH: '', Path: '', ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  assert.match(version, /ProfilePilot TypeScript browser engine/);
  assert.equal(require('../package.json').dependencies['agent-browser'], undefined);
});

test('packaged Windows and both macOS architectures resolve the same physical TypeScript engine', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const expected = path.join('resources', 'browser-runtime', browserBinaryName(platform, arch));
    assert.equal(bundledBrowserExecutable({ resourcesPath: 'resources', platform, arch, exists: file => file === expected }), expected);
  }
  assert.throws(() => bundledBrowserExecutable({ resourcesPath: 'resources', exists: file => file.endsWith('app.asar') }), /安装包缺少/);
});
