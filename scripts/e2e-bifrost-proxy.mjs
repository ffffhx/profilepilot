#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

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
    await driver.waitFor('[data-profile-row][data-id^="isolated:"]');
    await driver.waitFor('[data-action="toggle-profile-menu"]', (snapshot) => snapshot.exists && snapshot.disabled === false);

    phase = "open Bifrost configuration";
    await driver.domClick('[data-action="toggle-profile-menu"]');
    const bifrostAction = await driver.query('[data-action="configure-bifrost-proxy"]');
    assert.equal(bifrostAction.exists, true, `Bifrost action missing; menu=${JSON.stringify(await driver.query(".action-menu"))}`);
    await driver.domClick('[data-action="configure-bifrost-proxy"]');
    await driver.waitFor(".bifrost-proxy-modal");
    const bifrostStatus = await driver.waitFor(".bifrost-status", (snapshot) => snapshot.exists && !snapshot.text?.includes("正在读取"), { timeoutMs: 10_000 });

    phase = "configure Bifrost route";
    await driver.domInput("[data-bifrost-proxy-enabled]", undefined, { checked: true });
    if (/\bready\b/.test(bifrostStatus.attributes.class || "")) {
      const rule = await driver.waitFor("[data-bifrost-rule-option]");
      assert.equal(rule.disabled, false);
      await driver.domInput("[data-bifrost-rule-option]", undefined, { checked: true });
    } else {
      await driver.domInput("[data-bifrost-group-rules]", "7152084678483132446/worktree-a");
    }

    const route = await driver.query(".bifrost-route-map");
    assert.match(route.text || "", /Worktree A/);
    assert.match(route.text || "", /127\.0\.0\.1:18888/);
    assert.match(route.text || "", /1 条显式规则/);

    if (process.env.CPM_E2E_SCREENSHOT_PATH) {
      await delay(180);
      const screenshot = await driver.screenshot("main");
      await writeFile(process.env.CPM_E2E_SCREENSHOT_PATH, Buffer.from(screenshot.pngBase64, "base64"));
    }

    phase = "save Bifrost route";
    await driver.domClick('[data-bifrost-proxy-form] button[type="submit"]');
    await driver.waitFor(".bifrost-proxy-modal", (snapshot) => !snapshot.exists);
    const routeReadout = await driver.waitFor(".profile-route-track.bifrost");
    assert.match(routeReadout.text || "", /Bifrost\s*:18888/);
    assert.match(routeReadout.text || "", /worktree-a/);

    phase = "open recovery modal";
    try {
      await driver.waitFor('[data-action="launch"]', undefined, { timeoutMs: 500 });
    } catch {
      await driver.domClick('[data-action="toggle-profile-menu"]');
    }
    await driver.waitFor('[data-action="launch"]');
    phase = "request launch while Bifrost is stopped";
    await driver.domClick('[data-action="launch"]');
    phase = "wait for recovery modal";
    const recoveryModal = await driver.waitFor(".confirm-dialog", (snapshot) =>
      snapshot.exists && snapshot.text?.includes("启动 Bifrost 并继续")
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
    await driver.waitFor(".toast", (snapshot) =>
      snapshot.exists && snapshot.text?.includes("已启动 Bifrost，并通过专属分流启动 Worktree A")
    );

    const bifrostCommands = await readFile(fixture.bifrostLogPath, "utf8");
    assert.match(bifrostCommands, /^start --daemon$/m);
    assert.match(bifrostCommands, /^port bind --port 18888 -H 127\.0\.0\.1 --name profilepilot:/m);
    const chromeArgs = (await readFile(fixture.chromeLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .flat();
    assert.ok(chromeArgs.includes("--proxy-server=http://127.0.0.1:18888"), `args=${JSON.stringify(chromeArgs)}`);

    console.log("[e2e:bifrost] PASS route configuration and one-click Bifrost recovery launch");
  } catch (error) {
    const output = app.output();
    console.error(`[e2e:bifrost] failed during: ${phase}`);
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
