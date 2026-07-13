const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ProfilePilotSignal,
  SIGNAL_CATALOG,
  collapseHardStopGuidance,
  resolveSignal
} = require("../dist/main/agent-signals.js");

test("Profile switch signals keep the recommendation but require user confirmation", () => {
  const unavailable = resolveSignal({
    kind: "cdp-port",
    available: false,
    preferredPort: 9223,
    suggestedPort: 9224,
    owner: "another Codex Session"
  });
  assert.equal(unavailable.code, ProfilePilotSignal.CDP_PORT_UNAVAILABLE);
  assert.equal(unavailable.hardStop, true);
  assert.match(unavailable.action, /不要自动切换 Profile/);
  assert.match(unavailable.action, /征得同意/);
  assert.match(unavailable.action, /agent-browser --cdp 9224 <cmd>/);
  assert.match(collapseHardStopGuidance(unavailable), /CDP_PORT_UNAVAILABLE/);

  const contended = resolveSignal({
    kind: "cdp-contention",
    level: "contention",
    activeClientCount: 2,
    port: 9223,
    churnOwners: ["cx-one", "cx-two"]
  });
  assert.equal(contended.code, ProfilePilotSignal.CDP_PORT_CONTENDED);
  assert.match(contended.action, /不要继续重试或自动切换 Profile/);
  assert.match(contended.action, /征得同意/);
  assert.match(SIGNAL_CATALOG[ProfilePilotSignal.CDP_PORT_UNAVAILABLE].action, /征得同意/);
});
