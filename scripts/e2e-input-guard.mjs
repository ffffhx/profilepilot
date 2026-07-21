#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertDesktopE2eAllowed, delay, repoRoot } from "./e2e/lib/electron-driver.mjs";

const require = createRequire(import.meta.url);
const { launchInputGuardCompanion } = require("../dist/main/input-guard-companion.js");
const execFileAsync = promisify(execFile);

async function main() {
  if (process.platform !== "darwin") {
    console.log("[e2e:input-guard] SKIP: system Input Guard is macOS-only");
    return;
  }
  assertDesktopE2eAllowed("e2e-input-guard");

  const compileDir = await mkdtemp(path.join(os.tmpdir(), "pp-input-guard-e2e-"));
  const pointer = path.join(compileDir, "native-pointer");
  const clickTarget = path.join(compileDir, "native-click-target");
  const marker = path.join(compileDir, "clicked.txt");
  let target = null;
  let guard = null;
  try {
    await Promise.all([
      execFileAsync("/usr/bin/xcrun", [
        "clang", "-O2", "-framework", "ApplicationServices",
        path.join(repoRoot, "scripts", "e2e", "native-pointer.c"), "-o", pointer
      ]),
      execFileAsync("/usr/bin/xcrun", [
        "clang", "-fobjc-arc", "-O2", "-framework", "Cocoa", "-framework", "ApplicationServices",
        path.join(repoRoot, "scripts", "e2e", "native-click-target.m"), "-o", clickTarget
      ])
    ]);
    await signPointerLikeInputGuard(pointer);

    target = spawn(clickTarget, [marker], { stdio: ["ignore", "pipe", "pipe"] });
    const targetReady = await waitForJsonLine(target, (message) => message.type === "ready", 8_000);
    assert.equal(targetReady.pid, target.pid);
    const point = {
      x: Math.round(targetReady.bounds.x + targetReady.bounds.width / 2),
      y: Math.round(targetReady.bounds.y + targetReady.bounds.height / 2)
    };

    const helperPath = path.join(
      repoRoot,
      "dist",
      "native",
      "ProfilePilot Input Guard.app",
      "Contents",
      "MacOS",
      "ProfilePilot Input Guard"
    );
    guard = new GuardClient(launchInputGuardCompanion(helperPath));
    await guard.waitFor((message) => message.status === "ready", 8_000);
    const access = await guard.waitFor(
      (message) => message.status === "accessibility-access-granted" || message.status === "accessibility-access-denied",
      8_000
    );
    assert.equal(access.status, "accessibility-access-granted", "Input Guard companion needs macOS Accessibility access");

    guard.write(`SET ${target.pid}\n`);
    await guard.waitFor((message) => message.status === "tap-active" && message.pid === target.pid, 8_000);
    await guard.waitFor((message) => message.status === "sync-complete" && message.activeCount === 1, 8_000);
    step(`active CGEventTap attached to native GUI PID ${target.pid}`);

    await postClick(pointer, point, target.pid);
    await guard.waitFor((message) => message.type === "mouse" && message.pid === target.pid, 5_000);
    await delay(300);
    await assert.rejects(readFile(marker, "utf8"), (error) => error?.code === "ENOENT");
    step("real system mouse event reached Input Guard and was suppressed before the target process event stream");

    guard.write("SET\n");
    await guard.waitFor((message) => message.status === "tap-removed" && message.pid === target.pid, 8_000);
    await guard.waitFor((message) => message.status === "sync-complete" && message.activeCount === 0, 8_000);
    await postClick(pointer, point, target.pid);
    await waitForFile(marker, 5_000);
    assert.equal(await readFile(marker, "utf8"), "clicked\n");
    step("the same system mouse event reached the target process after Input Guard release");
    step("PASS");
  } catch (error) {
    if (guard) console.error(`[e2e:input-guard] guard output:\n${guard.output}`);
    throw error;
  } finally {
    guard?.close();
    target?.kill("SIGTERM");
    await rm(compileDir, { recursive: true, force: true });
  }
}

class GuardClient {
  constructor(child) {
    this.child = child;
    this.output = "";
    this.buffer = "";
    this.messages = [];
    this.waiters = new Set();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(String(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.output += String(chunk); });
  }

  consume(chunk) {
    this.output += chunk;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) waiter(message);
    }
  }

  write(command) { this.child.stdin.write(command); }

  waitFor(predicate, timeoutMs) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(onMessage);
        reject(new Error(`Timed out waiting for Input Guard message. Output: ${this.output}`));
      }, timeoutMs);
      const onMessage = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        this.waiters.delete(onMessage);
        resolve(message);
      };
      this.waiters.add(onMessage);
    });
  }

  close() {
    if (!this.child.stdin.destroyed && this.child.stdin.writable) this.child.stdin.end("SET\nQUIT\n");
  }
}

function waitForJsonLine(child, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Native click target timed out: ${stderr}`)), timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (predicate(message)) {
            clearTimeout(timeout);
            resolve(message);
            return;
          }
        } catch {
          // Ignore non-JSON diagnostic output.
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Native click target exited before ready (${code}): ${stderr}`));
    });
  });
}

async function postClick(pointer, point, targetPid) {
  const { stderr } = await execFileAsync(pointer, [String(targetPid), String(point.x), String(point.y)]);
  if (stderr.trim()) step(`native pointer: ${stderr.trim().split("\n").slice(0, 2).join("; ")}`);
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try { await readFile(filePath); return; } catch { await delay(60); }
  }
  throw new Error(`Timed out waiting for click marker: ${filePath}`);
}

async function signPointerLikeInputGuard(pointer) {
  const signingDir = path.join(os.homedir(), "Library", "Application Support", "ProfilePilot", "CodeSigning");
  const keychainPath = path.join(signingDir, "input-guard-signing.keychain-db");
  const password = (await readFile(path.join(signingDir, "keychain-password"), "utf8")).trim();
  await execFileAsync("/usr/bin/security", ["unlock-keychain", "-p", password, keychainPath]);
  const { stdout } = await execFileAsync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", keychainPath]);
  const fingerprint = stdout.match(/([0-9A-F]{40}) \"ProfilePilot Input Guard Local Signing\"/)?.[1];
  assert.ok(fingerprint, "ProfilePilot Input Guard local signing identity is unavailable");
  const { stdout: keychainsText } = await execFileAsync("/usr/bin/security", ["list-keychains", "-d", "user"]);
  const originalKeychains = [...keychainsText.matchAll(/\"([^\"]+)\"/g)].map((match) => match[1]);
  const searchKeychains = originalKeychains.includes(keychainPath) ? originalKeychains : [...originalKeychains, keychainPath];
  await execFileAsync("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...searchKeychains]);
  try {
    await execFileAsync("/usr/bin/codesign", [
      "--force", "--timestamp=none", "--sign", fingerprint,
      "--identifier", "io.github.ffffhx.profilepilot.input-guard", "--keychain", keychainPath, pointer
    ]);
  } finally {
    await execFileAsync("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...originalKeychains]);
  }
}

function step(message) { console.log(`[e2e:input-guard] ${message}`); }

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:input-guard] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
