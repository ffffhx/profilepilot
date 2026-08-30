#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATION_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 15_000;

async function main() {
  const app = await launchProfilePilotE2e({ mode: "background", name: "e2e-sync-copy" });
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
    await driver.domClick(`[data-action="select-account-sync-profile"][data-kind="source"][data-id="${sourceId}"]`);
    await openPicker(driver, "target");
    await driver.waitFor(`[data-action="select-account-sync-profile"][data-kind="target"][data-id="${targetId}"]`);
    await driver.domClick(`[data-action="select-account-sync-profile"][data-kind="target"][data-id="${targetId}"]`);

    const sourcePicker = await driver.query('[data-account-sync-select="source"] .profile-select-trigger');
    const targetPicker = await driver.query('[data-account-sync-select="target"] .profile-select-trigger');
    assert.match(sourcePicker.text, /E2E Sync Source/);
    assert.match(targetPicker.text, /E2E Sync Target/);

    assert.equal((await driver.query("[data-sync-part-account]")).checked, true);
    assert.equal((await driver.query("[data-sync-part-extensions]")).checked, true);
    const launchTarget = await driver.query("[data-launch-synced-profile]");
    if (launchTarget.checked) await driver.domClick("[data-launch-synced-profile]");

    await driver.domClick('[data-action="run-sync"]');
    await driver.waitFor('[data-action="confirm-modal-action"]');
    await driver.domClick('[data-action="confirm-modal-action"]');

    await waitForFileContent(path.join(targetProfile, "Bookmarks"), "SOURCE_BOOKMARKS");
    await waitForFileContent(path.join(targetProfile, "Network", "Cookies"), "SOURCE_COOKIE_BYTES");
    await waitForFileContent(path.join(targetProfile, "Local Storage", "leveldb", "fixture.log"), "SOURCE_LOCAL_STORAGE");
    await driver.waitFor('[data-action="run-sync"]', (snapshot) => snapshot.exists && !snapshot.disabled, {
      timeoutMs: OPERATION_TIMEOUT_MS
    });
    await waitForFileContent(
      path.join(targetProfile, "Extensions", EXTENSION_ID, "1.0.0", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "ProfilePilot E2E Extension", version: "1.0.0" })
    );
    assert.equal(
      await readFile(path.join(targetProfile, "Local Extension Settings", EXTENSION_ID, "fixture.log"), "utf8"),
      "TARGET_OLD_EXTENSION_DATA",
      "combined sync must preserve extension data unless the user opted into copying it"
    );
    step("account files and extensions were copied through the combined UI sync flow");
    step("PASS");
  } catch (error) {
    const output = app.output();
    console.error("[e2e:sync-copy] UI toast:", await driver.query(".toast").catch(() => null));
    if (output.stdout) console.error(`[e2e:sync-copy] Electron stdout:\n${output.stdout}`);
    if (output.stderr) console.error(`[e2e:sync-copy] Electron stderr:\n${output.stderr}`);
    throw error;
  } finally {
    await app.stop();
  }
}

async function createProfile(driver, name) {
  await driver.domClick('[data-action="new-profile"]');
  await driver.waitFor("#profile-name");
  await driver.domInput("#profile-name", name);
  await driver.domClick('[data-create-form] button[type="submit"]');
  await driver.waitFor("[data-profile-row]", (snapshot) => snapshot.text?.includes(name));
  await driver.waitFor('[data-action="new-profile"]', (snapshot) => snapshot.exists && !snapshot.disabled);
}

async function openPicker(driver, kind) {
  const selector = `[data-account-sync-select="${kind}"] .profile-select-trigger`;
  await driver.domClick(selector);
  await delay(80);
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

  const extensionSetting = {
    state: 1,
    location: 4,
    from_webstore: true,
    path: path.relative(sourceProfile, extensionDir),
    manifest: {
      manifest_version: 3,
      name: "ProfilePilot E2E Extension",
      version: "1.0.0",
      update_url: "https://clients2.google.com/service/update2/crx"
    }
  };
  const preferences = {
    extensions: {
      settings: {
        [EXTENSION_ID]: extensionSetting
      }
    }
  };
  const securePreferences = {
    extensions: { settings: { [EXTENSION_ID]: extensionSetting } },
    protection: {
      macs: {
        extensions: {
          settings: { [EXTENSION_ID]: "fixture-settings-mac" },
          settings_encrypted_hash: { [EXTENSION_ID]: "fixture-settings-hash" }
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
    writeFile(path.join(sourceProfile, "Secure Preferences"), JSON.stringify(securePreferences), "utf8"),
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

async function waitForFileContent(filePath, expected, timeoutMs = OPERATION_TIMEOUT_MS) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await readFile(filePath, "utf8").catch(() => null);
    if (latest === expected) return;
    await delay(80);
  }
  throw new Error(`Timed out waiting for copied file ${filePath}; latest=${String(latest)}`);
}

function step(message) {
  console.log(`[e2e:sync-copy] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:sync-copy] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
