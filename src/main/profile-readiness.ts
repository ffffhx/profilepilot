import type {
  BifrostSnapshot,
  CanonicalSessionIdentity,
  ProfileExtensionInfo,
  ProfileReadinessCheck,
  ProfileReadinessExpectation,
  ProfileReadinessReceipt,
  PublicProfile
} from "../shared/types";

export interface BuildProfileReadinessInput {
  profile: PublicProfile;
  expectation?: ProfileReadinessExpectation;
  proxySnapshot: BifrostSnapshot | null;
  extensions?: ProfileExtensionInfo[];
  sessionIdentity?: CanonicalSessionIdentity | null;
}

export function buildProfileReadinessReceipt(input: BuildProfileReadinessInput): ProfileReadinessReceipt {
  const expectation = normalizeExpectation(input.profile, input.expectation);
  const checks: ProfileReadinessCheck[] = [
    runningCheck(input.profile, expectation),
    cdpCheck(input.profile, expectation),
    agentAccessCheck(input.profile),
    proxyCheck(input.profile, input.proxySnapshot, expectation),
    routeCheck(input.profile, expectation),
    loginCheck(input.profile, expectation),
    extensionCheck(input.extensions, expectation),
    ownershipCheck(input.profile, expectation),
    foregroundCheck(input.profile, expectation),
    sessionCheck(input.profile, input.sessionIdentity)
  ];
  const failed = checks.filter((check) => check.status === "fail");
  const unknown = checks.filter((check) => check.status === "unknown");
  const overall = failed.length ? "blocked" : unknown.some((check) => check.required) ? "degraded" : "ready";
  const generatedAt = new Date().toISOString();

  return {
    version: 1,
    receiptId: `${input.profile.id}:${generatedAt}`,
    generatedAt,
    overall,
    target: {
      profileId: input.profile.id,
      profileName: input.profile.name,
      expectedLogicalPort: expectation.expectedLogicalPort ?? null,
      expectedProxyKind: expectation.expectedProxyKind ?? null,
      expectedTargetUrl: expectation.expectedTargetUrlIncludes ?? null,
      expectedLogin: expectation.expectedLoginLabel ?? null
    },
    checks,
    blockerCodes: failed.map((check) => check.code),
    unknownCodes: unknown.map((check) => check.code),
    sessionIdentity: input.sessionIdentity || null
  };
}

function normalizeExpectation(
  profile: PublicProfile,
  expectation: ProfileReadinessExpectation | undefined
): Required<Pick<
  ProfileReadinessExpectation,
  "requireRunning" | "requireCdp" | "requireAgentControl" | "requireForeground" | "requireBrowserAccount"
>> & ProfileReadinessExpectation {
  return {
    requireRunning: expectation?.requireRunning !== false,
    requireCdp: expectation?.requireCdp ?? profile.source !== "native",
    requireAgentControl: expectation?.requireAgentControl === true,
    requireForeground: expectation?.requireForeground === true,
    requireBrowserAccount: expectation?.requireBrowserAccount === true,
    ...expectation
  };
}

function runningCheck(profile: PublicProfile, expectation: ProfileReadinessExpectation): ProfileReadinessCheck {
  const passed = profile.running;
  return check({
    id: "runtime",
    code: passed ? "PROFILE_RUNNING" : "PROFILE_NOT_RUNNING",
    label: "浏览器进程",
    status: passed ? "pass" : expectation.requireRunning ? "fail" : "not_applicable",
    required: expectation.requireRunning === true,
    expected: expectation.requireRunning ? "运行中" : null,
    actual: passed ? "运行中" : "未运行",
    action: passed ? null : "启动这个 Profile 后重新检查。"
  });
}

function cdpCheck(profile: PublicProfile, expectation: ProfileReadinessExpectation): ProfileReadinessCheck {
  if (!expectation.requireCdp && profile.cdpPort === null) {
    return check({
      id: "cdp",
      code: "CDP_NOT_REQUIRED",
      label: "CDP 连接",
      status: "not_applicable",
      required: false,
      expected: null,
      actual: profile.source === "native" ? "系统 Profile 不提供端口式 CDP" : "未开启",
      action: null
    });
  }
  const expectedPort = expectation.expectedLogicalPort ?? profile.fixedCdpPort ?? null;
  const portMatches = expectedPort === null || profile.cdpPort === expectedPort || profile.gatewayControl?.publicPort === expectedPort;
  const reachable = Boolean(profile.cdpUrl && profile.cdpPort);
  const passed = reachable && portMatches;
  return check({
    id: "cdp",
    code: !reachable ? "CDP_UNAVAILABLE" : portMatches ? "CDP_READY" : "CDP_LOGICAL_PORT_MISMATCH",
    label: "CDP 连接",
    status: passed ? "pass" : "fail",
    required: expectation.requireCdp === true,
    expected: expectedPort === null ? "可连接" : `逻辑端口 ${expectedPort}`,
    actual: profile.cdpPort === null ? "未开启" : `${profile.cdpUrl || "端口未响应"}${profile.cdpPort ? ` · ${profile.cdpPort}` : ""}`,
    evidence: profile.gatewayControl ? `Gateway public port ${profile.gatewayControl.publicPort}` : null,
    action: !reachable
      ? "使用 CDP 启动此 Profile。"
      : !portMatches
        ? `改用逻辑端口 ${expectedPort}，或更新任务中的端口要求。`
        : null
  });
}

function agentAccessCheck(profile: PublicProfile): ProfileReadinessCheck {
  const blocked = profile.agentAccessDisabled;
  return check({
    id: "agent-access",
    code: blocked ? "PROFILE_AGENT_ACCESS_DISABLED" : "PROFILE_AGENT_ACCESS_ALLOWED",
    label: "Agent 访问",
    status: blocked ? "fail" : "pass",
    required: true,
    expected: "允许",
    actual: blocked ? "已禁止" : "允许",
    action: blocked ? "由用户在 Profile 设置中重新允许 Agent 访问；Agent 不得绕过。" : null
  });
}

function proxyCheck(
  profile: PublicProfile,
  snapshot: BifrostSnapshot | null,
  expectation: ProfileReadinessExpectation
): ProfileReadinessCheck {
  const actualKind = profile.bifrostProxy
    ? "bifrost"
    : profile.upstreamProxy
      ? "upstream"
      : profile.directConnection
        ? "direct"
        : "system";
  if (expectation.expectedProxyKind && expectation.expectedProxyKind !== actualKind) {
    return check({
      id: "proxy",
      code: "PROXY_KIND_MISMATCH",
      label: "代理分流",
      status: "fail",
      required: true,
      expected: proxyKindLabel(expectation.expectedProxyKind),
      actual: proxyKindLabel(actualKind),
      action: "选择绑定了目标代理的 Profile，或先由用户确认修改这个 Profile 的代理配置。"
    });
  }
  if (profile.bifrostProxy) {
    const activeRules = [
      ...profile.bifrostProxy.rules.filter((rule) => !(profile.bifrostProxy?.disabledRules || []).includes(rule)),
      ...profile.bifrostProxy.groupRules.filter((rule) => !(profile.bifrostProxy?.disabledGroupRules || []).includes(rule))
    ];
    const requiredRules = expectation.requiredBifrostRules || [];
    const missingRules = requiredRules.filter((rule) => !activeRules.includes(rule));
    const rawId = profile.id.startsWith("isolated:") ? profile.id.slice("isolated:".length) : profile.id;
    const binding = snapshot?.ports.find((entry) => entry.port === profile.bifrostProxy?.listenerPort);
    const bound = Boolean(snapshot?.installed && snapshot.running && binding?.name === `profilepilot:${rawId}`);
    const passed = bound && !missingRules.length;
    return check({
      id: "proxy",
      code: !snapshot?.running
        ? "BIFROST_NOT_RUNNING"
        : missingRules.length
          ? "BIFROST_RULE_MISMATCH"
          : bound
            ? "BIFROST_ROUTE_READY"
            : "BIFROST_BINDING_STALE",
      label: "代理分流",
      status: passed ? "pass" : "fail",
      required: true,
      expected: requiredRules.length ? `Bifrost · ${requiredRules.join(" · ")}` : "Bifrost 专属入口",
      actual: `${snapshot?.running ? "服务运行中" : "服务不可用"} · 127.0.0.1:${profile.bifrostProxy.listenerPort}`,
      evidence: activeRules.length ? `启用规则：${activeRules.join(" · ")}` : "没有启用规则",
      action: !snapshot?.running
        ? "启动 Bifrost，并重新恢复此 Profile 的专属入口。"
        : missingRules.length
          ? `缺少任务要求的规则：${missingRules.join(" · ")}。`
          : bound
            ? null
            : "重新启动 Profile，让 ProfilePilot 重绑专属入口。"
    });
  }
  if (profile.upstreamProxy) {
    const reachable = snapshot?.upstreamHealth?.[profile.upstreamProxy.server];
    return check({
      id: "proxy",
      code: reachable === true ? "UPSTREAM_PROXY_READY" : reachable === false ? "UPSTREAM_PROXY_UNREACHABLE" : "UPSTREAM_PROXY_UNKNOWN",
      label: "代理分流",
      status: reachable === true ? "pass" : reachable === false ? "fail" : "unknown",
      required: true,
      expected: profile.upstreamProxy.server,
      actual: reachable === true ? "TCP 可达" : reachable === false ? "不可达" : "尚未探测",
      action: reachable === false ? "确认上游代理正在监听该端口。" : reachable === undefined ? "刷新代理状态后重新检查。" : null
    });
  }
  if (profile.directConnection) {
    return check({
      id: "proxy",
      code: "DIRECT_CONNECTION_ENABLED",
      label: "代理分流",
      status: "pass",
      required: Boolean(expectation.expectedProxyKind),
      expected: expectation.expectedProxyKind ? proxyKindLabel(expectation.expectedProxyKind) : null,
      actual: "直接联网（已绕过系统代理）",
      action: null
    });
  }
  return check({
    id: "proxy",
    code: "SYSTEM_PROXY_IN_USE",
    label: "代理分流",
    status: "pass",
    required: Boolean(expectation.expectedProxyKind),
    expected: expectation.expectedProxyKind ? proxyKindLabel(expectation.expectedProxyKind) : null,
    actual: snapshot?.systemProxy ? systemProxyLabel(snapshot.systemProxy.mode) : "跟随系统代理",
    action: null
  });
}

function routeCheck(profile: PublicProfile, expectation: ProfileReadinessExpectation): ProfileReadinessCheck {
  const expected = expectation.expectedTargetUrlIncludes?.trim();
  if (!expected) {
    return check({
      id: "target-route",
      code: "TARGET_ROUTE_NOT_REQUESTED",
      label: "目标页面",
      status: "not_applicable",
      required: false,
      expected: null,
      actual: profile.gatewayControl?.agentTarget?.url || profile.livePrimaryUrl || "尚无页面",
      action: null
    });
  }
  const actual = profile.gatewayControl?.agentTarget?.url || profile.livePrimaryUrl;
  if (!actual) {
    return check({
      id: "target-route",
      code: "TARGET_ROUTE_UNKNOWN",
      label: "目标页面",
      status: "unknown",
      required: true,
      expected,
      actual: "尚未观测到页面",
      action: "打开目标页面后重新检查。"
    });
  }
  const passed = actual.includes(expected);
  return check({
    id: "target-route",
    code: passed ? "TARGET_ROUTE_MATCHED" : "TARGET_ROUTE_MISMATCH",
    label: "目标页面",
    status: passed ? "pass" : "fail",
    required: true,
    expected,
    actual,
    action: passed ? null : "导航到任务要求的页面，并确认环境/域名后重新检查。"
  });
}

function loginCheck(profile: PublicProfile, expectation: ProfileReadinessExpectation): ProfileReadinessCheck {
  if (expectation.expectedLoginLabel) {
    return check({
      id: "login",
      code: "SITE_LOGIN_REQUIRES_VERIFICATION",
      label: "登录态",
      status: "unknown",
      required: true,
      expected: expectation.expectedLoginLabel,
      actual: profile.userName ? `Chrome 账号：${profile.userName}` : "没有可证明的站点登录结果",
      action: "调用对应站点的账号验证工具；Cookies 或 Chrome 账号不能替代站点级验证。"
    });
  }
  if (!expectation.requireBrowserAccount) {
    return check({
      id: "login",
      code: profile.userName ? "BROWSER_ACCOUNT_PRESENT" : "LOGIN_NOT_REQUESTED",
      label: "登录态",
      status: "not_applicable",
      required: false,
      expected: null,
      actual: profile.userName || "未要求浏览器账号",
      action: null
    });
  }
  return check({
    id: "login",
    code: profile.userName ? "BROWSER_ACCOUNT_PRESENT" : "BROWSER_ACCOUNT_MISSING",
    label: "浏览器账号",
    status: profile.userName ? "pass" : "fail",
    required: true,
    expected: "Chrome 账号已登录",
    actual: profile.userName || "未登录",
    action: profile.userName ? null : "先在此 Profile 中完成 Chrome 账号登录。"
  });
}

function extensionCheck(
  extensions: ProfileExtensionInfo[] | undefined,
  expectation: ProfileReadinessExpectation
): ProfileReadinessCheck {
  const required = expectation.requiredExtensions || [];
  if (!required.length) {
    return check({
      id: "extensions",
      code: "EXTENSION_CHECK_NOT_REQUESTED",
      label: "扩展版本",
      status: "not_applicable",
      required: false,
      expected: null,
      actual: "未指定必需扩展",
      action: null
    });
  }
  if (!extensions) {
    return check({
      id: "extensions",
      code: "EXTENSION_SCAN_UNAVAILABLE",
      label: "扩展版本",
      status: "unknown",
      required: true,
      expected: required.map((item) => `${item.name || item.id}${item.minVersion ? ` ≥ ${item.minVersion}` : ""}`).join(" · "),
      actual: "尚未扫描",
      action: "扫描此 Profile 的扩展后重新检查。"
    });
  }
  const failures: string[] = [];
  for (const requirement of required) {
    const installed = extensions.find((extension) => extension.id === requirement.id);
    if (!installed) {
      failures.push(`${requirement.name || requirement.id} 未安装`);
    } else if (!installed.enabled) {
      failures.push(`${requirement.name || installed.name} 未启用`);
    } else if (requirement.minVersion && compareVersions(installed.version, requirement.minVersion) < 0) {
      failures.push(`${requirement.name || installed.name} 当前 ${installed.version}`);
    }
  }
  return check({
    id: "extensions",
    code: failures.length ? "EXTENSION_REQUIREMENT_FAILED" : "EXTENSION_REQUIREMENT_READY",
    label: "扩展版本",
    status: failures.length ? "fail" : "pass",
    required: true,
    expected: required.map((item) => `${item.name || item.id}${item.minVersion ? ` ≥ ${item.minVersion}` : ""}`).join(" · "),
    actual: failures.length ? failures.join(" · ") : "全部满足",
    action: failures.length ? "安装、启用或升级缺失扩展后重新检查。" : null
  });
}

function ownershipCheck(profile: PublicProfile, expectation: ProfileReadinessExpectation): ProfileReadinessCheck {
  const control = profile.gatewayControl;
  if (!control || control.sessionStatus !== "active") {
    return check({
      id: "ownership",
      code: expectation.requireAgentControl ? "AGENT_CONTROL_NOT_ACQUIRED" : "NO_ACTIVE_CONTROL_SESSION",
      label: "逻辑控制权",
      status: expectation.requireAgentControl ? "fail" : "not_applicable",
      required: expectation.requireAgentControl === true,
      expected: expectation.requireAgentControl ? "Agent" : null,
      actual: "没有活动 Gateway Session",
      action: expectation.requireAgentControl ? "通过 ProfilePilot Gateway 建立 Agent 连接。" : null
    });
  }
  const agentOwns = control.ownership === "agent";
  return check({
    id: "ownership",
    code: agentOwns ? "AGENT_OWNS_PROFILE" : "USER_OWNS_PROFILE",
    label: "逻辑控制权",
    status: agentOwns || !expectation.requireAgentControl ? "pass" : "fail",
    required: expectation.requireAgentControl === true,
    expected: expectation.requireAgentControl ? "Agent" : null,
    actual: control.ownership === "agent"
      ? `Agent · ${control.driverState}`
      : control.pendingUserAction
        ? `用户 · 等待完成：${control.pendingUserAction}`
        : "用户",
    evidence: control.ownerSessionId ? `Session ${control.ownerSessionId}` : null,
    action: !agentOwns && expectation.requireAgentControl ? "用户完成操作后显式交还 Agent；Agent 必须重新读取页面状态。" : null
  });
}

function foregroundCheck(profile: PublicProfile, expectation: ProfileReadinessExpectation): ProfileReadinessCheck {
  const activation = profile.windowActivation;
  const frontmost = activation === "foreground";
  const unknown = activation === "unknown";
  return check({
    id: "foreground",
    code: frontmost ? "PROFILE_FOREGROUND" : unknown ? "PROFILE_FOREGROUND_UNKNOWN" : "PROFILE_BACKGROUND",
    label: "窗口前台",
    status: frontmost ? "pass" : expectation.requireForeground ? unknown ? "unknown" : "fail" : "pass",
    required: expectation.requireForeground === true,
    expected: expectation.requireForeground ? "前台" : "允许后台运行",
    actual: activationLabel(activation),
    action: expectation.requireForeground && !frontmost ? "仅在需要用户操作时显式显示此 Profile；后台 Agent 任务不应主动抢焦点。" : null
  });
}

function sessionCheck(
  profile: PublicProfile,
  identity: CanonicalSessionIdentity | null | undefined
): ProfileReadinessCheck {
  const session = profile.gatewayControl?.ownerSessionId || profile.agentBrowserOccupancy?.session || null;
  if (!session) {
    return check({
      id: "session-identity",
      code: "SESSION_IDENTITY_NOT_APPLICABLE",
      label: "Session 身份",
      status: "not_applicable",
      required: false,
      expected: null,
      actual: "没有活动 Session",
      action: null
    });
  }
  if (!identity) {
    return check({
      id: "session-identity",
      code: "SESSION_IDENTITY_UNRESOLVED",
      label: "Session 身份",
      status: "unknown",
      required: false,
      expected: session,
      actual: "没有解析出 canonical identity",
      action: "检查 agent-session-core discovery 诊断。"
    });
  }
  const hasRepresentation = identity.representations.length > 0;
  return check({
    id: "session-identity",
    code: hasRepresentation ? "SESSION_IDENTITY_CANONICAL" : "SESSION_IDENTITY_WITHOUT_REPRESENTATION",
    label: "Session 身份",
    status: hasRepresentation ? "pass" : "unknown",
    required: false,
    expected: session,
    actual: identity.canonicalSessionId,
    evidence: hasRepresentation
      ? `${identity.representations.length} 个来源表示：${identity.representations.map((item) => sourceLabel(item.source)).join(" · ")}`
      : identity.diagnostics.map((item) => item.code).join(" · "),
    action: hasRepresentation ? null : "控制权仍按原生 Session ID 生效；恢复/审计前检查共享索引。"
  });
}

function check(input: ProfileReadinessCheck): ProfileReadinessCheck {
  return input;
}

function proxyKindLabel(kind: "system" | "bifrost" | "upstream" | "direct"): string {
  if (kind === "bifrost") return "Bifrost";
  if (kind === "upstream") return "上游代理";
  if (kind === "direct") return "直接联网";
  return "系统代理";
}

function systemProxyLabel(mode: "direct" | "proxy" | "mixed" | "unknown"): string {
  if (mode === "direct") return "系统直连";
  if (mode === "proxy") return "系统代理";
  if (mode === "mixed") return "系统混合代理";
  return "系统代理状态未知";
}

function activationLabel(activation: PublicProfile["windowActivation"]): string {
  if (activation === "foreground") return "前台";
  if (activation === "background") return "后台";
  if (activation === "not_running") return "未运行";
  return "无法确认";
}

function sourceLabel(source: CanonicalSessionIdentity["representations"][number]["source"]): string {
  if (source === "default-codex-home") return "默认 Codex home";
  if (source === "configured-codex-home") return "配置 Codex home";
  if (source === "orca-codex-home") return "Orca home";
  return "Claude home";
}

export function compareVersions(left: string, right: string): number {
  const a = String(left).split(/[._+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(/[._+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}
