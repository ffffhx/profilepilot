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

test("one visible setup action keeps the CLI card compact without expandable details", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({
    managementCli: managementCli(true, false),
    inputGuard
  });
  const { renderer } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  const html = renderer.renderAgentIntegrationPanel();

  assert.match(html, /id="management-cli-title">ProfilePilot CLI/);
  assert.match(html, /<section id="tools-cli-card"/);
  assert.equal((html.match(/data-action="install-profilepilot-cli"/g) || []).length, 1);
  assert.doesNotMatch(html, /tools-cli-details|tools-guide-details|tools-gateway-details|agent-tool-grid|ppilot browser --cdp|ppilot profile list/);
  assert.doesNotMatch(html, /data-action="(?:remove-profilepilot-cli|install-agent-wrapper|install-agent-skill)"/);
});

test("stale instructions require a unified update even when the executable is current", () => {
  const inputGuard = permission(false, true);
  const diagnostic = diagnosticWith({ managementCli: managementCli(true, true), skills: [skill("profilepilot", true)], inputGuard });
  const { renderer, store } = loadRenderer(inputGuard, { agentIntegrationDiagnostic: diagnostic });
  let html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /id="management-cli-title">ProfilePilot CLI<\/strong><em>已就绪<\/em>/);
  store.agentIntegrationDiagnostic.skills = [{ ...skill("profilepilot", true), upToDate: false }];
  html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /更新 ProfilePilot CLI/);
  assert.doesNotMatch(html, /<em>已就绪<\/em>/);
});

test("tools cards do not claim readiness before diagnostics arrive", () => {
  const { renderer } = loadRenderer(null, {
    state: null,
    agentIntegrationDiagnostic: null,
    agentIntegrationLoading: true,
    nativeExtensionBrowsers: []
  });
  const html = renderer.renderAgentIntegrationPanel();
  assert.doesNotMatch(html, /tools-status-summary/);
  assert.match(html, /class="browser-extension-panel pending"/);
  assert.match(html, /class="tools-overview-card tools-cli-card pending"/);
  assert.match(html, /正在读取系统 Chrome Profile/);
  assert.doesNotMatch(html, /已就绪|已安装/);
});

test("tools cards follow the selected Profile and report stale installations", () => {
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
  let html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /尚未连接/);
  assert.equal((html.match(/需要更新/g) || []).length, 1);
  assert.doesNotMatch(html, /class="browser-extension-panel ready"|已就绪/);

  store.nativeExtensionProfileId = "other";
  html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /已连接 · 可使用当前页/);
  assert.match(html, /class="browser-extension-panel ready"/);

  store.nativeExtensionLoading = true;
  html = renderer.renderAgentIntegrationPanel();
  assert.match(html, /检测中…/);
  assert.doesNotMatch(html, /class="browser-extension-panel ready"/);
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
  assert.match(html, /data-action="enable-shell-integration"/);
  assert.match(html, /Windows 用户 PATH/);
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
