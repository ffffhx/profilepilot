import { z } from "zod";
import type { LocalAppView } from "../../shared/local-apps";
import type { LocalAppsService } from "./service";
import { ProfileManagerError } from "../profile-manager-error";

export type LocalAppManagementCommand =
  | { action: "local-app"; method: "list" }
  | { action: "local-app"; method: "register"; input: ElectronRegistration }
  | { action: "local-app"; method: "inspect"; selector: string }
  | { action: "local-app"; method: "connect"; selector: string; confirmationToken?: string }
  | { action: "local-app"; method: "configure"; selector: string; input: { command?: string; cwd?: string } };

const selector = z.string().trim().min(1).max(200);
export const electronRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(100), mode: z.enum(['launch', 'attach']),
  cwd: z.string().trim().max(4096), command: z.string().trim().max(8192),
  cdpPort: z.number().int().min(1024).max(65535), inspectPort: z.number().int().min(1024).max(65535).nullable().default(null),
  agentPort: z.number().int().min(1024).max(65535), environment: z.string().max(32768).default('')
}).strict();
export type ElectronRegistration = z.infer<typeof electronRegistrationSchema>;
export const electronConfigurationSchema = z.object({ command: z.string().trim().min(1).max(8192).optional(), cwd: z.string().trim().min(1).max(4096).optional() }).strict()
  .refine(input => Object.keys(input).length > 0);
const commandSchema = z.discriminatedUnion("method", [
  z.object({ action: z.literal("local-app"), method: z.literal("list") }).strict(),
  z.object({ action: z.literal("local-app"), method: z.literal("register"), input: electronRegistrationSchema }).strict(),
  z.object({ action: z.literal("local-app"), method: z.literal("inspect"), selector }).strict(),
  z.object({ action: z.literal("local-app"), method: z.literal("connect"), selector, confirmationToken: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("local-app"), method: z.literal("configure"), selector,
    input: electronConfigurationSchema }).strict()
]);

// Configuration contains environment variables and arbitrary launch commands.
// Only expose connection evidence, never those credentials or raw CDP targets.
function publicApp(app: LocalAppView) {
  return {
    id: `local-app:${app.id}`, name: app.name, port: app.agentPort ?? null,
    mode: app.mode, managed: app.managed, controls: app.controls,
    runtime: app.runtime, debug: { renderer: app.debug.renderer, main: app.debug.main },
    agent: app.agent, connection: app.connection
  };
}

export async function executeLocalAppManagementCommand(
  input: unknown, service: Pick<LocalAppsService, "snapshot" | "list" | "connect" | "get" | "save" | "syncAgents">
) {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new ProfileManagerError("本地应用命令参数无效。", "LOCAL_APP_INVALID_ARGUMENTS");
  const command = parsed.data;
  if (command.method === "list") return { apps: (await service.list()).map(publicApp) };
  if (command.method === 'register') {
    // Registration uses the same validated save path as the App. It does not
    // launch/connect an app, attach a debugger or acquire a control session.
    if (service.snapshot().some(app => app.name === command.input.name)) throw new ProfileManagerError('此名称已登记；先 inspect 现有 ID，必要时 configure。', 'LOCAL_APP_ALREADY_REGISTERED');
    const id = await service.save(command.input);
    return { status: 'registered', app: { id: `local-app:${id}`, name: command.input.name, port: command.input.agentPort }, connected: false };
  }
  const rows = service.snapshot();
  const exact = rows.filter(app => app.id === command.selector || `local-app:${app.id}` === command.selector);
  const matches = exact.length ? exact : rows.filter(app => app.name === command.selector);
  if (matches.length !== 1) throw new ProfileManagerError(matches.length
    ? "应用名称不唯一，请使用 ppilot electron list --all 返回的 ID。"
    : "未找到已登记应用，请用 ppilot electron list --all 核对名称或 ID。",
  matches.length ? "LOCAL_APP_AMBIGUOUS" : "LOCAL_APP_NOT_FOUND");
  const id = matches[0].id;
  if (command.method === "configure") {
    await service.syncAgents();
    const current = (await service.list()).find(app => app.id === id);
    if (!current || current.agent?.sessionId || current.agent?.connectionActive) {
      throw new ProfileManagerError("应用仍有 Agent 会话或状态无法确认，不能修改连接配置。", "LOCAL_APP_BUSY");
    }
    // Keep registration, credentials and ports; use the UI save path and its
    // managed-process / Gateway guards instead of modifying apps.json directly.
    await service.save({ ...service.get(id), ...command.input });
    await service.syncAgents();
  }
  // The same connector as the UI owns restart consent and session checks.
  const result = command.method === "connect" ? await service.connect(id, command.confirmationToken) : {};
  const app = (await service.list()).find(app => app.id === id);
  return { ...result, app: app ? publicApp(app) : null };
}
