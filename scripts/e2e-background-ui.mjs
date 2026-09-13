#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

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

    const startupSwitch = '[data-action="toggle-startup"]';
    if (process.platform === "win32" || process.platform === "darwin") {
      await driver.waitFor(startupSwitch, snapshot => snapshot.attributes["aria-checked"] === "true");
      await driver.domClick(startupSwitch);
      await driver.waitFor(startupSwitch, snapshot => snapshot.attributes["aria-checked"] === "false" && !snapshot.disabled);
      assert.equal(JSON.parse(await readFile(path.join(dataDir, "startup-settings.json"), "utf8")).enabled, false);
      await driver.domClick(startupSwitch);
      await driver.waitFor(startupSwitch, snapshot => snapshot.attributes["aria-checked"] === "true" && !snapshot.disabled);
      assert.equal(JSON.parse(await readFile(path.join(dataDir, "startup-settings.json"), "utf8")).enabled, true);
    } else {
      assert.equal((await driver.query(startupSwitch)).disabled, true);
    }

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

    const row = await driver.waitFor(
      '[data-profile-row][data-id^="isolated:"]',
      (snapshot) => snapshot.text?.includes(PROFILE_NAME)
    );
    assert.match(row.attributes["data-id"], /^isolated:/);
    await driver.waitFor('[data-action="new-profile"]', (snapshot) => snapshot.exists && !snapshot.disabled);

    await driver.domClick('[data-action="new-profile"]');
    await driver.domInput("#profile-name", "未提交的第二个名称");
    await driver.evaluate(`(() => {
      const input = document.querySelector('#profile-name');
      input.focus(); input.setSelectionRange(2, 5);
      window.__draftInput = input;
    })()`);
    await delay(3_500);
    assert.equal((await driver.query(".toast")).exists, false);
    assert.deepEqual(await driver.evaluate(`(() => {
      const input = document.querySelector('#profile-name');
      return { value: input.value, sameNode: input === window.__draftInput,
        focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd };
    })()`), { value: "未提交的第二个名称", sameNode: true, focused: true, start: 2, end: 5 });
    await driver.domClick('.modal-actions [data-action="close-modal"]');

    assert.deepEqual(await driver.evaluate(`(() => {
      const row = document.querySelector('[data-profile-row]');
      return ['Enter', ' '].map(key => {
        const button = row.querySelector('button[data-action="toggle-profile-menu"]');
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      });
    })()`), [false, false], "row delegation must preserve native button activation");
    assert.equal(await driver.evaluate(`(() => {
      const row = document.querySelector('[data-profile-row]');
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      row.dispatchEvent(event);
      return event.defaultPrevented;
    })()`), true, "a focused row must still support keyboard selection");
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
