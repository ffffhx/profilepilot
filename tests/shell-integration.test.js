const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("each real tool installs and refreshes only its own Wrapper", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-shell-integration-"));
  const keys = [
    "HOME",
    "PROFILEPILOT_AGENT_BROWSER_REAL",
    "PROFILEPILOT_PLAYWRIGHT_CLI_REAL",
    "PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL"
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const fakeAgentBrowser = executable(path.join(home, "fake-agent-browser"), "child-shell-ok");
  const fakePlaywrightCli = executable(path.join(home, "fake-playwright-cli"), "playwright-shell-ok");
  const fakeChromeDevtoolsMcp = executable(path.join(home, "fake-chrome-devtools-mcp"), "mcp-shell-ok");
  process.env.HOME = home;
  process.env.PROFILEPILOT_AGENT_BROWSER_REAL = fakeAgentBrowser;
  process.env.PROFILEPILOT_PLAYWRIGHT_CLI_REAL = fakePlaywrightCli;
  process.env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL = fakeChromeDevtoolsMcp;

  try {
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const shell = require(modulePath);

    let diagnostic = await shell.inspectAgentIntegration();
    assert.ok(diagnostic.wrappers.every((item) => !item.wrapperInstalled && !item.launcherInstalled));
    assert.equal(diagnostic.ready, false);

    diagnostic = await shell.setAgentWrapperEnabled("agent-browser", true);
    const agentWrapper = diagnostic.wrappers.find((item) => item.key === "agent-browser");
    const otherWrappers = diagnostic.wrappers.filter((item) => item.key !== "agent-browser");
    assert.equal(agentWrapper.wrapperInstalled, true);
    assert.equal(agentWrapper.launcherInstalled, true);
    assert.ok(otherWrappers.every((item) => !item.wrapperInstalled && !item.launcherInstalled));
    assert.equal(diagnostic.shellIntegration.installed, true);
    assert.equal(diagnostic.ready, false, "Skill is an independent readiness requirement");

    diagnostic = await shell.setAgentSkillEnabled("agent-browser", true);
    assert.equal(diagnostic.skills.find((item) => item.key === "agent-browser").installed, true);
    assert.equal(diagnostic.ready, true);

    fs.writeFileSync(agentWrapper.wrapperPath, "stale wrapper", "utf8");
    assert.equal(await shell.refreshAgentBrowserWrapperIfInstalled(), true);
    const wrapper = fs.readFileSync(agentWrapper.wrapperPath, "utf8");
    assert.match(wrapper, /AGENT_CONTROL_RETURNED/);
    assert.match(wrapper, /GATEWAY_PROFILE_NOT_CONFIGURED/);
    assert.doesNotMatch(wrapper, /require\(["']\.\//, "installed wrapper must be self-contained");
    assert.ok(otherWrappers.every((item) => !fs.existsSync(item.wrapperPath) && !fs.existsSync(item.launcherPath)));

    const launcher = fs.readFileSync(agentWrapper.launcherPath, "utf8");
    assert.match(launcher, /^#!\/bin\/sh/);
    assert.match(launcher, /ELECTRON_RUN_AS_NODE=1 exec/);
    assert.equal(fs.statSync(agentWrapper.launcherPath).mode & 0o111, 0o111);
    const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
    assert.match(zshenv, /PROFILEPILOT_SESSION="\$AGENT_BROWSER_SESSION"/);
    assert.match(zshenv, /-d "\$PROFILEPILOT_AGENT_BROWSER_BIN_DIR"/);
    assert.match(zshenv, /export PATH="\$PROFILEPILOT_AGENT_BROWSER_BIN_DIR:\$PATH"/);

    const childOutput = execFileSync("/bin/sh", ["-c", "agent-browser version"], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${path.dirname(agentWrapper.launcherPath)}:/usr/bin:/bin`,
        AGENT_BROWSER_SESSION: "cx-child-shell",
        PROFILEPILOT_AGENT_BROWSER_WRAPPER: agentWrapper.wrapperPath,
        PROFILEPILOT_AGENT_BROWSER_LAUNCHER: agentWrapper.launcherPath,
        PROFILEPILOT_NODE_RUNTIME: process.execPath,
        PROFILEPILOT_AGENT_BROWSER_REAL: fakeAgentBrowser
      }
    });
    assert.equal(childOutput.trim(), "child-shell-ok");

    diagnostic = await shell.setAgentWrapperEnabled("agent-browser", false);
    assert.equal(fs.existsSync(agentWrapper.wrapperPath), false);
    assert.equal(fs.existsSync(agentWrapper.launcherPath), false);
    assert.equal(diagnostic.shellIntegration.installed, false, "last Wrapper removal also removes the managed shell route");
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Wrapper installation is blocked until the corresponding real CLI is installed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-wrapper-prerequisite-"));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = path.join(home, "empty-bin");
  fs.mkdirSync(process.env.PATH, { recursive: true });
  try {
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const { setAgentWrapperEnabled } = require(modulePath);
    await assert.rejects(
      () => setAgentWrapperEnabled("playwright-cli", true),
      (error) => error.code === "AGENT_TOOL_REQUIRED"
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ProfilePilot management CLI and its Skill install independently from browser Wrappers", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-management-cli-install-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const shell = require(modulePath);

    let diagnostic = await shell.inspectAgentIntegration();
    assert.equal(diagnostic.managementCli.installed, false);
    assert.equal(diagnostic.managementCli.skill.installed, false);

    await assert.rejects(
      () => shell.setProfilePilotCliSkillEnabled(true),
      (error) => error.code === "PROFILEPILOT_CLI_REQUIRED"
    );

    diagnostic = await shell.setProfilePilotCliEnabled(true);
    assert.equal(diagnostic.managementCli.installed, true);
    assert.equal(diagnostic.managementCli.upToDate, true);
    assert.ok(diagnostic.wrappers.every((wrapper) => !wrapper.wrapperInstalled && !wrapper.launcherInstalled));
    assert.equal(diagnostic.shellIntegration.installed, true);
    assert.equal(
      execFileSync(diagnostic.managementCli.launcherPath, ["--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: "/usr/bin:/bin", PROFILEPILOT_NODE_RUNTIME: process.execPath }
      }).trim(),
      "0.1.0"
    );

    const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
    assert.match(zshenv, /PROFILEPILOT_MANAGEMENT_CLI_BIN_DIR/);
    assert.match(zshenv, /-x "\$PROFILEPILOT_MANAGEMENT_CLI"/);
    assert.match(zshenv, /export PATH="\$PROFILEPILOT_MANAGEMENT_CLI_BIN_DIR:\$PATH"/);

    diagnostic = await shell.setProfilePilotCliSkillEnabled(true);
    assert.equal(diagnostic.managementCli.skill.installed, true);
    assert.equal(diagnostic.managementCli.skill.managedTargetCount, 3);

    fs.writeFileSync(diagnostic.managementCli.bundlePath, "stale cli", "utf8");
    assert.equal(await shell.refreshAgentBrowserWrapperIfInstalled(), true);
    assert.match(fs.readFileSync(diagnostic.managementCli.bundlePath, "utf8"), /PROFILEPILOT_CLI_VERSION/);

    diagnostic = await shell.setProfilePilotCliEnabled(false);
    assert.equal(diagnostic.managementCli.installed, false);
    assert.equal(diagnostic.managementCli.skill.installed, true, "Skill is a separate installation dimension");
    assert.equal(diagnostic.shellIntegration.installed, false);

    diagnostic = await shell.setProfilePilotCliSkillEnabled(false);
    assert.equal(diagnostic.managementCli.skill.installedTargetCount, 0);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("agent integration diagnostics do not treat npx as an installed MCP tool", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-tool-diagnostic-"));
  const bin = path.join(home, "bin");
  const keys = [
    "HOME",
    "PATH",
    "PROFILEPILOT_AGENT_BROWSER_REAL",
    "PROFILEPILOT_PLAYWRIGHT_CLI_REAL",
    "PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL",
    "PROFILEPILOT_CHROME_DEVTOOLS_MCP_NPX"
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  fs.mkdirSync(bin, { recursive: true });
  executable(path.join(bin, "npx"), "npx-should-not-count");

  try {
    process.env.HOME = home;
    process.env.PATH = bin;
    delete process.env.PROFILEPILOT_AGENT_BROWSER_REAL;
    delete process.env.PROFILEPILOT_PLAYWRIGHT_CLI_REAL;
    delete process.env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL;
    delete process.env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_NPX;
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const { inspectAgentIntegration } = require(modulePath);
    const diagnostic = await inspectAgentIntegration();

    assert.equal(diagnostic.ready, false);
    assert.deepEqual(
      diagnostic.tools.map((tool) => [tool.key, tool.availability]),
      [
        ["agent-browser", "missing"],
        ["playwright-cli", "missing"],
        ["chrome-devtools-mcp", "missing"]
      ]
    );
    assert.equal(diagnostic.tools[2].executablePath, null);
    assert.equal(diagnostic.skills.length, 3);
    assert.match(diagnostic.tools[0].installCommand, /npm install -g agent-browser/);
    assert.match(diagnostic.tools[1].installCommand, /@playwright\/cli/);
    assert.match(diagnostic.tools[2].installCommand, /chrome-devtools-mcp/);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function executable(filePath, output) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}
