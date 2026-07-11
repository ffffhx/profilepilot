const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("installed shell integration refreshes the agent-browser wrapper after an app upgrade", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-shell-integration-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const {
      agentBrowserWrapperPath,
      refreshAgentBrowserWrapperIfInstalled,
      setShellIntegrationEnabled
    } = require(modulePath);

    await setShellIntegrationEnabled(true);
    const wrapperPath = agentBrowserWrapperPath();
    fs.writeFileSync(wrapperPath, "stale wrapper", "utf8");

    assert.equal(await refreshAgentBrowserWrapperIfInstalled(), true);
    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    assert.match(wrapper, /AGENT_CONTROL_RETURNED/);
    assert.match(wrapper, /GATEWAY_PROFILE_NOT_CONFIGURED/);
    assert.doesNotMatch(wrapper, /require\(["']\.\//, "installed wrapper must be self-contained");
    const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
    assert.match(zshenv, /PROFILEPILOT_NODE_RUNTIME=/);
    assert.match(zshenv, /ELECTRON_RUN_AS_NODE=1/);
    assert.match(zshenv, /已拒绝绕过浏览器控制保护/);
    assert.doesNotMatch(zshenv, /else\n\s+command agent-browser/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
