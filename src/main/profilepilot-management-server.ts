import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import type { AppState, PublicProfile, StoredProfile } from "../shared/types";
import type { ProfileManager } from "./profile-manager";
import { ProfileManagerError } from "./profile-manager-error";
import {
  PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES,
  PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION,
  profilePilotManagementRoot,
  profilePilotManagementSecretPath,
  profilePilotManagementSocketPath,
  type ProfilePilotManagementCommand,
  type ProfilePilotManagementRequest,
  type ProfilePilotManagementResponse
} from "./profilepilot-management-protocol";

const REQUEST_TIMEOUT_MS = 35_000;

type ManagementProfileManager = Pick<
  ProfileManager,
  "getState" | "createProfile" | "renameProfile" | "launchProfile" | "closeProfile" | "deleteProfile"
>;

export interface ProfilePilotManagementServerOptions {
  profileManager: ManagementProfileManager;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  onMutation?: () => void;
}

export interface ProfilePilotManagementServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

export async function startProfilePilotManagementServer(
  options: ProfilePilotManagementServerOptions
): Promise<ProfilePilotManagementServerHandle> {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const root = profilePilotManagementRoot(homeDir, env);
  const socketPath = profilePilotManagementSocketPath(homeDir, env);
  const token = await ensureManagementSecret(homeDir, env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  if (process.platform !== "win32") {
    await fs.rm(socketPath, { force: true });
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES) {
        handled = true;
        writeResponse(socket, errorResponse("unknown", "MANAGEMENT_REQUEST_TOO_LARGE", "管理请求超过大小限制。"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      const line = buffer.slice(0, newline).trim();
      void handleRequestLine(line, token, options)
        .then((response) => writeResponse(socket, response))
        .catch((error) => writeResponse(socket, responseFromError("unknown", error)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  if (process.platform !== "win32") {
    await fs.chmod(socketPath, 0o600).catch(() => undefined);
  }

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
      });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
    }
  };
}

export async function executeProfilePilotManagementCommand(
  command: ProfilePilotManagementCommand,
  options: Pick<ProfilePilotManagementServerOptions, "profileManager" | "appVersion" | "onMutation">
): Promise<unknown> {
  if (command.action === "ping") {
    return {
      service: "ProfilePilot",
      app_version: options.appVersion || null,
      protocol_version: PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION,
      pid: process.pid
    };
  }

  const manager = options.profileManager;
  if (command.action === "profile.list") {
    const state = await manager.getState();
    return { profiles: state.profiles.map(toManagementProfile) };
  }
  if (command.action === "profile.get") {
    const state = await manager.getState();
    return { profile: toManagementProfile(resolveProfile(state, command.selector)) };
  }
  if (command.action === "profile.create") {
    const created = await manager.createProfile(command.name);
    const state = await manager.getState();
    const profile = resolveCreatedProfile(state, created);
    options.onMutation?.();
    return { changed: true, profile: toManagementProfile(profile) };
  }

  const before = await manager.getState();
  const profile = resolveProfile(before, command.selector);
  assertCliManageable(profile);

  if (command.action === "profile.rename") {
    await manager.renameProfile(profile.id, command.name);
    const state = await manager.getState();
    options.onMutation?.();
    return { changed: true, profile: toManagementProfile(resolveProfile(state, profile.id)) };
  }
  if (command.action === "profile.start") {
    if (profile.running) {
      return { changed: false, profile: toManagementProfile(profile) };
    }
    await manager.launchProfile(profile.id);
    const state = await manager.getState();
    options.onMutation?.();
    return { changed: true, profile: toManagementProfile(resolveProfile(state, profile.id)) };
  }
  if (command.action === "profile.stop") {
    if (!profile.running) {
      return { changed: false, profile: toManagementProfile(profile) };
    }
    await manager.closeProfile(profile.id);
    const state = await manager.getState();
    options.onMutation?.();
    return { changed: true, profile: toManagementProfile(resolveProfile(state, profile.id)) };
  }
  if (!command.confirmed) {
    throw new ProfileManagerError(
      `删除 Profile“${profile.name}”需要显式确认。请重新执行并添加 --yes。`,
      "PROFILE_DELETE_CONFIRMATION_REQUIRED"
    );
  }
  const result = await manager.deleteProfile(profile.id);
  options.onMutation?.();
  return {
    changed: true,
    deleted_profile: toManagementProfile(result.deletedProfile),
    recoverable: Boolean(result.trashPath),
    trash_path: result.trashPath
  };
}

async function handleRequestLine(
  line: string,
  expectedToken: string,
  options: ProfilePilotManagementServerOptions
): Promise<ProfilePilotManagementResponse> {
  let request: ProfilePilotManagementRequest;
  try {
    request = JSON.parse(line) as ProfilePilotManagementRequest;
  } catch {
    return errorResponse("unknown", "MANAGEMENT_INVALID_JSON", "管理请求不是有效 JSON。" );
  }
  const id = typeof request?.id === "string" && request.id ? request.id : "unknown";
  if (request?.version !== PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION) {
    return errorResponse(id, "MANAGEMENT_PROTOCOL_UNSUPPORTED", "CLI 与 ProfilePilot 的管理协议版本不兼容。" );
  }
  if (!tokensEqual(request.token, expectedToken)) {
    return errorResponse(id, "MANAGEMENT_UNAUTHORIZED", "管理请求认证失败。" );
  }
  if (!request.command || typeof request.command.action !== "string") {
    return errorResponse(id, "MANAGEMENT_COMMAND_REQUIRED", "管理请求缺少 command。" );
  }
  try {
    const data = await executeProfilePilotManagementCommand(request.command, options);
    return { version: 1, id, ok: true, data };
  } catch (error) {
    return responseFromError(id, error);
  }
}

function resolveProfile(state: AppState, selectorInput: string): PublicProfile {
  const selector = String(selectorInput || "").trim();
  if (!selector) {
    throw new ProfileManagerError("请提供 Profile 名称或 ID。", "PROFILE_SELECTOR_REQUIRED");
  }
  const byId = state.profiles.find((profile) => profile.id === selector);
  if (byId) return byId;
  const exact = state.profiles.filter((profile) => profile.name === selector);
  const matches = exact.length
    ? exact
    : state.profiles.filter((profile) => profile.name.toLocaleLowerCase() === selector.toLocaleLowerCase());
  if (!matches.length) {
    throw new ProfileManagerError(`没有找到 Profile“${selector}”。`, "PROFILE_NOT_FOUND");
  }
  if (matches.length > 1) {
    const error = new ProfileManagerError(
      `有多个 Profile 都叫“${selector}”，请改用 Profile ID。`,
      "PROFILE_NAME_AMBIGUOUS"
    ) as ProfileManagerError & { details?: unknown };
    error.details = { candidates: matches.map((profile) => ({ id: profile.id, name: profile.name })) };
    throw error;
  }
  return matches[0];
}

function resolveCreatedProfile(state: AppState, created: StoredProfile): PublicProfile {
  const profile = state.profiles.find((item) => item.source === "isolated" && item.dirName === created.dirName);
  if (!profile) {
    throw new ProfileManagerError("Profile 已创建，但刷新状态时没有找到它。", "PROFILE_CREATE_STATE_MISSING");
  }
  return profile;
}

function assertCliManageable(profile: PublicProfile): void {
  if (profile.source !== "isolated" || !profile.id.startsWith("isolated:")) {
    throw new ProfileManagerError(
      "管理 CLI 目前只允许修改 ProfilePilot 创建的独立 Profile；系统和子 Profile 只能查询。",
      "PROFILE_CLI_MANAGED_ONLY"
    );
  }
}

function toManagementProfile(profile: PublicProfile): Record<string, unknown> {
  const proxyKind = profile.bifrostProxy
    ? "bifrost"
    : profile.upstreamProxy
      ? "upstream"
      : profile.directConnection
        ? "direct"
        : "system";
  const occupancy = profile.agentBrowserOccupancy || null;
  return {
    id: profile.id,
    name: profile.name,
    source: profile.source,
    manageable: profile.source === "isolated" && profile.id.startsWith("isolated:"),
    running: profile.running,
    cdp_port: profile.cdpPort,
    fixed_cdp_port: profile.fixedCdpPort,
    proxy_kind: proxyKind,
    project_tag: profile.projectTag,
    agent_access: profile.agentAccessDisabled ? "blocked" : "allowed",
    occupancy: occupancy ? {
      session: occupancy.session,
      ownership: occupancy.ownership,
      agent: occupancy.agent,
      project: occupancy.project,
      updated_at: occupancy.updatedAt
    } : null,
    created_at: profile.createdAt,
    last_launched_at: profile.lastLaunchedAt
  };
}

async function ensureManagementSecret(homeDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const root = profilePilotManagementRoot(homeDir, env);
  const secretPath = profilePilotManagementSecretPath(homeDir, env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  try {
    return validateSecret(await fs.readFile(secretPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32).toString("hex");
  try {
    await fs.writeFile(secretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return validateSecret(await fs.readFile(secretPath, "utf8"));
  }
  await fs.chmod(secretPath, 0o600).catch(() => undefined);
  return secret;
}

function validateSecret(content: string): string {
  const secret = content.trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new ProfileManagerError("ProfilePilot 管理密钥损坏，请删除后重启应用。", "MANAGEMENT_SECRET_INVALID");
  }
  return secret;
}

function tokensEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function responseFromError(id: string, error: unknown): ProfilePilotManagementResponse {
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  return errorResponse(
    id,
    typeof candidate?.code === "string" ? candidate.code : "PROFILEPILOT_MANAGEMENT_ERROR",
    typeof candidate?.message === "string" ? candidate.message : String(error),
    candidate?.details
  );
}

function errorResponse(id: string, code: string, message: string, details?: unknown): ProfilePilotManagementResponse {
  return {
    version: 1,
    id,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) }
  };
}

function writeResponse(socket: net.Socket, response: ProfilePilotManagementResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}
