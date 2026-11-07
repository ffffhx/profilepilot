// Short-lived Medium launcher; detached applies only to Node -> Electron.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { assertDesktopAcceptanceWindow } from './desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from '../verify-desktop-observer-startup.mjs';
import { electronParentEnvironment, verifyArtifacts, verifyProbeDirectory, digest, errorInfo } from './desktop-parent-death-protocol.mjs';

function save(file, value) { const temporary = file + '.' + process.pid + '.tmp'; writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, file); }
async function run() {
  await assertDesktopAcceptanceWindow();
  assert.equal(process.argv.length, 3);
  const configFile = process.argv[2], config = JSON.parse(readFileSync(configFile, 'utf8'));
  await verifyArtifacts(config.artifacts); assert.equal(config.runtime.kind, 'electron');
  const inspect = pid => JSON.parse(execFileSync(config.identityExe, ['--inspect', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 12000 }));
  const identity = inspect(process.pid);
  assertOwnedIdentity(identity, { pid: process.pid, executable: config.nodeExecutable, sha256: config.nodeHash });
  save(config.bootstrapReady, { nonce: config.nonce, identity });
  let child;
  try {
    for (const directory of Object.values(config.runtime.directories)) verifyProbeDirectory(config.home, directory);
    assert.equal(digest(readFileSync(config.parentExecutable)), config.parentHash);
    assert.ok(!(existsSync(config.parentStop) && readFileSync(config.parentStop, 'utf8') === config.nonce), 'Probe was stopped before Electron spawn');
    child = spawn(config.parentExecutable, [config.electronEntry, configFile, '--user-data-dir=' + config.runtime.directories.userData], { cwd: config.root,
      env: electronParentEnvironment(process.env), detached: true, windowsHide: true, stdio: 'ignore' });
    save(config.bootstrapSpawn, { nonce: config.nonce, pid: child.pid, executable: config.parentExecutable, sha256: config.parentHash });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const parentIdentity = inspect(child.pid);
    assertOwnedIdentity(parentIdentity, { pid: child.pid, executable: config.parentExecutable, sha256: config.parentHash });
    assert.equal(parentIdentity.parentPid, identity.pid);
    save(config.bootstrapSpawn, { nonce: config.nonce, identity: parentIdentity });
    child.unref();
    save(config.bootstrapClosed, { nonce: config.nonce, pid: identity.pid, startedUtcTicks: identity.startedUtcTicks, reason: 'launched', exitCode: 0 });
  } catch (error) {
    child?.unref();
    save(config.bootstrapClosed, { nonce: config.nonce, pid: identity.pid, startedUtcTicks: identity.startedUtcTicks,
      reason: 'failed', exitCode: 1, error: errorInfo(error) });
    throw error;
  }
}
run().catch(error => { console.error(JSON.stringify(errorInfo(error))); process.exitCode = 1; });
