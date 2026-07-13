#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";

const baselineDir = path.join(repoRoot, "tests", "visual-baselines");
const baselinePath = path.join(baselineDir, `main-empty-${process.platform}.png`);
const update = process.env.UPDATE_VISUAL_BASELINES === "1";

async function main() {
  const app = await launchProfilePilotE2e();
  try {
    await delay(1_000);
    const current = await app.driver.screenshot("main");
    if (update) {
      await mkdir(baselineDir, { recursive: true });
      await writeFile(baselinePath, Buffer.from(current.pngBase64, "base64"));
      console.log(`[e2e:visual] updated ${baselinePath}`);
      return;
    }

    const baseline = await readFile(baselinePath);
    const comparison = await app.driver.compareScreenshot(baseline.toString("base64"), {
      target: "main",
      channelTolerance: 12,
      maxDifferentPixelRatio: 0.002
    });
    assert.equal(
      comparison.passed,
      true,
      `visual difference exceeded threshold: ${JSON.stringify(comparison)}`
    );
    console.log(`[e2e:visual] PASS ${JSON.stringify(comparison)}`);
  } finally {
    await app.stop();
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:visual] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
