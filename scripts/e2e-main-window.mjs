#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 20_000;

async function main() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "profilepilot-e2e-main-window-"));
  const homeDir = path.join(fixtureRoot, "home");
  const dataDir = path.join(fixtureRoot, "profilepilot-data");
  const electronDataDir = path.join(fixtureRoot, "electron-data");

  try {
    await prepareFixture(homeDir, dataDir, electronDataDir);
    const result = await runElectron({ homeDir, dataDir, electronDataDir });

    assert.equal(result.exitCode, 0, failureOutput("Electron smoke instance exited unsuccessfully.", result));
    const smoke = extractSmokePayload(result.stdout);
    verifyMainWindowSmoke(smoke, homeDir);

    console.log("[e2e:main-window] PASS main -> preload -> renderer -> IPC smoke flow");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function prepareFixture(homeDir, dataDir, electronDataDir) {
  await Promise.all([
    mkdir(path.join(homeDir, ".codex"), { recursive: true }),
    mkdir(path.join(homeDir, ".claude"), { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(electronDataDir, { recursive: true })
  ]);

  await Promise.all([
    writeFile(path.join(homeDir, ".codex", "AGENTS.md"), "# ProfilePilot E2E fixture\n\nReply in Chinese.\n", "utf8"),
    writeFile(path.join(homeDir, ".claude", "CLAUDE.md"), "# ProfilePilot E2E reference fixture\n", "utf8")
  ]);
}

async function runElectron({ homeDir, dataDir, electronDataDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [repoRoot, `--user-data-dir=${electronDataDir}`], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CPM_DATA_DIR: dataDir,
        CPM_ELECTRON_SMOKE_TEST: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutError = null;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Electron smoke test timed out after ${TEST_TIMEOUT_MS}ms.`);
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, TEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (exitCode, signal) => {
      if (timeoutError) {
        finish(reject, timeoutError);
        return;
      }
      finish(resolve, { exitCode, signal, stdout, stderr });
    });

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback(value);
    }
  });
}

function extractSmokePayload(stdout) {
  const markerIndex = stdout.lastIndexOf('"smokeTest"');
  assert.notEqual(markerIndex, -1, `Electron output did not contain a smoke payload.\n${stdout}`);

  const start = stdout.lastIndexOf("{", markerIndex);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(stdout.slice(start, index + 1)).smokeTest;
      }
    }
  }

  assert.fail(`Electron smoke payload was incomplete.\n${stdout}`);
}

function verifyMainWindowSmoke(smoke, homeDir) {
  assert.equal(smoke.title, "ProfilePilot");
  assert.equal(smoke.h1, "ProfilePilot");
  assert.equal(smoke.hasBridge, true, "preload should expose window.profileManager");

  for (const capability of [
    "hasRenameProfile",
    "hasFocusProfile",
    "hasCloseProfile",
    "hasLaunchProfileWithCdp",
    "hasConnectRunningSystemChrome",
    "hasScanProfileExtensions",
    "hasMigrateExtensions",
    "hasDeleteProfileExtension",
    "hasInspectAccountSyncDiff",
    "hasInspectExtensionMigrationDiff",
    "hasSyncAccount",
    "hasCancelOperation",
    "hasControlOperation",
    "hasReadGlobalInstructions",
    "hasWriteGlobalInstruction",
    "hasEnsureClaudeInstructionShell",
    "hasOperationProgress"
  ]) {
    assert.equal(smoke[capability], true, `${capability} should be available through the preload bridge`);
  }

  assert.deepEqual(smoke.statusLabels, ["当前运行", "已管理", "运行中"]);
  assert.equal(smoke.accountSyncTitle, "同步");
  assert.equal(smoke.accountSyncDiffButton, "扫描账号差异");
  assert.equal(smoke.extensionScanButton, "扫描插件差异");
  assert.equal(smoke.migrationTitle, "插件明细");
  assert.ok(smoke.buttonCount >= 10, "main window should render its primary controls");
  assert.ok(smoke.shellWidthRatio >= 0.9 && smoke.shellWidthRatio <= 1, "main shell should fill the window");
  assert.equal(smoke.profileTableHasHorizontalOverflow, false);

  assert.deepEqual(smoke.globalInstructionFiles, ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(smoke.globalInstructionHasContent, true);
  assert.equal(smoke.globalInstructionsModalTitle, "全局指令");
  assert.deepEqual(smoke.globalInstructionsModalTabs, ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(smoke.globalInstructionsModalPath, path.join(homeDir, ".codex", "AGENTS.md"));
  assert.equal(smoke.globalInstructionsModalHasContent, true);
  assert.equal(smoke.globalInstructionsEditorReady, true);
  assert.ok(smoke.globalInstructionsEditorDraftLength > 0);
  assert.equal(smoke.crud, null, "the smoke flow must stay non-destructive");
}

function failureOutput(message, result) {
  return [
    message,
    `exitCode=${String(result.exitCode)} signal=${String(result.signal)}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:main-window] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
