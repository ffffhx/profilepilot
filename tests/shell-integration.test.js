const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("installed shell integration refreshes the agent-browser wrapper after an app upgrade", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-shell-integration-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const {
      agentBrowserLauncherPath,
      agentBrowserWrapperPath,
      chromeDevtoolsMcpLauncherPath,
      chromeDevtoolsMcpWrapperPath,
      playwrightCliLauncherPath,
      playwrightCliWrapperPath,
      refreshAgentBrowserWrapperIfInstalled,
      setShellIntegrationEnabled
    } = require(modulePath);

    await setShellIntegrationEnabled(true);
    const wrapperPath = agentBrowserWrapperPath();
    const launcherPath = agentBrowserLauncherPath();
    const playwrightWrapper = playwrightCliWrapperPath();
    const playwrightLauncher = playwrightCliLauncherPath();
    const mcpWrapper = chromeDevtoolsMcpWrapperPath();
    const mcpLauncher = chromeDevtoolsMcpLauncherPath();
    fs.writeFileSync(wrapperPath, "stale wrapper", "utf8");

    assert.equal(await refreshAgentBrowserWrapperIfInstalled(), true);
    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    assert.match(wrapper, /AGENT_CONTROL_RETURNED/);
    assert.match(wrapper, /GATEWAY_PROFILE_NOT_CONFIGURED/);
    assert.doesNotMatch(wrapper, /require\(["']\.\//, "installed wrapper must be self-contained");
    const launcher = fs.readFileSync(launcherPath, "utf8");
    assert.match(launcher, /^#!\/bin\/sh/);
    assert.match(launcher, /ELECTRON_RUN_AS_NODE=1 exec/);
    assert.equal(fs.statSync(launcherPath).mode & 0o111, 0o111);
    assert.match(fs.readFileSync(playwrightWrapper, "utf8"), /playwright-cli/);
    assert.match(fs.readFileSync(mcpWrapper, "utf8"), /chrome-devtools-mcp/);
    assert.equal(fs.statSync(playwrightLauncher).mode & 0o111, 0o111);
    assert.equal(fs.statSync(mcpLauncher).mode & 0o111, 0o111);
    const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
    assert.match(zshenv, /PROFILEPILOT_NODE_RUNTIME=/);
    assert.match(zshenv, /PROFILEPILOT_AGENT_BROWSER_LAUNCHER=/);
    assert.match(zshenv, /PROFILEPILOT_AGENT_BROWSER_BIN_DIR=/);
    assert.match(zshenv, /PROFILEPILOT_PLAYWRIGHT_CLI_LAUNCHER=/);
    assert.match(zshenv, /PROFILEPILOT_CHROME_DEVTOOLS_MCP_LAUNCHER=/);
    assert.match(zshenv, /PROFILEPILOT_SESSION="\$AGENT_BROWSER_SESSION"/);
    assert.match(zshenv, /export PATH="\$PROFILEPILOT_AGENT_BROWSER_BIN_DIR:\$PATH"/);
    assert.doesNotMatch(zshenv, /agent-browser\(\)/);

    const fakeAgentBrowser = path.join(home, "fake-agent-browser");
    fs.writeFileSync(fakeAgentBrowser, "#!/bin/sh\nprintf '%s\\n' child-shell-ok\n", "utf8");
    fs.chmodSync(fakeAgentBrowser, 0o755);
    const childOutput = execFileSync("/bin/sh", ["-c", "agent-browser version"], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${path.dirname(launcherPath)}:/usr/bin:/bin`,
        AGENT_BROWSER_SESSION: "cx-child-shell",
        PROFILEPILOT_AGENT_BROWSER_WRAPPER: wrapperPath,
        PROFILEPILOT_AGENT_BROWSER_LAUNCHER: launcherPath,
        PROFILEPILOT_NODE_RUNTIME: process.execPath,
        PROFILEPILOT_AGENT_BROWSER_REAL: fakeAgentBrowser
      }
    });
    assert.equal(childOutput.trim(), "child-shell-ok");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
