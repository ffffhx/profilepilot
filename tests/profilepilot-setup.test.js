const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTsModule } = require('./helpers/load-ts-module.js');
const { profilePilotSetupState } = loadTsModule('src/shared/profilepilot-setup.ts');

function diagnostic() {
  const skill = { key: 'profilepilot', installed: true, managed: true, upToDate: true, installedTargetCount: 3,
    targets: [{ installed: true, managed: true, upToDate: true }] };
  return { managementCli: { installed: true, upToDate: true, bundleInstalled: true, launcherInstalled: true, skill },
    skills: [skill], shellIntegration: { installed: true } };
}

test('unified readiness requires both components and the terminal connection', () => {
  assert.equal(profilePilotSetupState(null).status, '未安装');
  assert.equal(profilePilotSetupState(diagnostic()).ready, true);
  for (const update of [d => d.managementCli.installed = false, d => d.managementCli.upToDate = false,
    d => d.skills[0].installed = false, d => d.skills[0].upToDate = false, d => d.shellIntegration.installed = false]) {
    const d = diagnostic(); update(d);
    assert.equal(profilePilotSetupState(d).ready, false);
    assert.equal(profilePilotSetupState(d).hasParts, true);
  }
});

test('external guide mismatches remain visible even alongside current managed instructions', () => {
  const d = diagnostic();
  d.skills[0].upToDate = false;
  d.skills[0].targets.push({ installed: true, managed: false, upToDate: false });
  assert.equal(profilePilotSetupState(d).status, '指引需检查');
  d.skills[0].targets[1].upToDate = true;
  d.skills[0].upToDate = true;
  assert.equal(profilePilotSetupState(d).ready, true);
});
