#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function main() {
  const app = await launchProfilePilotE2e();
  const { driver, dataDir } = app;
  try {
    await createProfile(driver, "E2E Sync Target");
    await createProfile(driver, "E2E Sync Source");

    const registry = JSON.parse(await readFile(path.join(dataDir, "profiles.json"), "utf8"));
    const sourceStored = registry.profiles.find((profile) => profile.name === "E2E Sync Source");
    const targetStored = registry.profiles.find((profile) => profile.name === "E2E Sync Target");
    assert.ok(sourceStored && targetStored);
    const sourceRoot = path.join(dataDir, "profiles", sourceStored.dirName);
    const targetRoot = path.join(dataDir, "profiles", targetStored.dirName);
    const sourceProfile = path.join(sourceRoot, "Default");
    const targetProfile = path.join(targetRoot, "Default");
    await seedSyncFixtures(sourceRoot, sourceProfile, targetRoot, targetProfile);

    const sourceId = `isolated:${sourceStored.id}`;
    const targetId = `isolated:${targetStored.id}`;
    await openPicker(driver, "source");
    await driver.waitFor(`[data-action="select-account-sync-profile"][data-kind="source"][data-id="${sourceId}"]`);
    await driver.click(`[data-action="select-account-sync-profile"][data-kind="source"][data-id="${sourceId}"]`);
    await openPicker(driver, "target");
    await driver.waitFor(`[data-action="select-account-sync-profile"][data-kind="target"][data-id="${targetId}"]`);
    await driver.click(`[data-action="select-account-sync-profile"][data-kind="target"][data-id="${targetId}"]`);

    const sourcePicker = await driver.query('[data-account-sync-select="source"] .profile-select-trigger');
    const targetPicker = await driver.query('[data-account-sync-select="target"] .profile-select-trigger');
    assert.match(sourcePicker.text, /E2E Sync Source/);
    assert.match(targetPicker.text, /E2E Sync Target/);

    const includeData = await driver.query("[data-include-extension-data]");
    if (!includeData.checked) await driver.click("[data-include-extension-data]");
    const launchTarget = await driver.query("[data-launch-synced-profile]");
    if (launchTarget.checked) await driver.click("[data-launch-synced-profile]");

    await driver.click('[data-action="run-sync"]');
    await driver.waitFor('[data-action="confirm-modal-action"]');
    await driver.click('[data-action="confirm-modal-action"]');

    await waitForFileContent(path.join(targetProfile, "Bookmarks"), "SOURCE_BOOKMARKS");
    await waitForFileContent(path.join(targetProfile, "Network", "Cookies"), "SOURCE_COOKIE_BYTES");
    await waitForFileContent(path.join(targetProfile, "Local Storage", "leveldb", "fixture.log"), "SOURCE_LOCAL_STORAGE");
    await waitForFileContent(
      path.join(targetProfile, "Local Extension Settings", EXTENSION_ID, "fixture.log"),
      "SOURCE_EXTENSION_DATA"
    );

    await driver.waitFor('[data-action="run-sync"]', (snapshot) => snapshot.exists && !snapshot.disabled, {
      timeoutMs: 15_000
    });
    await waitForMigratedExtension(path.join(dataDir, "profiles.json"), targetStored.id);
    step("account files and extension data were copied through the combined UI sync flow");
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
  await driver.waitFor("[data-profile-row]", (snapshot) => snapshot.text?.includes(name));
}

async function openPicker(driver, kind) {
  const selector = `[data-account-sync-select="${kind}"] .profile-select-trigger`;
  await driver.click(selector);
  await delay(80);
  if ((await driver.query(selector)).attributes["aria-expanded"] !== "true") {
    await driver.focus(selector);
    await driver.press("Enter");
  }
  await driver.waitFor(selector, (snapshot) => snapshot.attributes["aria-expanded"] === "true");
}

async function seedSyncFixtures(sourceRoot, sourceProfile, targetRoot, targetProfile) {
  const extensionDir = path.join(sourceProfile, "Extensions", EXTENSION_ID, "1.0.0");
  await Promise.all([
    mkdir(path.join(sourceProfile, "Network"), { recursive: true }),
    mkdir(path.join(sourceProfile, "Local Storage", "leveldb"), { recursive: true }),
    mkdir(path.join(sourceProfile, "Local Extension Settings", EXTENSION_ID), { recursive: true }),
    mkdir(extensionDir, { recursive: true }),
    mkdir(path.join(targetProfile, "Network"), { recursive: true }),
    mkdir(path.join(targetProfile, "Local Storage", "leveldb"), { recursive: true }),
    mkdir(path.join(targetProfile, "Local Extension Settings", EXTENSION_ID), { recursive: true })
  ]);

  const preferences = {
    extensions: {
      settings: {
        [EXTENSION_ID]: {
          state: 1,
          location: 4,
          path: path.relative(sourceProfile, extensionDir),
          manifest: { manifest_version: 3, name: "ProfilePilot E2E Extension", version: "1.0.0" }
        }
      }
    }
  };
  const sourceLocalState = {
    profile: {
      info_cache: { Default: { name: "E2E Source", user_name: "source@example.test", gaia_name: "E2E Source" } },
      last_used: "Default",
      last_active_profiles: ["Default"],
      profiles_order: ["Default"]
    }
  };
  const targetLocalState = {
    profile: {
      info_cache: { Default: { name: "E2E Target", user_name: "target@example.test" } },
      last_used: "Default",
      last_active_profiles: ["Default"],
      profiles_order: ["Default"]
    }
  };

  await Promise.all([
    writeFile(path.join(sourceProfile, "Bookmarks"), "SOURCE_BOOKMARKS", "utf8"),
    writeFile(path.join(sourceProfile, "Network", "Cookies"), "SOURCE_COOKIE_BYTES", "utf8"),
    writeFile(path.join(sourceProfile, "Local Storage", "leveldb", "fixture.log"), "SOURCE_LOCAL_STORAGE", "utf8"),
    writeFile(path.join(sourceProfile, "Local Extension Settings", EXTENSION_ID, "fixture.log"), "SOURCE_EXTENSION_DATA", "utf8"),
    writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "ProfilePilot E2E Extension", version: "1.0.0" }), "utf8"),
    writeFile(path.join(sourceProfile, "Preferences"), JSON.stringify(preferences), "utf8"),
    writeFile(path.join(sourceProfile, "Secure Preferences"), "{}", "utf8"),
    writeFile(path.join(sourceRoot, "Local State"), JSON.stringify(sourceLocalState), "utf8"),
    writeFile(path.join(targetProfile, "Bookmarks"), "TARGET_OLD_BOOKMARKS", "utf8"),
    writeFile(path.join(targetProfile, "Network", "Cookies"), "TARGET_OLD_COOKIES", "utf8"),
    writeFile(path.join(targetProfile, "Local Storage", "leveldb", "fixture.log"), "TARGET_OLD_STORAGE", "utf8"),
    writeFile(path.join(targetProfile, "Local Extension Settings", EXTENSION_ID, "fixture.log"), "TARGET_OLD_EXTENSION_DATA", "utf8"),
    writeFile(path.join(targetProfile, "Preferences"), "{}", "utf8"),
    writeFile(path.join(targetProfile, "Secure Preferences"), "{}", "utf8"),
    writeFile(path.join(targetRoot, "Local State"), JSON.stringify(targetLocalState), "utf8")
  ]);
}

async function waitForFileContent(filePath, expected, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await readFile(filePath, "utf8").catch(() => null);
    if (latest === expected) return;
    await delay(80);
  }
  throw new Error(`Timed out waiting for copied file ${filePath}; latest=${String(latest)}`);
}

async function waitForMigratedExtension(registryPath, targetId, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const target = registry.profiles.find((profile) => profile.id === targetId);
    if (target?.migratedExtensions?.some((extension) => extension.sourceExtensionId === EXTENSION_ID)) return;
    await delay(80);
  }
  assert.fail("extension migration should persist a runtime-load record on the target");
}

function step(message) {
  console.log(`[e2e:sync-copy] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:sync-copy] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
