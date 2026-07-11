const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("UI state is Gateway-event driven with one low-frequency main-process calibration", () => {
  const renderer = readFileSync(path.join(root, "src", "renderer", "main.ts"), "utf8");
  const main = readFileSync(path.join(root, "src", "main", "main.ts"), "utf8");

  assert.match(renderer, /onStateChanged\(queuePushedState\)/);
  assert.doesNotMatch(renderer, /\},\s*2500\s*\)/);
  assert.doesNotMatch(renderer, /\},\s*3000\s*\)/);
  assert.match(main, /STATE_CALIBRATION_INTERVAL_MS\s*=\s*30_000/);
  assert.match(main, /subscribeBrowserGatewayEvents/);
  assert.match(main, /watch\(browserGatewayRoot\(\)/);
  assert.match(main, /webContents\.send\(IPC_CHANNELS\.stateChanged, state\)/);
});
