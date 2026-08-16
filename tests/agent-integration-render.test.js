const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadRenderer(inputGuard, overrides = {}) {
  const store = {
    state: {
      shellIntegration: { supported: true, installed: false, managed: false, path: "~/.zshenv", error: null }
    },
    agentIntegrationDiagnostic: {
      inspectedAt: "2026-08-16T00:00:00.000Z",
      ready: false,
      shellIntegration: { supported: true, installed: false, managed: false, path: "~/.zshenv", error: null },
      wrapperDirectory: "~/.profilepilot/bin",
      tools: [],
      wrappers: [],
      skills: [],
      inputGuard
    },
    agentIntegrationLoading: false,
    inputGuardPermissionLoading: false,
    busy: false,
    ...overrides
  };
  const renderer = loadTsModule("src/renderer/render/agent-integration.ts", {
    stubs: {
      "../state": { store },
      "../util": {
        escapeHtml: (value) => String(value)
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;"),
        renderButtonLabel: (loading, idle, active) => loading ? active : idle
      }
    }
  });
  return { renderer, store };
}

test("onboarding directs a denied macOS Input Guard permission to explicit user actions", () => {
  const { renderer } = loadRenderer({
    supported: true,
    granted: false,
    appName: "ProfilePilot Input Guard",
    appPath: "/Users/test/Applications/ProfilePilot Input Guard.app",
    inspectedAt: "2026-08-16T00:00:00.000Z",
    error: null
  });
  const html = renderer.renderOnboardingModal();

  assert.match(html, /等待辅助功能授权/);
  assert.match(html, /不授权不影响 Profile 管理和 Agent 连接/);
  assert.match(html, /授权对象：<code>ProfilePilot Input Guard<\/code>/);
  assert.match(html, /不读取键盘输入/);
  assert.match(html, /data-action="request-input-guard-permission"/);
  assert.match(html, /data-action="open-input-guard-settings"/);
  assert.match(html, /data-action="refresh-agent-integration"/);
});

test("onboarding shows a completed Input Guard safety checkpoint without another prompt", () => {
  const { renderer } = loadRenderer({
    supported: true,
    granted: true,
    appName: "ProfilePilot Input Guard",
    appPath: "/Users/test/Applications/ProfilePilot Input Guard.app",
    inspectedAt: "2026-08-16T00:00:00.000Z",
    error: null
  });
  const html = renderer.renderOnboardingModal();

  assert.match(html, /点击保护已授权/);
  assert.match(html, /PROTECTED/);
  assert.doesNotMatch(html, /data-action="request-input-guard-permission"/);
  assert.doesNotMatch(html, /data-action="open-input-guard-settings"/);
});

test("onboarding skips the macOS-only Input Guard checkpoint on other platforms", () => {
  const { renderer } = loadRenderer({
    supported: false,
    granted: true,
    appName: "ProfilePilot Input Guard",
    appPath: null,
    inspectedAt: "2026-08-16T00:00:00.000Z",
    error: null
  });
  const html = renderer.renderOnboardingModal();

  assert.match(html, /当前系统无需授权/);
  assert.match(html, /NOT REQUIRED/);
  assert.doesNotMatch(html, /data-action="request-input-guard-permission"/);
});

test("tool setup cards keep real CLI, Wrapper, and Skill as independent ordered stages", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({
    tools: [
      tool("agent-browser", "installed", "agent-browser 0.27.2"),
      tool("playwright-cli", "missing", null),
      tool("chrome-devtools-mcp", "missing", null)
    ],
    wrappers: [
      wrapper("agent-browser", true),
      wrapper("playwright-cli", false),
      wrapper("chrome-devtools-mcp", false)
    ],
    skills: [
      skill("agent-browser", true, false),
      skill("playwright-cli", false, false),
      skill("chrome-devtools-mcp", false, false)
    ],
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationModal([]);

  assert.match(html, /真实 CLI → Wrapper → Skill/);
  assert.match(html, /01[\s\S]*真实工具/);
  assert.match(html, /02[\s\S]*Wrapper/);
  assert.match(html, /03[\s\S]*配套 Skill/);
  assert.match(html, /agent-browser-cdp/);
  assert.match(html, /已安装 · 外部管理/);
  assert.match(html, /data-action="install-agent-wrapper" data-tool="playwright-cli" disabled/);
  assert.match(html, /data-action="copy-agent-command"[^>]+@playwright\/cli/);
  assert.doesNotMatch(html, /npx 按需|可按需运行|生成连接命令|PROFILE ROUTE/);
});

test("an installed CLI exposes only its own Wrapper action and does not enable all tools", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({
    tools: [
      tool("agent-browser", "missing", null),
      tool("playwright-cli", "installed", "0.1.14"),
      tool("chrome-devtools-mcp", "missing", null)
    ],
    wrappers: [wrapper("agent-browser", false), wrapper("playwright-cli", false), wrapper("chrome-devtools-mcp", false)],
    skills: [skill("agent-browser", false), skill("playwright-cli", false), skill("chrome-devtools-mcp", false)],
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationModal([]);

  assert.match(html, /data-action="install-agent-wrapper" data-tool="playwright-cli" >/);
  assert.match(html, /data-action="install-agent-wrapper" data-tool="agent-browser" disabled/);
  assert.match(html, /data-action="install-agent-wrapper" data-tool="chrome-devtools-mcp" disabled/);
  assert.doesNotMatch(html, /启用三套|三套 Wrapper|共享接入层/);
});

test("ProfilePilot management CLI and management Skill have their own independent setup card", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({
    managementCli: managementCli(true, false),
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationModal([]);

  assert.match(html, /PROFILE MANAGEMENT CLI/);
  assert.match(html, /让 Agent 管理 Profile/);
  assert.match(html, /profilepilot profile list --json/);
  assert.match(html, /data-action="install-profilepilot-cli"/);
  assert.match(html, /data-action="remove-profilepilot-cli"/);
  assert.match(html, /data-action="install-profilepilot-cli-skill" >/);
  assert.match(html, /删除必须显式添加 <code>--yes<\/code>/);
});

function permission(supported, granted) {
  return {
    supported,
    granted,
    appName: "ProfilePilot Input Guard",
    appPath: supported ? "/Applications/ProfilePilot Input Guard.app" : null,
    inspectedAt: "2026-08-16T00:00:00.000Z",
    error: null
  };
}

function diagnosticWith(overrides) {
  return {
    inspectedAt: "2026-08-16T00:00:00.000Z",
    ready: false,
    shellIntegration: { supported: true, installed: true, managed: true, path: "~/.zshenv", error: null },
    wrapperDirectory: "~/.profilepilot/bin",
    tools: [],
    wrappers: [],
    skills: [],
    inputGuard: permission(false, true),
    ...overrides
  };
}

function tool(key, availability, version) {
  const label = key === "agent-browser" ? "agent-browser" : key === "playwright-cli" ? "Playwright CLI" : "Chrome DevTools MCP";
  return {
    key,
    label,
    availability,
    executablePath: availability === "installed" ? `/usr/local/bin/${key}` : null,
    version,
    source: availability === "installed" ? "binary" : null,
    installCommand: key === "agent-browser"
      ? "npm install -g agent-browser"
      : key === "playwright-cli"
        ? "npm install -g @playwright/cli@latest"
        : "npm install -g chrome-devtools-mcp@latest",
    verifyCommand: `${key} --version`,
    error: null
  };
}

function wrapper(key, installed) {
  return {
    key,
    label: key,
    wrapperPath: `~/.profilepilot/bin/${key}.cjs`,
    launcherPath: `~/.profilepilot/bin/${key}`,
    wrapperInstalled: installed,
    launcherInstalled: installed
  };
}

function skill(key, installed, managed = true) {
  const skillId = key === "agent-browser"
    ? "agent-browser-cdp"
    : key === "playwright-cli"
      ? "playwright-cli-profilepilot"
      : "chrome-devtools-mcp-profilepilot";
  return {
    key,
    label: skillId,
    skillId,
    installed,
    managed: installed && managed,
    upToDate: installed,
    installedTargetCount: installed ? 3 : 0,
    managedTargetCount: installed && managed ? 3 : 0,
    targetCount: 3,
    installPath: `~/.agents/skills/${skillId}`,
    targets: [],
    error: null
  };
}

function managementCli(installed, skillInstalled) {
  return {
    installed,
    bundleInstalled: installed,
    launcherInstalled: installed,
    upToDate: installed,
    bundlePath: "~/.profilepilot/cli/profilepilot-cli.cjs",
    launcherPath: "~/.profilepilot/cli-bin/profilepilot",
    skill: {
      key: "profilepilot-cli",
      label: "ProfilePilot Profile Management",
      skillId: "profilepilot-cli",
      installed: skillInstalled,
      managed: skillInstalled,
      upToDate: skillInstalled,
      installedTargetCount: skillInstalled ? 3 : 0,
      managedTargetCount: skillInstalled ? 3 : 0,
      targetCount: 3,
      installPath: "~/.agents/skills/profilepilot-cli",
      targets: [],
      error: null
    },
    error: null
  };
}
