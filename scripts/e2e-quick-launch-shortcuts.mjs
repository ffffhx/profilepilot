import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const app = await launchProfilePilotE2e({
  name: "e2e-quick-launch-shortcuts",
  mode: "background",
  prepareFixture: async ({ dataDir }) => {
    await writeFile(path.join(dataDir, "profiles.json"), JSON.stringify({
      profiles: ["one", "two"].map(id => ({ id, name: `Shortcut ${id}`, dirName: id, createdAt: new Date().toISOString(), lastLaunchedAt: null })),
      quickLaunchSlots: { 3: "isolated:one" }
    }));
  }
});
const { driver, dataDir } = app;
const registry = async () => JSON.parse(await readFile(path.join(dataDir, "profiles.json"), "utf8"));
const input = '[data-quick-launch-input]';
async function open(id) {
  await driver.waitFor(`[data-action="toggle-profile-menu"][data-id="isolated:${id}"]`, s => s.exists && !s.disabled);
  await driver.domClick(`[data-action="toggle-profile-menu"][data-id="isolated:${id}"]`);
  await driver.waitFor(input);
  await driver.evaluate(`document.querySelector('${input}').focus(); true`);
  // Hidden Electron windows do not dispatch native focus events.
  await driver.dispatch(input, "focusin");
  await delay(100);
}
async function key(key, code, modifiers = {}) {
  await driver.dispatch(input, "keydown", { key, code, bubbles: true, cancelable: true, ...modifiers });
}
try {
  await open("one");
  assert.equal((await driver.query('select[data-quick-launch-slot]')).exists, false);
  const legacyLabel = process.platform === "darwin" ? "⌥⌘3" : "Ctrl+Alt+3";
  assert.equal((await driver.query(input)).value, legacyLabel);
  await key("Control", "ControlLeft", { ctrlKey: true });
  assert.equal((await driver.query(input)).value, legacyLabel, "modifier alone must not save");
  await key("k", "KeyK", { ctrlKey: true, altKey: true });
  await driver.waitFor('[data-profile-row][data-id="isolated:one"] .slot-badge', s => s.text === (process.platform === "darwin" ? "⌃⌥K" : "Ctrl+Alt+K"));
  assert.equal((await registry()).quickLaunchShortcuts["isolated:one"], "Control+Alt+K");
  await open("two");
  await key("k", "KeyK", { ctrlKey: true, altKey: true });
  await driver.waitFor("#app-toast", s => s.text?.includes("已绑定"));
  assert.equal((await registry()).quickLaunchShortcuts["isolated:two"], undefined);
  await open("one");
  await key("Escape", "Escape");
  assert.equal((await registry()).quickLaunchShortcuts["isolated:one"], "Control+Alt+K");
  await driver.evaluate(`document.querySelector('${input}').focus(); true`);
  await driver.dispatch(input, "focusin");
  await delay(100);
  await key("Backspace", "Backspace");
  await driver.waitFor('[data-profile-row][data-id="isolated:one"] .slot-badge', s => !s.exists);
  assert.equal((await registry()).quickLaunchShortcuts["isolated:one"], undefined);
  await open("one");
  await key("F8", "F8");
  await driver.waitFor('[data-profile-row][data-id="isolated:one"] .slot-badge', s => s.text === "F8");
  await open("one");
  const dimensions = await driver.evaluate(`(() => { const input = document.querySelector('${input}').getBoundingClientRect(); const menu = document.querySelector('.action-menu').getBoundingClientRect(); return { input: { left: input.left, right: input.right }, menu: { left: menu.left, right: menu.right } }; })()`);
  assert.ok(dimensions.input.left >= dimensions.menu.left && dimensions.input.right <= dimensions.menu.right);
  if (process.env.CPM_SHORTCUT_SCREENSHOT) {
    await driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    await delay(350);
    const screenshot = await driver.screenshot();
    await writeFile(process.env.CPM_SHORTCUT_SCREENSHOT, Buffer.from(screenshot.pngBase64, "base64"));
  }
  await driver.domClick('[data-clear-quick-launch]');
  await driver.waitFor('[data-profile-row][data-id="isolated:one"] .slot-badge', s => !s.exists);
  assert.equal((await registry()).quickLaunchSlots, undefined);
  console.log("[e2e:quick-launch] PASS record, persist, conflict, cancel, clear and menu layout");
} finally {
  await app.stop();
}
