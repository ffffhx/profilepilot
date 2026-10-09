import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";

// Real installer and IPC, but disposable homes and no Windows registry writes.
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: "tools", PROFILEPILOT_TEST_WINDOWS_USER_PATH: "" } });
try {
  const d = app.driver;
  const install = '[data-action="install-profilepilot-cli"]';
  const status = '#tools-cli-card .tools-overview-title em';
  await d.waitFor(install, state => state.exists && !state.disabled);
  assert.equal((await d.query(install)).count, 1);
  assert.equal((await d.query('[data-action="install-profilepilot-cli-skill"]')).count, 0);
  await d.domClick(install);
  await d.waitFor(status, state => state.text === "已就绪", { timeoutMs: 20000 });
  await d.domClick('#management-cli-title');
  assert.equal((await d.query('#tools-cli-card summary, #tools-cli-card .tools-disclosure-body, #tools-gateway-details')).count, 0);
  const skillRoot = path.join(app.homeDir, '.agents/skills/profilepilot');
  const policy = path.join(skillRoot, 'local/browser-routing.md');
  await mkdir(path.dirname(policy), { recursive: true });
  await writeFile(policy, 'Keep this chosen Profile and connection.', 'utf8');
  await writeFile(path.join(skillRoot, 'references/agent-browser.md'), 'Old guide', 'utf8');
  // Refresh via the actual UI, then repair through the same primary button.
  await d.domClick('#tools-connection-diagnostics > summary');
  await d.domClick('[data-action="refresh-agent-integration"]');
  await d.waitFor(status, state => state.text === "需要更新");
  await d.waitFor(install, state => !state.disabled);
  await d.domClick(install);
  await d.waitFor(status, state => state.text === "已就绪", { timeoutMs: 20000 });
  assert.equal(await readFile(policy, 'utf8'), 'Keep this chosen Profile and connection.');
  assert.match(await readFile(path.join(skillRoot, 'references/agent-browser.md'), 'utf8'), /ppilot browser/);
  const artifacts = path.join(repoRoot, 'artifacts/cli-setup-20261005');
  await mkdir(artifacts, { recursive: true });
  await d.domClick('#tools-connection-diagnostics > summary');
  await d.screenshot();
  await new Promise(resolve => setTimeout(resolve, 1200));
  await writeFile(path.join(artifacts, 'unified-setup.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  // Removal remains an installer capability; the compact card has no details or removal action.
  await d.evaluate('window.profileManager.setProfilePilotCliEnabled(false)');
  assert.equal(await readFile(policy, 'utf8'), 'Keep this chosen Profile and connection.');
  await assert.rejects(readFile(path.join(skillRoot, 'SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(app.homeDir, '.profilepilot/cli/profilepilot-cli.cjs')), { code: 'ENOENT' });
  console.log('PASS compact CLI card, install/update, no compatibility section, real IPC removal, personal routing preserved');
} finally { await app.stop(); }
