#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const execFileAsync = promisify(execFile);
const CREATED_NAME = "E2E Lifecycle Profile";
const RENAMED_NAME = "E2E Renamed Profile";

async function main() {
  const app = await launchProfilePilotE2e();
  const { driver, dataDir, homeDir } = app;
  try {
    await driver.click('[data-action="new-profile"]');
    await driver.waitFor("#profile-name");
    await driver.fill("#profile-name", CREATED_NAME);
    await driver.waitFor("#profile-name", (snapshot) => snapshot.value === CREATED_NAME);
    await driver.click('[data-create-form] button[type="submit"]');

    const row = await driver.waitFor("[data-profile-row]", (snapshot) => snapshot.text?.includes(CREATED_NAME));
    const profileId = row.attributes["data-id"];
    assert.match(profileId, /^isolated:/, "the UI should create a real isolated Profile");

    const registry = JSON.parse(await readFile(path.join(dataDir, "profiles.json"), "utf8"));
    const stored = registry.profiles.find((profile) => `isolated:${profile.id}` === profileId);
    assert.ok(stored, "created Profile should be persisted in profiles.json");
    const profilePath = path.join(dataDir, "profiles", stored.dirName);
    await access(profilePath);
    step(`created ${profileId} at ${profilePath}`);

    await openProfileMenu(driver, profileId);
    await driver.click(`[data-action="rename-profile"][data-id="${profileId}"]`);
    await driver.waitFor("#profile-rename");
    await driver.fill("#profile-rename", RENAMED_NAME);
    await driver.waitFor("#profile-rename", (snapshot) => snapshot.value === RENAMED_NAME);
    await driver.click('[data-rename-form] button[type="submit"]');
    await driver.waitFor(`[data-profile-row][data-id="${profileId}"]`, (snapshot) => snapshot.text?.includes(RENAMED_NAME));
    step("renamed through external mouse and keyboard input");

    await openProfileMenu(driver, profileId);
    await driver.click(`[data-action="launch"][data-id="${profileId}"]`);
    await driver.waitFor(`[data-action="focus-profile"][data-id="${profileId}"]`, (snapshot) => snapshot.exists, {
      timeoutMs: 15_000
    });
    const launchedCommands = await processCommandsContaining(profilePath);
    assert.ok(launchedCommands.some((command) => command.includes(`--user-data-dir=${profilePath}`)));
    step("launched a real Chrome process with the isolated user-data-dir");

    await ensureMainVisible(driver);
    await openProfileMenu(driver, profileId);
    await driver.click(`[data-action="close-profile"][data-id="${profileId}"]`);
    await driver.waitFor('[data-action="confirm-modal-action"]');
    await driver.click('[data-action="confirm-modal-action"]');
    await driver.waitFor(`[data-action="launch-cdp"][data-id="${profileId}"]`, (snapshot) => snapshot.exists, {
      timeoutMs: 20_000
    });
    assert.equal((await processCommandsContaining(profilePath)).length, 0, "Chrome should stop after UI close confirmation");
    step("closed the real Chrome Profile through the confirmation dialog");

    await openProfileMenu(driver, profileId);
    await driver.click(`[data-action="delete"][data-id="${profileId}"]`);
    await driver.waitFor('[data-action="confirm-modal-action"]');
    await driver.click('[data-action="confirm-modal-action"]');
    await driver.waitFor(`[data-profile-row][data-id="${profileId}"]`, (snapshot) => !snapshot.exists, {
      timeoutMs: 10_000
    });
    const finalRegistry = JSON.parse(await readFile(path.join(dataDir, "profiles.json"), "utf8"));
    assert.equal(finalRegistry.profiles.some((profile) => `isolated:${profile.id}` === profileId), false);
    const trashEntries = await readdir(path.join(homeDir, ".Trash"));
    assert.ok(trashEntries.some((entry) => entry.startsWith(`${stored.dirName}-`)), "deleted Profile should move to trash");
    step("deleted the Profile and verified registry + trash state");

    step("PASS");
  } finally {
    await app.stop();
  }
}

async function openProfileMenu(driver, profileId) {
  await ensureMainVisible(driver);
  const menuAction = `[data-action="toggle-profile-menu"][data-id="${profileId}"]`;
  const snapshot = await driver.query(menuAction);
  if (snapshot.attributes["aria-expanded"] !== "true") {
    await driver.click(menuAction);
    await delay(80);
    if ((await driver.query(menuAction)).attributes["aria-expanded"] !== "true") {
      await driver.focus(menuAction);
      await driver.press("Enter");
    }
  }
  await driver.waitFor(menuAction, (current) => current.attributes["aria-expanded"] === "true");
  await driver.waitFor(".action-menu", (current) => current.exists);
}

async function ensureMainVisible(driver) {
  let windows = await driver.windows();
  if (windows.main?.visible) return;
  if (!windows.mini?.visible) throw new Error(`Neither main nor mini window is visible: ${JSON.stringify(windows)}`);

  const dock = await driver.query('[data-action="toggle-mini-panel"]', { target: "mini" });
  if (dock.exists) {
    await driver.click('[data-action="toggle-mini-panel"]', { target: "mini" });
    await driver.waitFor('[data-action="show-main-window"]', (snapshot) => snapshot.exists, { target: "mini" });
  }
  await driver.click('[data-action="show-main-window"]', { target: "mini" });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    windows = await driver.windows();
    if (windows.main?.visible) return;
    await delay(60);
  }
  throw new Error(`Main window did not become visible: ${JSON.stringify(windows)}`);
}

async function processCommandsContaining(value) {
  const { stdout } = await execFileAsync("ps", ["axww", "-o", "command="]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(value));
}

function step(message) {
  console.log(`[e2e:desktop-ui] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:desktop-ui] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
