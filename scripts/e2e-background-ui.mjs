#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const PROFILE_NAME = "Background DOM Profile";

async function main() {
  const app = await launchProfilePilotE2e({ mode: "background" });
  const { driver, dataDir } = app;
  try {
    const initialWindows = await driver.windows();
    assert.equal(initialWindows.main.visible, false, "background E2E must keep the main window hidden");
    assert.equal(initialWindows.main.focused, false, "background E2E must not focus the main window");

    const heading = await driver.query("h1");
    assert.equal(heading.text, "ProfilePilot");
    assert.equal(await driver.evaluate("document.visibilityState"), "visible");
    assert.ok((await driver.screenshot("main")).pngBase64.length > 1_000, "hidden window should still be capturable");

    await assert.rejects(
      driver.click('[data-action="new-profile"]'),
      /Background E2E only supports DOM\/read commands/,
      "background E2E must reject real mouse commands"
    );
    await assert.rejects(
      driver.triggerMiniHotkeyHandler(),
      /Background E2E only supports DOM\/read commands/,
      "background E2E must reject the desktop-only hotkey handler command"
    );

    await driver.domClick('[data-action="new-profile"]');
    await driver.waitFor("#profile-name");
    await driver.domInput("#profile-name", PROFILE_NAME);
    assert.equal((await driver.query("#profile-name")).value, PROFILE_NAME);
    await driver.domClick('[data-create-form] button[type="submit"]');

    const row = await driver.waitFor("[data-profile-row]", (snapshot) => snapshot.text?.includes(PROFILE_NAME));
    assert.match(row.attributes["data-id"], /^isolated:/);
    await driver.waitFor('[data-action="new-profile"]', (snapshot) => snapshot.exists && !snapshot.disabled);
    const registry = JSON.parse(await readFile(path.join(dataDir, "profiles.json"), "utf8"));
    assert.ok(registry.profiles.some((profile) => profile.name === PROFILE_NAME));

    const finalWindows = await driver.windows();
    assert.equal(finalWindows.main.visible, false);
    assert.equal(finalWindows.main.focused, false);
    step("PASS hidden Electron window + DOM events + evaluate + screenshot without foreground activation");
  } finally {
    await app.stop();
  }
}

function step(message) {
  console.log(`[e2e:background] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:background] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
