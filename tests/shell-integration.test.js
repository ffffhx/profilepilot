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
    "PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL",
    "PROFILEPILOT_TEST_WINDOWS_USER_PATH"
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const fakeAgentBrowser = executable(path.join(home, "fake-agent-browser"), "child-shell-ok");
  const fakePlaywrightCli = executable(path.join(home, "fake-playwright-cli"), "playwright-shell-ok");
  const fakeChromeDevtoolsMcp = executable(path.join(home, "fake-chrome-devtools-mcp"), "mcp-shell-ok");
  process.env.HOME = home;
  process.env.PROFILEPILOT_AGENT_BROWSER_REAL = fakeAgentBrowser;
  process.env.PROFILEPILOT_PLAYWRIGHT_CLI_REAL = fakePlaywrightCli;
  process.env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL = fakeChromeDevtoolsMcp;
  if (process.platform === "win32") process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = "";

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
    assert.equal(diagnostic.ready, false, "a legacy Wrapper does not install the unified CLI");

    diagnostic = await shell.setAgentSkillEnabled("agent-browser", true);
    assert.equal(diagnostic.skills.find((item) => item.key === "profilepilot").installed, true);
    assert.equal(diagnostic.ready, false, "legacy tool compatibility must not mask an incomplete unified setup");

    fs.writeFileSync(agentWrapper.wrapperPath, "stale wrapper", "utf8");
    assert.equal(await shell.refreshAgentBrowserWrapperIfInstalled(), true);
    const wrapper = fs.readFileSync(agentWrapper.wrapperPath, "utf8");
    assert.match(wrapper, /AGENT_CONTROL_RETURNED/);
    assert.match(wrapper, /GATEWAY_PROFILE_NOT_CONFIGURED/);
    assert.doesNotMatch(wrapper, /require\(["']\.\//, "installed wrapper must be self-contained");
    assert.ok(otherWrappers.every((item) => !fs.existsSync(item.wrapperPath) && !fs.existsSync(item.launcherPath)));

    const launcher = fs.readFileSync(agentWrapper.launcherPath, "utf8");
    assert.match(launcher, process.platform === "win32" ? /^@echo off/ : /^#!\/bin\/sh/);
    assert.match(launcher, process.platform === "win32" ? /set ELECTRON_RUN_AS_NODE=1/ : /ELECTRON_RUN_AS_NODE=1 exec/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(agentWrapper.launcherPath).mode & 0o111, 0o111);
      const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
      assert.match(zshenv, /PROFILEPILOT_SESSION="\$AGENT_BROWSER_SESSION"/);
      assert.match(zshenv, /-d "\$PROFILEPILOT_AGENT_BROWSER_BIN_DIR"/);
      assert.match(zshenv, /export PATH="\$PROFILEPILOT_AGENT_BROWSER_BIN_DIR:\$PATH"/);
    } else {
      assert.match(process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH, /\.profilepilot\\bin/i);
    }

    const { execPortableCommandSync } = require("../dist/main/portable-command.js");
    const childOutput = execPortableCommandSync(agentWrapper.launcherPath, ["version"], {
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

test("ProfilePilot CLI installs, updates and removes its bundled instructions together", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-management-cli-install-"));
  const originalHome = process.env.HOME;
  const originalWindowsUserPath = process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
  process.env.HOME = home;
  if (process.platform === "win32") process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = "";
  try {
    const modulePath = require.resolve("../dist/main/shell-integration.js");
    delete require.cache[modulePath];
    const shell = require(modulePath);

    let diagnostic = await shell.inspectAgentIntegration();
    assert.equal(diagnostic.managementCli.installed, false);
    assert.equal(diagnostic.managementCli.skill.installed, false);

    diagnostic = await shell.setProfilePilotCliEnabled(true);
    assert.equal(diagnostic.skills.length, 1);
    assert.equal(diagnostic.managementCli.skill.installed, true, "one setup installs the Agent instructions too");
    assert.equal(diagnostic.managementCli.installed, true);
    assert.equal(diagnostic.managementCli.upToDate, true);
    assert.equal(diagnostic.ready, true, "the unified CLI is ready without external browser Wrappers");
    const targets = diagnostic.managementCli.skill.targets;
    for (const target of targets) {
      fs.mkdirSync(path.join(target.path, "local"), { recursive: true });
      fs.writeFileSync(path.join(target.path, "local/browser-routing.md"), "keep my chosen Profile", "utf8");
    }
    // An old CLI-only installation and a stale guide are repaired by the same
    // startup refresh, without changing the user's local routing.
    fs.unlinkSync(path.join(targets[0].path, "SKILL.md"));
    fs.writeFileSync(path.join(targets[1].path, "references/agent-browser.md"), "old commands", "utf8");
    assert.equal((await shell.inspectAgentIntegration()).ready, false);
    await shell.refreshAgentBrowserWrapperIfInstalled();
    assert.equal((await shell.inspectAgentIntegration()).managementCli.skill.upToDate, true);
    for (const target of targets) assert.equal(fs.readFileSync(path.join(target.path, "local/browser-routing.md"), "utf8"), "keep my chosen Profile");
    const backups = path.join(home, ".profilepilot/skill-backups");
    const backupCount = fs.readdirSync(backups).length;
    await shell.refreshAgentBrowserWrapperIfInstalled();
    assert.equal(fs.readdirSync(backups).length, backupCount, "identical guides are not archived on every app launch");
    const browserManifest = path.join(path.dirname(diagnostic.managementCli.bundlePath), "browser-runtime.json");
    assert.ok(fs.existsSync(JSON.parse(fs.readFileSync(browserManifest, "utf8")).executable));
    const browserVersion = execFileSync(process.execPath, [diagnostic.managementCli.bundlePath, "browser", "--connection", "gateway", "--version"], {
      encoding: "utf8", env: { ...process.env, HOME: home, PATH: path.join(home, "empty-bin"), PROFILEPILOT_AGENT_BROWSER_REAL: "missing-global-driver" }
    });
    assert.match(browserVersion, /agent-browser/);
    fs.unlinkSync(browserManifest);
    assert.equal((await shell.inspectProfilePilotCli()).upToDate, false);
    await shell.refreshAgentBrowserWrapperIfInstalled();
    assert.equal((await shell.inspectProfilePilotCli()).upToDate, true);
    assert.equal(path.basename(diagnostic.managementCli.launcherPath), process.platform === "win32" ? "ppilot.cmd" : "ppilot");
    const legacyLauncher = path.join(path.dirname(diagnostic.managementCli.launcherPath), process.platform === "win32" ? "profilepilot.cmd" : "profilepilot");
    assert.equal(fs.existsSync(legacyLauncher), true);
    assert.ok(diagnostic.wrappers.every((wrapper) => !wrapper.wrapperInstalled && !wrapper.launcherInstalled));
    assert.equal(diagnostic.shellIntegration.installed, true);
    assert.equal(
      require("../dist/main/portable-command.js").execPortableCommandSync(diagnostic.managementCli.launcherPath, ["--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: "/usr/bin:/bin", PROFILEPILOT_NODE_RUNTIME: process.execPath }
      }).trim(),
      "0.1.0"
    );

    if (process.platform !== "win32") {
      const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
      assert.match(zshenv, /PROFILEPILOT_MANAGEMENT_CLI_BIN_DIR/);
      assert.match(zshenv, /-x "\$PROFILEPILOT_MANAGEMENT_CLI"/);
      assert.match(zshenv, /export PATH="\$PROFILEPILOT_MANAGEMENT_CLI_BIN_DIR:\$PATH"/);
    } else {
      assert.match(process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH, /\.profilepilot\\cli-bin/i);
      const powershellLauncher = path.join(path.dirname(diagnostic.managementCli.launcherPath), "ppilot.ps1");
      assert.equal(fs.existsSync(powershellLauncher), true);
      assert.equal(fs.existsSync(path.join(path.dirname(powershellLauncher), "profilepilot.ps1")), true);
      fs.unlinkSync(powershellLauncher);
      assert.equal((await shell.inspectProfilePilotCli()).upToDate, false, "older Windows installations need the PowerShell entry");
      await shell.refreshAgentBrowserWrapperIfInstalled();
      assert.equal((await shell.inspectProfilePilotCli()).upToDate, true);
    }

    diagnostic = await shell.setProfilePilotCliSkillEnabled(true);
    assert.equal(diagnostic.managementCli.skill.installed, true);
    assert.equal(diagnostic.managementCli.skill.managedTargetCount, 3);

    fs.writeFileSync(diagnostic.managementCli.bundlePath, "stale cli", "utf8");
    fs.unlinkSync(diagnostic.managementCli.launcherPath);
    assert.equal((await shell.inspectProfilePilotCli()).installed, false);
    assert.equal(await shell.refreshAgentBrowserWrapperIfInstalled(), true);
    assert.equal((await shell.inspectProfilePilotCli()).installed, true, "an existing installation gains ppilot during automatic refresh");
    assert.match(fs.readFileSync(diagnostic.managementCli.bundlePath, "utf8"), /PROFILEPILOT_CLI_VERSION/);

    diagnostic = await shell.setProfilePilotCliEnabled(false);
    assert.equal(diagnostic.managementCli.installed, false);
    assert.equal(fs.existsSync(legacyLauncher), false);
    if (process.platform === "win32") {
      assert.equal(fs.existsSync(path.join(path.dirname(legacyLauncher), "ppilot.ps1")), false);
      assert.equal(fs.existsSync(path.join(path.dirname(legacyLauncher), "profilepilot.ps1")), false);
    }
    assert.equal(diagnostic.managementCli.skill.installed, false, "removal includes managed instructions");
    for (const target of targets) assert.equal(fs.readFileSync(path.join(target.path, "local/browser-routing.md"), "utf8"), "keep my chosen Profile");
    assert.equal(diagnostic.shellIntegration.installed, false);

    diagnostic = await shell.setProfilePilotCliSkillEnabled(true);
    assert.equal(diagnostic.managementCli.installed, true, "legacy Skill setup redirects to the unified installer");
    assert.equal(diagnostic.managementCli.skill.upToDate, true);
    diagnostic = await shell.setProfilePilotCliSkillEnabled(false);
    assert.equal(diagnostic.managementCli.skill.installedTargetCount, 0);
    assert.equal(diagnostic.managementCli.installed, false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalWindowsUserPath === undefined) delete process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
    else process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = originalWindowsUserPath;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("unified setup recovers a failed guide update and preserves external guides on removal", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-cli-repair-"));
  const originalHome = process.env.HOME;
  const originalWindowsUserPath = process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
  process.env.HOME = home;
  if (process.platform === "win32") process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = "";
  try {
    delete require.cache[require.resolve("../dist/main/shell-integration.js")];
    const shell = require("../dist/main/shell-integration.js");
    let diagnostic = await shell.setProfilePilotCliEnabled(true);
    const target = diagnostic.managementCli.skill.targets[0].path;
    const guide = path.join(target, "references/agent-browser.md");
    fs.writeFileSync(guide, "previous release");
    const rename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      if (String(from).includes(".profilepilot-tmp-") && to === target) throw new Error("guide update failed");
      return rename(from, to);
    };
    try { await assert.rejects(shell.setProfilePilotCliEnabled(true), /guide update failed/); }
    finally { fs.promises.rename = rename; }
    diagnostic = await shell.inspectAgentIntegration();
    assert.equal(diagnostic.managementCli.installed, true);
    assert.equal(diagnostic.ready, false);
    assert.equal(fs.readFileSync(guide, "utf8"), "previous release");
    diagnostic = await shell.setProfilePilotCliEnabled(true);
    assert.equal(diagnostic.ready, true);

    fs.unlinkSync(path.join(target, ".profilepilot-managed.json"));
    fs.writeFileSync(path.join(target, "SKILL.md"), "external owner instructions");
    diagnostic = await shell.setProfilePilotCliEnabled(true);
    assert.equal(diagnostic.managementCli.installed, true);
    assert.equal(diagnostic.ready, false, "different external instructions cannot count as synchronized");
    assert.equal(diagnostic.managementCli.skill.targets[0].managed, false);
    await shell.setProfilePilotCliEnabled(false);
    assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "external owner instructions");
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalWindowsUserPath === undefined) delete process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
    else process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = originalWindowsUserPath;
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
    assert.equal(diagnostic.skills.length, 1);
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
  if (process.platform === "win32") {
    filePath += ".cmd";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    process.platform === "win32" ? `@echo off\r\necho ${output}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
    "utf8"
  );
  fs.chmodSync(filePath, 0o755);
  return filePath;
}
