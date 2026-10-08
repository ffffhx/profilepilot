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

test("tool setup cards share one Skill installation while keeping their own CLI and Wrapper", () => {
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
    skills: [skill("profilepilot", true, false)],
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationPanel();

  assert.match(html, /使用 ppilot browser CLI 无需配置此处/);
  assert.match(html, /01[\s\S]*真实工具/);
  assert.match(html, /02[\s\S]*Wrapper/);
  assert.equal((html.match(/id="tools-guide-details"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-action="install-agent-skill"|agent-browser-cdp/);
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
    skills: [skill("profilepilot", false)],
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationPanel();

  assert.match(html, /data-action="install-agent-wrapper" data-tool="playwright-cli" >/);
  assert.match(html, /data-action="install-agent-wrapper" data-tool="agent-browser" disabled/);
  assert.match(html, /data-action="install-agent-wrapper" data-tool="chrome-devtools-mcp" disabled/);
  assert.doesNotMatch(html, /启用三套|三套 Wrapper|共享接入层/);
});

test("one visible setup action includes CLI and Agent instructions in expandable details", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({
    managementCli: managementCli(true, false),
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationPanel();

  assert.match(html, /id="management-cli-title">ProfilePilot CLI/);
  assert.match(html, /ppilot browser --cdp PORT snapshot -i/);
  assert.match(html, /ppilot profile list --json/);
  assert.match(html, /data-action="install-profilepilot-cli"/);
  assert.match(html, /data-action="remove-profilepilot-cli"/);
  assert.equal((html.match(/data-action="install-profilepilot-cli"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-action="(?:install|remove)-profilepilot-cli-skill"|id="tools-skill-details"/);
  assert.match(html, /Agent 使用指引（随 CLI 安装）/);
  assert.match(html, /删除必须显式添加 <code>--yes<\/code>/);
});

test("stale instructions require a unified update even when the executable is current", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({ managementCli: managementCli(true, true), skills: [skill("profilepilot", true)], inputGuard });
  const { renderer, store } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  let html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /ProfilePilot CLI 已就绪/);
  store.agentIntegrationDiagnostic.skills = [{ ...skill("profilepilot", true), upToDate: false }];
  html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /更新 ProfilePilot CLI/);
  assert.doesNotMatch(html, /ProfilePilot CLI 已就绪/);
  assert.match(html, /local\/browser-routing.md/);
  assert.match(html, /ppilot browser status/);
});

test("tools status overview does not claim readiness before diagnostics arrive", () => {
  const { renderer } = loadRenderer(null, {
    state: null,
    agentIntegrationDiagnostic: null,
    agentIntegrationLoading: true,
    nativeExtensionBrowsers: []
  });
  const html = renderer.renderAgentIntegrationPanel();
  const summary = html.match(/<section class="tools-status-summary"[\s\S]*?<\/section>/)[0];

  assert.equal((summary.match(/class="tools-status-item pending"/g) || []).length, 2);
  assert.match(summary, /正在读取系统 Chrome Profile/);
  assert.doesNotMatch(summary, /class="tools-status-item ready"|已就绪|已安装/);
});

test("tools overview follows the selected Profile and reports stale installations", () => {
  const inputGuard = permission(false, true);
  const { renderer, store } = loadRenderer(inputGuard, {
    state: { profiles: [
      { id: "work", name: "工作 Profile", dirName: "Profile 1", source: "native" },
      { id: "other", name: "另一 Profile", dirName: "Profile 2", source: "native" }
    ] },
    nativeExtensionProfileId: "work",
    nativeExtensionBrowsers: [{ profileId: "other", connected: true, taskTabs: true }],
    agentIntegrationDiagnostic: diagnosticWith({
      skills: [{ ...skill("profilepilot", true), upToDate: false }],
      managementCli: { ...managementCli(true, true), upToDate: false },
      inputGuard
    })
  });
  const overview = () => renderer.renderAgentIntegrationPanel().match(/<section class="tools-status-summary"[\s\S]*?<\/section>/)[0];

  let summary = overview();
  assert.match(summary, /尚未连接/);
  assert.equal((summary.match(/需要更新/g) || []).length, 1);
  assert.doesNotMatch(summary, /class="tools-status-item ready"|已就绪/);

  store.nativeExtensionProfileId = "other";
  summary = overview();
  assert.match(summary, /已连接 · 可使用当前页/);
  assert.equal((summary.match(/class="tools-status-item ready"/g) || []).length, 1);

  store.nativeExtensionLoading = true;
  summary = overview();
  assert.match(summary, /检测中…/);
  assert.doesNotMatch(summary, /class="tools-status-item ready"/);
});

test("a complete tool installation with a missing session bridge exposes the repair step", () => {
  const inputGuard = permission(false, true);
  const { renderer } = loadRenderer(inputGuard, {
    agentIntegrationDiagnostic: diagnosticWith({
      tools: [tool("agent-browser", "installed", "1.0.0")],
      wrappers: [wrapper("agent-browser", true)],
      skills: [skill("profilepilot", true)],
      shellIntegration: { supported: true, installed: false, managed: false, path: "Windows 用户 PATH", error: null },
      inputGuard
    })
  });
  const html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /待修复会话/);
  assert.match(html, /下一步：修复会话识别/);
  assert.match(html, /data-action="enable-shell-integration"/);
  assert.match(html, /Windows 用户 PATH/);
});

test("tools overview has one CLI card and optional compatibility and preference details", () => {
  const { renderer } = loadRenderer(permission(false, true));
  const html = renderer.renderAgentIntegrationPanel();
  const cards = [...html.matchAll(/<details id="(tools-[^"]+)" class="tools-overview-card[^>]*>/g)];
  assert.deepEqual(cards.map(match => match[1]), [
    "tools-cli-details", "tools-gateway-details", "tools-control-preferences"
  ]);
  for (const [markup] of cards) assert.doesNotMatch(markup, /\sopen(?:\s|=|>)/);
  const gateway = html.slice(html.indexOf('id="tools-gateway-details"'), html.indexOf('id="tools-control-preferences"'));
  assert.match(gateway, /<summary[\s\S]*?查看配置[\s\S]*?<\/summary>[\s\S]*?agent-tool-grid/);
  assert.match(html, /id="tools-connection-diagnostics"[\s\S]*?查看连接诊断/);
  assert.match(html, /data-action="open-control-preferences" disabled/);
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
  const skillId = "profilepilot";
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
      key: "profilepilot",
      label: "ProfilePilot",
      skillId: "profilepilot",
      installed: skillInstalled,
      managed: skillInstalled,
      upToDate: skillInstalled,
      installedTargetCount: skillInstalled ? 3 : 0,
      managedTargetCount: skillInstalled ? 3 : 0,
      targetCount: 3,
      installPath: "~/.agents/skills/profilepilot",
      targets: [],
      error: null
    },
    error: null
  };
}
