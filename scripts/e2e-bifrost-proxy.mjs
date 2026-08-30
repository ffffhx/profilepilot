#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const OPERATION_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 10_000;

async function createBifrostLaunchFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-bifrost-launch-"));
  const binaryPath = path.join(root, "bifrost-fixture.mjs");
  const chromePath = path.join(root, "chrome-fixture.mjs");
  const runningPath = path.join(root, "running");
  const bindingPath = path.join(root, "binding");
  const bifrostLogPath = path.join(root, "bifrost.log");
  const chromeLogPath = path.join(root, "chrome.log");

  await Promise.all([
    writeFile(
      binaryPath,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const command = process.argv.slice(2).join(" ");
const runningPath = process.env.BIFROST_E2E_RUNNING_PATH;
const bindingPath = process.env.BIFROST_E2E_BINDING_PATH;
const logPath = process.env.BIFROST_E2E_LOG_PATH;
appendFileSync(logPath, command + "\\n");

if (command === "status --format json") {
  const running = existsSync(runningPath);
  const bindingName = existsSync(bindingPath) ? readFileSync(bindingPath, "utf8").trim() : "";
  process.stdout.write(JSON.stringify({
    running,
    version: "e2e",
    listener: { port: 9900 },
    ports: bindingName
      ? [{ port: 18888, host: "127.0.0.1", name: bindingName, status: "running" }]
      : [],
    active_rules: []
  }));
} else if (command === "start --daemon") {
  writeFileSync(runningPath, "running\\n");
} else if (command === "rule list") {
  process.stdout.write("Rules (1):\\n  profilepilot-e2e [enabled]\\n");
} else if (command.startsWith("group rule show ")) {
  process.stdout.write("Group Rule:\\nContent:\\ncode.coze.cn x-tt-env-fe=ppe_e2e\\n");
} else if (command === "port show 18888") {
  if (!existsSync(bindingPath)) process.exit(1);
  process.stdout.write("Temporary port: 127.0.0.1:18888\\nName: " + readFileSync(bindingPath, "utf8").trim() + "\\n");
} else if (command.startsWith("port bind --port 18888 ")) {
  const args = process.argv.slice(2);
  const nameIndex = args.indexOf("--name");
  writeFileSync(bindingPath, nameIndex >= 0 ? args[nameIndex + 1] + "\\n" : "\\n");
}
`,
      "utf8"
    ),
    writeFile(
      chromePath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CHROME_E2E_LOG_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
      "utf8"
    )
  ]);
  await Promise.all([chmod(binaryPath, 0o755), chmod(chromePath, 0o755)]);

  return {
    root,
    bifrostLogPath,
    chromeLogPath,
    env: {
      BIFROST_BINARY: binaryPath,
      BIFROST_E2E_RUNNING_PATH: runningPath,
      BIFROST_E2E_BINDING_PATH: bindingPath,
      BIFROST_E2E_LOG_PATH: bifrostLogPath,
      CHROME_BINARY: chromePath,
      CHROME_E2E_LOG_PATH: chromeLogPath
    }
  };
}

async function main() {
  const fixture = await createBifrostLaunchFixture();
  const app = await launchProfilePilotE2e({ name: "Bifrost proxy UI", env: fixture.env });
  const { driver } = app;
  let phase = "create profile";
  try {
    await driver.domClick('[data-action="new-profile"]');
    await driver.domInput("#profile-name", "Worktree A");
    await driver.domClick('[data-create-form] button[type="submit"]');
    const profileRow = await driver.waitFor('[data-profile-row][data-id^="isolated:"]');
    const profileId = profileRow.attributes["data-id"];
    assert.ok(profileId);
    const menuSelector = `[data-action="toggle-profile-menu"][data-id="${profileId}"]`;
    const launchSelector = `[data-action="launch"][data-id="${profileId}"]`;
    await driver.waitFor(menuSelector, (snapshot) => snapshot.exists && snapshot.disabled === false);

    phase = "open Bifrost configuration";
    await driver.domClick(menuSelector);
    const bifrostAction = await driver.query('[data-action="configure-bifrost-proxy"]');
    assert.equal(bifrostAction.exists, true, `Bifrost action missing; menu=${JSON.stringify(await driver.query(".action-menu"))}`);
    await driver.domClick('[data-action="configure-bifrost-proxy"]');
    await driver.waitFor(".bifrost-proxy-modal");
    const bifrostStatus = await driver.waitFor(".bifrost-status", (snapshot) => snapshot.exists && !snapshot.text?.includes("正在读取"), { timeoutMs: 10_000 });

    phase = "configure Bifrost route";
    await driver.domInput("[data-bifrost-proxy-enabled]", undefined, { checked: true });
    assert.match(bifrostStatus.text || "", /Bifrost/);
    assert.equal((await driver.query('[data-bifrost-mode][value="bifrost-main"]')).checked, true);

    const route = await driver.query(".bifrost-route-map");
    assert.match(route.text || "", /Worktree A/);
    assert.match(route.text || "", /127\.0\.0\.1:9900/);
    assert.match(route.text || "", /Bifrost 主入口/);

    if (process.env.CPM_E2E_SCREENSHOT_PATH) {
      await delay(180);
      const screenshot = await driver.screenshot("main");
      await writeFile(process.env.CPM_E2E_SCREENSHOT_PATH, Buffer.from(screenshot.pngBase64, "base64"));
    }

    phase = "save Bifrost route";
    await driver.domClick('[data-bifrost-proxy-form] button[type="submit"]');
    await driver.waitFor(".bifrost-proxy-modal", (snapshot) => !snapshot.exists, { timeoutMs: OPERATION_TIMEOUT_MS });
    const routeReadout = await driver.waitFor(".profile-route-track.upstream.provider-bifrost");
    assert.match(routeReadout.text || "", /Bifrost\s*:9900/);
    await driver.waitFor(menuSelector, (snapshot) => snapshot.exists && !snapshot.disabled, {
      timeoutMs: OPERATION_TIMEOUT_MS
    });

    try {
      await driver.waitFor(launchSelector, undefined, { timeoutMs: 500 });
    } catch {
      phase = "open profile menu for launch";
      await driver.domClick(menuSelector);
    }
    phase = "wait for launch action";
    await driver.waitFor(launchSelector);
    phase = "request launch while Bifrost is stopped";
    await driver.domClick(launchSelector);
    phase = "wait for recovery modal";
    const recoveryModal = await driver.waitFor(
      ".confirm-dialog",
      (snapshot) => snapshot.exists && snapshot.text?.includes("启动 Bifrost 并继续"),
      { timeoutMs: OPERATION_TIMEOUT_MS }
    );
    assert.match(recoveryModal.text || "", /恢复分流并启动 Worktree A/);
    assert.match(recoveryModal.text || "", /本次直连启动/);

    if (process.env.CPM_E2E_RECOVERY_SCREENSHOT_PATH) {
      await delay(180);
      const screenshot = await driver.screenshot("main");
      await writeFile(process.env.CPM_E2E_RECOVERY_SCREENSHOT_PATH, Buffer.from(screenshot.pngBase64, "base64"));
    }

    phase = "one-click recover and launch";
    await driver.domClick('[data-action="start-bifrost-and-launch"]');
    await driver.waitFor(
      ".toast",
      (snapshot) => snapshot.exists && snapshot.text?.includes("已启动 Bifrost，并通过专属分流启动 Worktree A"),
      { timeoutMs: OPERATION_TIMEOUT_MS }
    );

    const bifrostCommands = await readFile(fixture.bifrostLogPath, "utf8");
    assert.match(bifrostCommands, /^start --daemon$/m);
    const chromeArgs = (await readFile(fixture.chromeLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .flat();
    assert.ok(chromeArgs.includes("--proxy-server=127.0.0.1:9900"), `args=${JSON.stringify(chromeArgs)}`);

    console.log("[e2e:bifrost] PASS main-route configuration and one-click Bifrost recovery launch");
  } catch (error) {
    const output = app.output();
    console.error(`[e2e:bifrost] failed during: ${phase}`);
    console.error("[e2e:bifrost] UI toast:", await driver.query(".toast").catch(() => null));
    console.error(`[e2e:bifrost] renderer output\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
    throw error;
  } finally {
    await app.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:bifrost] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
