#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  const app = await launchProfilePilotE2e({
    enableGlobalShortcuts: true,
    env: { CPM_E2E_MINI_SHORTCUT: "CommandOrControl+Shift+Y" }
  });
  const { driver, dataDir } = app;
  try {
    await createProfile(driver, "Mini E2E Alpha");
    await createProfile(driver, "Mini E2E Beta");
    await createProfile(driver, "Mini E2E Gamma");

    await sendMiniShortcut();
    await waitForWindow(driver, (windows) => windows.mini?.visible && windows.miniPanelOpen);
    let windows = await driver.windows();
    assert.equal(windows.main.visible, false, "global shortcut should hide the main window");
    assert.equal(windows.mini.alwaysOnTop, true);
    assert.ok(windows.mini.bounds.width > 80, "global shortcut should open the Mini panel");
    assert.equal(windows.mini.focused, true, "global shortcut should focus Mini");
    step("global shortcut opened and focused the Mini panel");

    await driver.click('[data-action="show-main-window"]', { target: "mini" });
    await waitForWindow(driver, (state) => state.main?.visible && state.main.focused);
    step("Mini -> main restored and focused the main window");

    await driver.click('[data-action="open-mini-window"]');
    await waitForWindow(driver, (state) => state.mini?.visible && !state.main?.visible && !state.miniPanelOpen);
    const beforeDrag = await driver.windows();
    await driver.drag(".mini-logo-dock", 5, 75, { target: "mini" });
    await delay(350);
    windows = await driver.windows();
    assert.notDeepEqual(windows.mini.bounds, beforeDrag.mini.bounds, "external pointer drag should move Mini");
    const persisted = JSON.parse(await readFile(path.join(dataDir, "mini-window.json"), "utf8"));
    assert.equal(persisted.x, windows.mini.bounds.x);
    assert.equal(persisted.y, windows.mini.bounds.y);
    step("external pointer drag moved Mini and persisted its final position");

    await driver.click('[data-action="toggle-mini-panel"]', { target: "mini" });
    await waitForWindow(driver, (state) => state.miniPanelOpen && state.mini.bounds.width > 80);
    const profileCards = await driver.query(".mini-profile-card", { target: "mini" });
    assert.equal(profileCards.count, 3, "Mini should render the three deterministic fixture Profiles");
    assert.ok((await driver.screenshot("mini")).pngBase64.length > 1_000, "Mini screenshot should contain PNG data");
    step("Mini panel expanded, rendered three Profiles, and produced a screenshot");

    await driver.click('[data-action="show-main-window"]', { target: "mini" });
    await waitForWindow(driver, (state) => state.main?.visible && state.main.focused);
    step("PASS");
  } finally {
    await app.stop();
  }
}

async function createProfile(driver, name) {
  await driver.click('[data-action="new-profile"]');
  await driver.waitFor("#profile-name");
  await driver.fill("#profile-name", name);
  await driver.click('[data-create-form] button[type="submit"]');
  await driver.waitFor("[data-profile-row]", (snapshot) => snapshot.count >= 1 && snapshot.text?.includes(name));
}

async function sendMiniShortcut() {
  if (process.platform !== "darwin") {
    throw new Error("The global-shortcut E2E currently requires macOS System Events.");
  }
  await execFileAsync("osascript", [
    "-e",
    'tell application "System Events" to key code 16 using {command down, shift down}'
  ]);
}

async function waitForWindow(driver, predicate, timeoutMs = 8_000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await driver.windows();
    if (predicate(latest)) return latest;
    await delay(80);
  }
  throw new Error(`Timed out waiting for window state: ${JSON.stringify(latest)}`);
}

function step(message) {
  console.log(`[e2e:mini] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:mini] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
