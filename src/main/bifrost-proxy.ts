import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BifrostActiveRuleInfo,
  BifrostPortBindingInfo,
  BifrostRuleDestination,
  BifrostSnapshot,
  ProfileBifrostProxyConfig,
  ProfileUpstreamProxyConfig
} from "../shared/types";
import { ProfileManagerError } from "./profile-manager-error";
import { normalizeProxyEndpoint, parseProxyEndpoint, probeTcp } from "./proxy-health";

const BIFROST_COMMAND_TIMEOUT_MS = 6_000;
const BIFROST_START_READY_TIMEOUT_MS = 10_000;
const PROFILEPILOT_BINDING_PREFIX = "profilepilot:";
let bifrostStartInFlight: Promise<void> | null = null;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface BifrostPortBinding {
  host: string | null;
  name: string | null;
}

interface BifrostStatusFields {
  running: boolean;
  version: string | null;
  mainPort: number | null;
  ports: BifrostPortBindingInfo[];
  activeRules: BifrostActiveRuleInfo[];
}

export interface BifrostRuleReference {
  kind: "local" | "group";
  ref: string;
}

export function normalizeStoredBifrostProxy(value: unknown): ProfileBifrostProxyConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProfileBifrostProxyConfig>;
  const listenerPort = Number(candidate.listenerPort);
  if (!isValidProxyPort(listenerPort)) {
    return null;
  }

  const rules = normalizeRuleRefs(candidate.rules, "local");
  const groupRules = normalizeRuleRefs(candidate.groupRules, "group");
  if (!rules.length && !groupRules.length) {
    return null;
  }

  let disabledRules = normalizeRuleRefs(candidate.disabledRules, "local")
    .filter((rule) => rules.includes(rule));
  let disabledGroupRules = normalizeRuleRefs(candidate.disabledGroupRules, "group")
    .filter((rule) => groupRules.includes(rule));
  if (disabledRules.length + disabledGroupRules.length >= rules.length + groupRules.length) {
    if (rules.length) {
      disabledRules = disabledRules.filter((rule) => rule !== rules[0]);
    } else {
      disabledGroupRules = disabledGroupRules.filter((rule) => rule !== groupRules[0]);
    }
  }

  return {
    listenerPort,
    rules,
    groupRules,
    ...(disabledRules.length ? { disabledRules } : {}),
    ...(disabledGroupRules.length ? { disabledGroupRules } : {})
  };
}

export function validateBifrostProxyConfig(value: ProfileBifrostProxyConfig): ProfileBifrostProxyConfig {
  const listenerPort = Number(value?.listenerPort);
  if (!isValidProxyPort(listenerPort)) {
    throw new ProfileManagerError("Bifrost 入口端口必须是 1024-65535 之间的整数。", "INVALID_BIFROST_PORT");
  }

  const rules = normalizeRuleRefs(value?.rules, "local");
  const groupRules = normalizeRuleRefs(value?.groupRules, "group");
  if (!rules.length && !groupRules.length) {
    throw new ProfileManagerError("至少选择一条 Bifrost 本地规则或 Group 规则。", "BIFROST_RULE_REQUIRED");
  }

  const disabledRules = normalizeRuleRefs(value?.disabledRules, "local")
    .filter((rule) => rules.includes(rule));
  const disabledGroupRules = normalizeRuleRefs(value?.disabledGroupRules, "group")
    .filter((rule) => groupRules.includes(rule));
  if (disabledRules.length + disabledGroupRules.length >= rules.length + groupRules.length) {
    throw new ProfileManagerError("专属分流至少需要保留一条启用规则。", "BIFROST_RULE_REQUIRED");
  }

  return {
    listenerPort,
    rules,
    groupRules,
    ...(disabledRules.length ? { disabledRules } : {}),
    ...(disabledGroupRules.length ? { disabledGroupRules } : {})
  };
}

// 校验直连上游代理配置：server 必须能解析成 scheme://host:port，bypassList 可选。
export function validateUpstreamProxyConfig(value: ProfileUpstreamProxyConfig): ProfileUpstreamProxyConfig {
  const server = normalizeProxyEndpoint(value?.server);
  if (!server) {
    throw new ProfileManagerError(
      "上游代理地址无法解析，请填写形如 http://127.0.0.1:7897 的地址。",
      "INVALID_UPSTREAM_PROXY"
    );
  }
  const bypassList = normalizeBypassList(value?.bypassList);
  return bypassList ? { server, bypassList } : { server };
}

export function normalizeStoredUpstreamProxy(value: unknown): ProfileUpstreamProxyConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<ProfileUpstreamProxyConfig>;
  const server = normalizeProxyEndpoint(candidate.server);
  if (!server) {
    return null;
  }
  const bypassList = normalizeBypassList(candidate.bypassList);
  return bypassList ? { server, bypassList } : { server };
}

// bypass 列表：逗号分隔、去空白、限制条数与长度，防止用户误填超长内容注入命令行。
function normalizeBypassList(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item.length <= 120 && !/[\s\0]/.test(item))
    .slice(0, 40);
  return entries.length ? entries.join(",") : null;
}

export function bifrostProxyChromeArgs(config: ProfileBifrostProxyConfig | null | undefined): string[] {
  return config ? [`--proxy-server=http://127.0.0.1:${config.listenerPort}`] : [];
}

// 直连上游模式的 Chrome 参数：--proxy-server 指向上游入口，可选 --proxy-bypass-list。
export function upstreamProxyChromeArgs(config: ProfileUpstreamProxyConfig | null | undefined): string[] {
  if (!config) return [];
  const parsed = parseProxyEndpoint(config.server);
  if (!parsed) return [];
  const server = parsed.scheme === "http" ? `${parsed.host}:${parsed.port}` : `${parsed.scheme}://${parsed.host}:${parsed.port}`;
  const args = [`--proxy-server=${server}`];
  if (config.bypassList) {
    args.push(`--proxy-bypass-list=${config.bypassList}`);
  }
  return args;
}

// 显式直连模式不能只是“不注入 --proxy-server”，否则 Chrome 仍会跟随系统代理。
export function directConnectionChromeArgs(enabled: boolean | null | undefined): string[] {
  return enabled ? ["--no-proxy-server"] : [];
}

// 启动前对直连上游做 TCP 探活；不可达抛 UPSTREAM_PROXY_UNREACHABLE，与 Bifrost 逃生口共享错误处理。
export async function ensureUpstreamProxy(config: ProfileUpstreamProxyConfig): Promise<string[]> {
  const validated = validateUpstreamProxyConfig(config);
  await assertUpstreamReachable(validated.server);
  return upstreamProxyChromeArgs(validated);
}

async function assertUpstreamReachable(endpoint: string): Promise<void> {
  const parsed = parseProxyEndpoint(endpoint);
  if (!parsed) {
    throw new ProfileManagerError(`上游代理地址无法解析：${endpoint}`, "INVALID_UPSTREAM_PROXY");
  }
  if (!(await probeTcp(parsed.host, parsed.port))) {
    throw new ProfileManagerError(
      `上游代理 ${parsed.host}:${parsed.port} 当前不可达。请确认 Clash Verge（或对应代理）已开启并在该端口监听。`,
      "UPSTREAM_PROXY_UNREACHABLE"
    );
  }
}

export function parseBifrostRuleList(output: string): string[] {
  return uniqueStrings(
    String(output || "")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s{2}(.+?)\s+\[(?:enabled|disabled|global|protected)/i)?.[1]?.trim() || "")
      .filter((name) => name && name.toLowerCase() !== "default")
  );
}

export function bifrostRuleDestinationKey(reference: BifrostRuleReference): string {
  return `${reference.kind}:${reference.ref}`;
}

// 把 Bifrost 规则内容翻译成 Profile 列表真正关心的“最终去向”：
// localhost 端口、x-tt-env PPE/BOE，或显式指向 PPE/BOE host 的路由。
export function parseBifrostRuleDestination(
  ruleName: string,
  output: string
): BifrostRuleDestination | null {
  const contentMarker = String(output || "").match(/(?:^|\n)Content:\s*\n?/i);
  const content = contentMarker?.index === undefined
    ? String(output || "")
    : String(output || "").slice(contentMarker.index + contentMarker[0].length);
  const details: string[] = [];
  const localPorts: string[] = [];
  const ppeEnvs: string[] = [];
  const boeEnvs: string[] = [];
  let hasPpeTarget = false;
  let hasBoeTarget = false;

  const lineBlocks = [...content.matchAll(/line`([\s\S]*?)`/g)].map((match) => match[1]);
  for (const block of lineBlocks) {
    const source = block
      .split(/\r?\n/)
      .map(extractRuleSourceHost)
      .find((host): host is string => host !== null && !isLoopbackHost(host));
    const descriptor = extractLocalFrontendDescriptor(block);
    for (const target of extractLocalTargets(block)) {
      if (target.port) localPorts.push(target.port);
      details.push(`${formatRuleDetailSource(source || null, descriptor)} → ${target.label}`);
    }
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const source = extractRuleSourceHost(line);
    const sourceScope = extractRuleSourceScope(line);
    for (const match of line.matchAll(/["']?(x-tt-env(?:-fe)?)["']?\s*(?:=|:)\s*["']?([a-z0-9._-]+)/gi)) {
      const headerKey = match[1].toLowerCase();
      const environment = match[2];
      const kind = environment.toLowerCase().startsWith("boe") ? "boe" : "ppe";
      (kind === "boe" ? boeEnvs : ppeEnvs).push(environment);
      const descriptor = sourceScope?.path
        ? { role: "后端" as const, scope: sourceScope.path }
        : null;
      details.push(`${formatRuleDetailSource(source, descriptor)} → ${headerKey} · ${kind.toUpperCase()} ${environment}`);
    }

    for (const match of line.matchAll(/\b(?:https?|host|xhost):\/\/([^\s`]+)/gi)) {
      const targetHost = normalizeRuleTargetHost(match[1]);
      if (!targetHost || isLoopbackHost(targetHost) || targetHost === source) continue;
      if (/(?:^|[.-])ppe(?:[.-]|$)/i.test(targetHost)) {
        hasPpeTarget = true;
        details.push(`${source || "匹配请求"} → PPE ${targetHost}`);
      } else if (/(?:^|[.-])boe(?:[.-]|$)/i.test(targetHost)) {
        hasBoeTarget = true;
        details.push(`${source || "匹配请求"} → BOE ${targetHost}`);
      }
    }
  }

  // 没有 line`...` 包裹的短规则也可能直接写 host → localhost。
  if (!lineBlocks.length) {
    for (const line of content.split(/\r?\n/)) {
      const source = extractRuleSourceHost(line);
      const descriptor = extractLocalFrontendDescriptor(line);
      for (const target of extractLocalTargets(line)) {
        if (target.port) localPorts.push(target.port);
      details.push(`${formatRuleDetailSource(source ?? null, descriptor)} → ${target.label}`);
      }
    }
  }

  const labels: string[] = [];
  const kinds: Array<"local" | "ppe" | "boe"> = [];
  const ports = uniqueStrings(localPorts).sort((left, right) => Number(left) - Number(right));
  if (ports.length || details.some((detail) => detail.includes("localhost"))) {
    kinds.push("local");
    labels.push(ports.length ? `本地 · ${ports.map((port) => `:${port}`).join(" / ")}` : "本地");
  }

  const ppeValues = uniqueStrings(ppeEnvs);
  if (ppeValues.length || hasPpeTarget) {
    kinds.push("ppe");
    labels.push(ppeValues.length ? `PPE · ${ppeValues.map((value) => compactEnvironmentName(value, "ppe")).join(" / ")}` : "PPE");
  }

  const boeValues = uniqueStrings(boeEnvs);
  if (boeValues.length || hasBoeTarget) {
    kinds.push("boe");
    labels.push(boeValues.length ? `BOE · ${boeValues.map((value) => compactEnvironmentName(value, "boe")).join(" / ")}` : "BOE");
  }

  // 部分团队规则只在名称里标环境；仅在内容没有可解析目标时才保守回退。
  if (!labels.length && /(?:^|[-_])ppe(?:[-_]|$)/i.test(ruleName)) {
    kinds.push("ppe");
    labels.push("PPE");
  } else if (!labels.length && /(?:^|[-_])boe(?:[-_]|$)/i.test(ruleName)) {
    kinds.push("boe");
    labels.push("BOE");
  }

  if (!labels.length) return null;
  const kind = kinds.length === 1 ? kinds[0] : "mixed";
  return {
    kind,
    label: uniqueStrings(labels).join(" + "),
    details: uniqueStrings(details).slice(0, 16)
  };
}

export function combineBifrostRuleDestinations(
  destinations: BifrostRuleDestination[]
): BifrostRuleDestination | null {
  if (!destinations.length) return null;
  const hasLocal = destinations.some((destination) =>
    destination.kind === "local" || destination.label.includes("本地")
  );
  const hasPpe = destinations.some((destination) =>
    destination.kind === "ppe" || destination.label.includes("PPE")
  );
  const hasBoe = destinations.some((destination) =>
    destination.kind === "boe" || destination.label.includes("BOE")
  );
  const localPorts = uniqueStrings(
    destinations
      .filter((destination) => destination.kind === "local" || destination.label.includes("本地"))
      .flatMap((destination) => [...destination.label.matchAll(/:(\d{2,5})/g)].map((match) => match[1]))
  ).sort((left, right) => Number(left) - Number(right));
  const labels = [
    hasLocal ? (localPorts.length ? `本地 · ${localPorts.map((port) => `:${port}`).join(" / ")}` : "本地") : "",
    hasPpe ? "PPE" : "",
    hasBoe ? "BOE" : ""
  ].filter(Boolean);
  if (!labels.length) return null;
  const kinds = [hasLocal ? "local" : "", hasPpe ? "ppe" : "", hasBoe ? "boe" : ""].filter(Boolean);
  return {
    kind: kinds.length === 1 ? kinds[0] as BifrostRuleDestination["kind"] : "mixed",
    label: labels.join(" + "),
    details: uniqueStrings(destinations.flatMap((destination) => destination.details)).slice(0, 20)
  };
}

export function parseBifrostStatus(output: string): BifrostStatusFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new ProfileManagerError("Bifrost 状态输出不是有效 JSON。", "BIFROST_STATUS_INVALID");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ProfileManagerError("Bifrost 状态输出缺少运行信息。", "BIFROST_STATUS_INVALID");
  }

  const record = parsed as Record<string, unknown>;
  const listener = asRecord(record.listener);
  // ports[] 保留 name/host/status：渲染层用 name 归属（profilepilot:<id>）算三态徽标，
  // 一次 status 调用即可判定，不必逐端口 port show。
  const ports = Array.isArray(record.ports)
    ? record.ports
        .map((item): BifrostPortBindingInfo | null => {
          if (typeof item === "number") {
            return isValidProxyPort(item) ? { port: item, host: null, name: null, status: null } : null;
          }
          const portRecord = asRecord(item);
          const port = Number(portRecord?.port ?? portRecord?.listener_port ?? portRecord?.listenerPort);
          if (!isValidProxyPort(port)) return null;
          return {
            port,
            host: typeof portRecord?.host === "string" ? portRecord.host : null,
            name: typeof portRecord?.name === "string" ? portRecord.name : null,
            status: typeof portRecord?.status === "string" ? portRecord.status : null
          };
        })
        .filter((item): item is BifrostPortBindingInfo => item !== null)
    : [];
  const activeRules = Array.isArray(record.active_rules)
    ? record.active_rules
        .map((item): BifrostActiveRuleInfo | null => {
          const rule = asRecord(item);
          const name = typeof rule?.group === "string" ? rule.group.trim() : "";
          const ruleCount = Number(rule?.rule_count);
          if (!name || name.toLowerCase() === "default" || rule?.enabled !== true || !Number.isFinite(ruleCount) || ruleCount <= 0) {
            return null;
          }
          return { name, ruleCount };
        })
        .filter((rule): rule is BifrostActiveRuleInfo => rule !== null)
    : [];

  return {
    running: record.running === true,
    version: typeof record.version === "string" ? record.version : null,
    mainPort: isValidProxyPort(Number(listener?.port)) ? Number(listener?.port) : null,
    ports: uniquePortBindings(ports),
    activeRules
  };
}

export function parseBifrostPortBinding(output: string): BifrostPortBinding {
  const address = String(output || "").match(/^Temporary port:\s+(.+):(\d+)\s*$/m);
  const name = String(output || "").match(/^Name:\s*(.*)$/m)?.[1]?.trim() || null;
  return {
    host: address?.[1]?.trim() || null,
    name
  };
}

export async function getBifrostSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  upstreamEndpoints: string[] = [],
  ruleReferences: BifrostRuleReference[] = []
): Promise<BifrostSnapshot> {
  const binary = resolveBifrostBinary(env);
  const upstreamHealth = await probeUpstreamEndpoints(upstreamEndpoints);
  try {
    const statusResult = await runBifrost(binary, ["status", "--format", "json"], env);
    const status = parseBifrostStatus(statusResult.stdout);
    let localRules: string[] = [];
    let ruleError: string | null = null;
    try {
      localRules = parseBifrostRuleList((await runBifrost(binary, ["rule", "list"], env)).stdout);
    } catch (error) {
      ruleError = commandErrorMessage(error);
    }
    const mainRuleReferences: BifrostRuleReference[] = status.activeRules.map((rule) => ({ kind: "local", ref: rule.name }));
    const ruleDestinations = await readBifrostRuleDestinations(binary, [...ruleReferences, ...mainRuleReferences], env);
    const mainRuleDestination = combineBifrostRuleDestinations(
      mainRuleReferences
        .map((reference) => ruleDestinations[bifrostRuleDestinationKey(reference)])
        .filter((destination): destination is BifrostRuleDestination => Boolean(destination))
    );
    return {
      installed: true,
      running: status.running,
      version: status.version,
      binaryPath: binary,
      mainPort: status.mainPort,
      ports: status.ports,
      localRules,
      error: status.running ? ruleError : "Bifrost 当前未运行。",
      upstreamHealth,
      ruleDestinations,
      mainRules: status.activeRules,
      mainRuleDestination
    };
  } catch (error) {
    const missing = isMissingCommandError(error);
    return {
      installed: !missing,
      running: false,
      version: null,
      binaryPath: missing ? null : binary,
      mainPort: null,
      ports: [],
      localRules: [],
      error: missing ? "没有找到 bifrost CLI。" : commandErrorMessage(error),
      upstreamHealth,
      ruleDestinations: {},
      mainRules: [],
      mainRuleDestination: null
    };
  }
}

export async function disableBifrostRule(
  ruleNameInput: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const ruleName = typeof ruleNameInput === "string" ? ruleNameInput.trim() : "";
  if (
    !ruleName ||
    ruleName.length > 180 ||
    /[\r\n\0]/.test(ruleName) ||
    ruleName.startsWith("-") ||
    ruleName.toLowerCase() === "default"
  ) {
    throw new ProfileManagerError("要停用的 Bifrost 规则名无效。", "BIFROST_RULE_INVALID");
  }

  const binary = resolveBifrostBinary(env);
  let status: BifrostStatusFields;
  try {
    status = parseBifrostStatus((await runBifrost(binary, ["status", "--format", "json"], env)).stdout);
  } catch (error) {
    if (isMissingCommandError(error)) {
      throw new ProfileManagerError(
        "没有找到 bifrost CLI。请先安装 Bifrost，或通过 BIFROST_BINARY 指定可执行文件。",
        "BIFROST_NOT_INSTALLED"
      );
    }
    throw new ProfileManagerError(`无法读取 Bifrost 状态：${commandErrorMessage(error)}`, "BIFROST_UNAVAILABLE");
  }

  if (!status.running) {
    throw new ProfileManagerError("Bifrost 当前未运行，无法停用规则。", "BIFROST_NOT_RUNNING");
  }
  if (!status.activeRules.some((rule) => rule.name === ruleName)) {
    throw new ProfileManagerError(`Bifrost 规则“${ruleName}”当前未启用。`, "BIFROST_RULE_NOT_ACTIVE");
  }

  try {
    await runBifrost(binary, ["rule", "disable", ruleName], env);
  } catch (error) {
    throw new ProfileManagerError(
      `无法停用 Bifrost 规则“${ruleName}”：${commandErrorMessage(error)}`,
      "BIFROST_RULE_DISABLE_FAILED"
    );
  }
}

async function readBifrostRuleDestinations(
  binary: string,
  references: BifrostRuleReference[],
  env: NodeJS.ProcessEnv
): Promise<Record<string, BifrostRuleDestination>> {
  const uniqueReferences = [...new Map(
    references
      .filter((reference) => reference.ref.trim())
      .map((reference) => [bifrostRuleDestinationKey(reference), { ...reference, ref: reference.ref.trim() }])
  ).values()];
  const entries = await Promise.all(
    uniqueReferences.map(async (reference) => {
      const args = reference.kind === "local"
        ? ["rule", "show", reference.ref]
        : groupRuleShowArgs(reference.ref);
      if (!args) return null;
      const result = await tryRunBifrost(binary, args, env);
      if (!result) return null;
      const destination = parseBifrostRuleDestination(reference.ref, result.stdout);
      return destination ? [bifrostRuleDestinationKey(reference), destination] as const : null;
    })
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, BifrostRuleDestination] => entry !== null));
}

function groupRuleShowArgs(reference: string): string[] | null {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return ["group", "rule", "show", reference.slice(0, separator), reference.slice(separator + 1)];
}

function extractLocalTargets(value: string): Array<{ port: string | null; label: string }> {
  return [...String(value || "").matchAll(/\b(?:https?|host|xhost):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{2,5}))?/gi)]
    .map((match) => ({
      port: match[2] || null,
      label: `localhost${match[2] ? `:${match[2]}` : ""}`
    }));
}

function extractRuleSourceHost(line: string): string | null {
  return extractRuleSourceScope(line)?.host || null;
}

function extractRuleSourceScope(line: string): { host: string; path: string | null } | null {
  const match = String(line || "").trim().match(/^(?:https?:\/\/)?([a-z0-9.-]+)(?::\d+)?(\/[^\s]*)?/i);
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (!host.includes(".") && host !== "localhost") return null;
  const rawPath = match[2] || "";
  return {
    host,
    path: rawPath && rawPath !== "/" ? rawPath : null
  };
}

function extractLocalFrontendDescriptor(
  value: string
): { role: "前端"; scope: string } | null {
  const excludesBackendPaths = /excludeFilter:\/\/[^\s]*(?:\/api\/|\/v1\/api\/|\/open_api\/|\/web\/)/i.test(value);
  if (!excludesBackendPaths) return null;
  const method = value.match(/includeFilter:\/\/m:([a-z]+)/i)?.[1]?.toUpperCase();
  return {
    role: "前端",
    scope: `${method ? `${method} · ` : ""}排除 API 等`
  };
}

function formatRuleDetailSource(
  source: string | null,
  descriptor: { role: "前端" | "后端"; scope: string } | null
): string {
  const sourceLabel = source || "匹配请求";
  return descriptor
    ? `${descriptor.role}（${descriptor.scope}） · ${sourceLabel}`
    : sourceLabel;
}

function normalizeRuleTargetHost(value: string): string | null {
  const host = String(value || "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").trim().toLowerCase();
  return host || null;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function compactEnvironmentName(value: string, prefix: "ppe" | "boe"): string {
  return value.replace(new RegExp(`^${prefix}[-_.]?`, "i"), "") || prefix.toUpperCase();
}

// 并发探活所有上游入口（规范化去重后），返回 { 规范化地址: 可达 } 映射。空列表直接返回空对象。
async function probeUpstreamEndpoints(endpoints: string[]): Promise<Record<string, boolean>> {
  const normalized = [...new Set(endpoints.map((item) => normalizeProxyEndpoint(item)).filter((item): item is string => Boolean(item)))];
  if (!normalized.length) return {};
  const results = await Promise.all(
    normalized.map(async (endpoint) => {
      const parsed = parseProxyEndpoint(endpoint)!;
      return [endpoint, await probeTcp(parsed.host, parsed.port)] as const;
    })
  );
  return Object.fromEntries(results);
}

export async function ensureProfileBifrostProxy(
  profileId: string,
  configInput: ProfileBifrostProxyConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const config = validateBifrostProxyConfig(configInput);
  const binary = resolveBifrostBinary(env);
  let status: BifrostStatusFields;
  try {
    status = parseBifrostStatus((await runBifrost(binary, ["status", "--format", "json"], env)).stdout);
  } catch (error) {
    if (isMissingCommandError(error)) {
      throw new ProfileManagerError(
        "没有找到 bifrost CLI。请先安装 Bifrost，或通过 BIFROST_BINARY 指定可执行文件。",
        "BIFROST_NOT_INSTALLED"
      );
    }
    throw new ProfileManagerError(`无法读取 Bifrost 状态：${commandErrorMessage(error)}`, "BIFROST_UNAVAILABLE");
  }
  if (!status.running) {
    throw new ProfileManagerError("Bifrost 当前未运行。请先启动 Bifrost，再启动这个 Profile。", "BIFROST_NOT_RUNNING");
  }
  if (status.mainPort === config.listenerPort) {
    throw new ProfileManagerError(
      `端口 ${config.listenerPort} 是 Bifrost 主代理端口，不能用作 Profile 专属入口。`,
      "BIFROST_PORT_IS_MAIN"
    );
  }

  const ownerName = bindingName(profileId);
  const existingResult = await tryRunBifrost(binary, ["port", "show", String(config.listenerPort)], env);
  if (existingResult) {
    const binding = parseBifrostPortBinding(existingResult.stdout);
    if (binding.name !== ownerName) {
      const owner = binding.name ? `，当前绑定名为“${binding.name}”` : "";
      throw new ProfileManagerError(
        `Bifrost 入口端口 ${config.listenerPort} 已被其他配置占用${owner}。请换一个端口。`,
        "BIFROST_PORT_IN_USE"
      );
    }
    if (binding.host !== "127.0.0.1") {
      await runBifrost(binary, ["port", "destroy", String(config.listenerPort)], env);
      await bindBifrostPort(binary, ownerName, config, env);
    } else {
      await runBifrost(
        binary,
        ["port", "update", String(config.listenerPort), "--name", ownerName, ...bifrostRuleArgs(config)],
        env
      );
    }
  } else {
    await bindBifrostPort(binary, ownerName, config, env);
  }

  return bifrostProxyChromeArgs(config);
}

// Profile 启动失败后的“一键恢复”入口。先复用已经运行的 Bifrost；未运行时只启动
// 本地 daemon，不启用或修改系统代理。多个 Profile 同时重试时共用同一个启动任务。
export async function startBifrostIfNeeded(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (bifrostStartInFlight) {
    return bifrostStartInFlight;
  }
  bifrostStartInFlight = startBifrostIfNeededOnce(env);
  try {
    await bifrostStartInFlight;
  } finally {
    bifrostStartInFlight = null;
  }
}

async function startBifrostIfNeededOnce(env: NodeJS.ProcessEnv): Promise<void> {
  const binary = resolveBifrostBinary(env);
  let status: BifrostStatusFields;
  try {
    status = parseBifrostStatus((await runBifrost(binary, ["status", "--format", "json"], env)).stdout);
  } catch (error) {
    if (isMissingCommandError(error)) {
      throw new ProfileManagerError(
        "没有找到 bifrost CLI。请先安装 Bifrost，或通过 BIFROST_BINARY 指定可执行文件。",
        "BIFROST_NOT_INSTALLED"
      );
    }
    throw new ProfileManagerError(`无法读取 Bifrost 状态：${commandErrorMessage(error)}`, "BIFROST_UNAVAILABLE");
  }
  if (status.running) {
    return;
  }

  try {
    await runBifrost(binary, ["start", "--daemon"], env);
  } catch (error) {
    // 并发的外部启动可能让 start 返回非零；以最新状态为准。
    const latest = await tryRunBifrost(binary, ["status", "--format", "json"], env);
    if (latest && parseBifrostStatus(latest.stdout).running) {
      return;
    }
    throw new ProfileManagerError(
      `无法启动 Bifrost：${commandErrorMessage(error)}`,
      "BIFROST_START_FAILED"
    );
  }

  const deadline = Date.now() + BIFROST_START_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const latest = await tryRunBifrost(binary, ["status", "--format", "json"], env);
    if (latest && parseBifrostStatus(latest.stdout).running) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new ProfileManagerError(
    "Bifrost 启动命令已执行，但服务在 10 秒内没有就绪。",
    "BIFROST_START_TIMEOUT"
  );
}

// Chrome 启动后无法替换 --proxy-server，但同一个 Bifrost listener 的规则视图可以原地更新。
// 因此运行中的 Profile 只允许保持入口端口不变、调整 local/group rules。
export function canHotUpdateProfileBifrostProxy(
  current: ProfileBifrostProxyConfig | null | undefined,
  next: ProfileBifrostProxyConfig | null | undefined
): boolean {
  return Boolean(current && next && current.listenerPort === next.listenerPort);
}

export async function destroyProfileBifrostProxy(
  profileId: string,
  listenerPort: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isValidProxyPort(listenerPort)) return false;
  const binary = resolveBifrostBinary(env);
  try {
    const existing = await tryRunBifrost(binary, ["port", "show", String(listenerPort)], env);
    if (!existing || parseBifrostPortBinding(existing.stdout).name !== bindingName(profileId)) {
      return false;
    }
    await runBifrost(binary, ["port", "destroy", String(listenerPort)], env);
    return true;
  } catch {
    return false;
  }
}

async function bindBifrostPort(
  binary: string,
  ownerName: string,
  config: ProfileBifrostProxyConfig,
  env: NodeJS.ProcessEnv
): Promise<void> {
  try {
    await runBifrost(
      binary,
      [
        "port",
        "bind",
        "--port",
        String(config.listenerPort),
        "-H",
        "127.0.0.1",
        "--name",
        ownerName,
        ...bifrostRuleArgs(config)
      ],
      env
    );
  } catch (error) {
    throw new ProfileManagerError(
      `无法创建 Bifrost 入口端口 ${config.listenerPort}：${commandErrorMessage(error)}`,
      "BIFROST_BIND_FAILED"
    );
  }
}

export function bifrostRuleArgs(config: ProfileBifrostProxyConfig): string[] {
  const disabledRules = new Set(config.disabledRules || []);
  const disabledGroupRules = new Set(config.disabledGroupRules || []);
  return [
    ...config.rules.filter((rule) => !disabledRules.has(rule)).flatMap((rule) => ["--rule", rule]),
    ...config.groupRules.filter((rule) => !disabledGroupRules.has(rule)).flatMap((rule) => ["--group-rule", rule])
  ];
}

function normalizeRuleRefs(value: unknown, kind: "local" | "group"): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => {
        if (!item || item.length > 180 || /[\r\n\0]/.test(item) || item.startsWith("-")) return false;
        if (kind === "local") return item.toLowerCase() !== "default";
        return /^\d+\/.+/.test(item);
      })
  ).slice(0, 64);
}

function isValidProxyPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function bindingName(profileId: string): string {
  return `${PROFILEPILOT_BINDING_PREFIX}${profileId}`;
}

export function resolveBifrostBinary(env: NodeJS.ProcessEnv): string {
  if (env.BIFROST_BINARY?.trim()) {
    return env.BIFROST_BINARY.trim();
  }

  const executable = process.platform === "win32" ? "bifrost.exe" : "bifrost";
  const pathBinary = executableFromPath(executable, env.PATH);
  if (pathBinary) {
    return pathBinary;
  }
  const candidates = [
    ...(process.platform === "darwin"
      ? ["/Applications/Bifrost.app/Contents/Resources/resources/bin/bifrost"]
      : []),
    path.join(os.homedir(), ".local", "bin", executable),
    path.join(os.homedir(), "bin", executable),
    "/opt/homebrew/bin/bifrost",
    "/usr/local/bin/bifrost"
  ];
  return candidates.find((candidate) => existsSync(candidate)) || executable;
}

function executableFromPath(executable: string, pathValue: string | undefined): string | null {
  for (const entry of String(pathValue || "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runBifrost(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: BIFROST_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4,
        env: withBifrostPath(env),
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout: String(stdout || ""), stderr: String(stderr || "") });
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

async function tryRunBifrost(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult | null> {
  try {
    return await runBifrost(binary, args, env);
  } catch {
    return null;
  }
}

function withBifrostPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathEntries = [
    env.PATH || "",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  return { ...env, PATH: pathEntries.filter(Boolean).join(path.delimiter) };
}

function isMissingCommandError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "未知错误");
  const record = error as Record<string, unknown>;
  const detail = String(record.stderr || record.stdout || record.message || "未知错误").trim();
  return detail.replace(/\s+/g, " ").slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniquePortBindings(values: BifrostPortBindingInfo[]): BifrostPortBindingInfo[] {
  const byPort = new Map<number, BifrostPortBindingInfo>();
  values.forEach((item) => {
    if (!byPort.has(item.port)) byPort.set(item.port, item);
  });
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
