import { z } from "zod";
import { createHash } from "node:crypto";
import type { BrowserTask, TaskEvent } from "../../shared/tasks";
import { ProfileManagerError } from "../profile-manager-error";
import type { ManagementTask, ManagementTaskPage, ManagementTaskSummary, ProfilePilotTaskCommand } from "../profilepilot-management-protocol";
import type { TaskService } from "./service";
import { createTaskSchema, nativeAccessSchema } from "./store";
import { contextDescription } from "./conversation";
import { normalizeNativeAccess } from "./native-access";

// Leave room for the protocol envelope, JSON escaping, and event pagination.
const TASK_BYTES = 256 * 1024;
const PAGE_BYTES = 768 * 1024;
const uuid = z.string().uuid();
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const messageFields = { requestId: z.string().min(1).max(200).optional(), attachmentIds: z.array(uuid).max(50).optional() };
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("task.create"), profile: z.string().trim().min(1).max(200), input: createTaskSchema.omit({ profileId: true }).extend({
    materialIds: z.array(z.string().min(1).max(200)).max(50).optional(),
    attachmentIds: z.array(z.string().min(1).max(200)).max(50).optional(),
    limits: createTaskSchema.shape.limits.removeDefault().strict().optional(),
    grant: createTaskSchema.shape.grant.unwrap().strict().optional()
  }).strict() }).strict(),
  z.object({ action: z.literal("task.list"), limit: z.number().int().min(1).max(100).optional(), offset: cursor.optional() }).strict(),
  z.object({ action: z.literal("task.get"), id: uuid, after: cursor.optional(), revision: cursor.optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal("task.control"), id: uuid, control: z.enum(["pause", "resume", "takeover", "cancel", "steer", "queue"]), message: z.string().max(30000).optional(), ...messageFields }).strict(),
  z.object({ action: z.literal("task.reply"), id: uuid, decisionId: uuid, answer: z.string().max(30000), approved: z.boolean().optional(), scope: z.enum(["once", "session"]).optional(), ...messageFields }).strict(),
  z.object({ action: z.literal("task.queue"), id: uuid, removeId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal("task.limits"), id: uuid, limits: createTaskSchema.shape.limits.removeDefault().partial().strict() }).strict(),
  z.object({ action: z.literal("task.settings.get") }).strict(),
  z.object({ action: z.literal("task.settings.update"), input: z.object({ model: z.string().trim().min(1).max(200), baseUrl: z.string().url().max(2000), apiKey: z.string().max(1000), authMode: z.enum(["apiKey", "bearer"]), maxConcurrent: z.number().int().min(1).max(6), retentionDays: z.number().int().min(1).max(3650), saveScreenshots: z.boolean(), notifications: z.boolean() }).partial().strict() }).strict(),
  z.object({ action: z.literal("task.models") }).strict(),
  z.object({ action: z.literal("task.connection.test") }).strict(),
  z.object({ action: z.literal("task.attachments.import"), paths: z.array(z.string().min(1).max(4096)).min(1).max(50), id: uuid.optional() }).strict(),
  z.object({ action: z.literal("task.metadata"), id: uuid, title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal("task.fork"), id: uuid, title: z.string().trim().min(1).max(120).optional(), eventId: uuid.optional() }).strict(),
  z.object({ action: z.literal("task.rewind"), id: uuid, eventId: uuid }).strict(),
  z.object({ action: z.literal("task.compact"), id: uuid, instructions: z.string().max(5000).optional() }).strict(),
  z.object({ action: z.literal("task.mode"), id: uuid, mode: z.enum(["manual", "plan", "acceptEdits"]), model: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal("task.model"), id: uuid, model: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("task.permissions"), id: uuid, revokeId: z.union([uuid, z.literal("all")]).optional() }).strict(),
  z.object({ action: z.literal("task.status"), id: uuid }).strict()
]);

export function parseTaskManagementCommand(input: unknown): ProfilePilotTaskCommand {
  try { return commandSchema.parse(input); }
  catch { throw new ProfileManagerError("任务命令参数无效，请检查 ID、参数名称及长度或分页范围。", "TASK_COMMAND_INVALID"); }
}

export async function executeTaskManagementCommand(
  command: ProfilePilotTaskCommand,
  service: TaskService,
  resolveProfileId: (selector: string) => Promise<string>
): Promise<unknown> {
  if (command.action === "task.settings.get") return { settings: structuredClone(service.store.data.settings) };
  if (command.action === "task.settings.update") {
    if (!service.dependencies.saveSettings) throw new Error("当前服务不支持保存模型设置。");
    await service.dependencies.saveSettings(command.input);
    return { settings: structuredClone(service.store.data.settings) };
  }
  if (command.action === "task.models") {
    if (!service.dependencies.listModels) throw new Error("当前服务不支持模型列表。");
    return { models: await service.dependencies.listModels() };
  }
  if (command.action === "task.connection.test") {
    if (!service.dependencies.testConnection) throw new Error("当前服务不支持连接测试。");
    return { message: await service.dependencies.testConnection() };
  }
  if (command.action === "task.attachments.import") return { attachments: service.importAttachmentPaths(command.paths, command.id) };
  if (command.action === "task.create") {
    const profileId = await resolveProfileId(command.profile);
    const task = await service.create(createTaskSchema.parse({ ...command.input, profileId }));
    return { task: toManagementTask(task, service.runs.has(task.id)) };
  }
  if (command.action === "task.list") {
    const tasks: ManagementTaskSummary[] = [];
    const all = service.store.data.tasks;
    const offset = command.offset ?? 0;
    if (offset > all.length) throw new ProfileManagerError("任务分页位置超出范围。", "TASK_CURSOR_INVALID");
    for (const task of all.slice(offset, offset + (command.limit ?? 30))) {
      const summary = toManagementTaskSummary(task, service.runs.has(task.id));
      if (encodedBytes({ tasks: [...tasks, summary], total: all.length }) > PAGE_BYTES) {
        if (!tasks.length) throw new ProfileManagerError("任务信息过大，请在桌面应用查看。", "TASK_DETAILS_TOO_LARGE");
        break;
      }
      tasks.push(summary);
    }
    return { tasks, total: all.length };
  }
  const task = service.store.data.tasks.find(task => task.id === command.id);
  if (!task) throw new ProfileManagerError("任务不存在。", "TASK_NOT_FOUND");
  if (command.action === "task.get") {
    const revision = task.historyRevision || 0;
    const reset = command.revision !== undefined && command.revision !== revision || (command.after || 0) > task.events.length;
    const after = reset ? 0 : command.after ?? 0;
    const data: ManagementTaskPage = { task: toManagementTask(task, service.runs.has(task.id)), events: [], cursor: after, hasMore: false, stream: service.streams.get(task.id), revision, reset };
    let bytes = encodedBytes(data);
    for (const event of task.events.slice(after, after + (command.limit ?? 100))) {
      // TaskStore already limits event text to 30,000 characters. Preserve it
      // exactly: consumers can reconnect with cursor without losing text.
      const safeEvent = { id: event.id, at: event.at, kind: event.kind, text: event.text } satisfies TaskEvent;
      const size = encodedBytes(safeEvent) + 1;
      if (bytes + size > PAGE_BYTES) {
        if (!data.events.length) throw new ProfileManagerError("单条事件过大，请在桌面应用查看该任务。", "TASK_EVENT_TOO_LARGE");
        break;
      }
      data.events.push(safeEvent); bytes += size; data.cursor++;
    }
    data.hasMore = data.cursor < task.events.length;
    return data;
  }
  if (command.action === "task.status") return { task: toManagementTask(task, service.runs.has(task.id)), processes: service.terminal.list(task.id),
    subagents: task.agentActivities || [], relatedTasks: service.store.data.tasks.filter(other => other.sourceTaskId === task.id).map(other => toManagementTaskSummary(other, service.runs.has(other.id))), context: contextDescription(task) };
  if (command.action === "task.metadata") await service.updateTaskMetadata(task.id, { title: command.title });
  else if (command.action === "task.fork") return { task: toManagementTask(service.forkConversation(task.id, command.title, command.eventId), false) };
  else if (command.action === "task.rewind") { const draft = service.rewindConversation(task.id, command.eventId); return { task: toManagementTask(task, false), draft }; }
  else if (command.action === "task.compact") { const result = await service.compactConversation(task.id, command.instructions); return { task: toManagementTask(task, false), ...result }; }
  else if (command.action === "task.mode") service.setMode(task.id, command.mode, command.model);
  else if (command.action === "task.model") service.setModel(task.id, command.model);
  else if (command.action === "task.permissions") return { rules: service.permissions(task.id, command.revokeId) };
  else if (command.action === "task.queue") return { queue: service.queue(task.id, command.removeId) };
  else if (command.action === "task.limits") service.setLimits(task.id, command.limits);
  else if (command.action === "task.control") {
    if (command.control === "steer" && !command.message?.trim()) throw new ProfileManagerError("请输入补充要求。", "TASK_MESSAGE_REQUIRED");
    if (command.control === "resume" && task.pending && task.pending.kind !== "handoff") throw new ProfileManagerError("请先使用 agent reply 回答当前问题或处理操作确认。", "TASK_REPLY_REQUIRED");
    await service.control(task.id, command.control, command.message, { requestId: command.requestId, attachmentIds: command.attachmentIds });
  } else if (command.action === "task.reply") {
    const pending = task.pending;
    // TaskService performs the authoritative stale-decision check again,
    // including races while a confirmation is being processed.
    if (pending?.id === command.decisionId && task.status === "waiting_user") {
      if (pending.kind === "confirmation" && typeof command.approved !== "boolean") {
        throw new ProfileManagerError("此操作需要明确批准或拒绝，请使用 --approve 或 --reject。", "TASK_APPROVAL_REQUIRED");
      }
      if (pending.kind === "handoff" && command.approved !== true) {
        throw new ProfileManagerError("交还浏览器需要明确批准，请在完成手动操作后使用 --approve。", "TASK_APPROVAL_REQUIRED");
      }
      if (pending.kind === "question" && !command.answer.trim()) throw new ProfileManagerError("请填写问题的回答。", "TASK_ANSWER_REQUIRED");
    }
    await service.reply(task.id, command.decisionId, command.answer, command.approved === true, command.scope, { requestId: command.requestId, attachmentIds: command.attachmentIds });
  }
  return { task: toManagementTask(task, service.runs.has(task.id)) };
}

function toManagementTaskSummary(task: BrowserTask, running: boolean): ManagementTaskSummary {
  return {
    id: task.id, title: task.title.slice(0, 256), profileId: task.profileId, profileName: task.profileName.slice(0, 256),
    status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt, running,
    usage: structuredClone(task.usage), limits: { ...task.limits }, needsReconciliation: task.needsReconciliation
  };
}

export function toManagementTask(task: BrowserTask, running: boolean): ManagementTask {
  // Do not export observations, screenshots, receipts, attached documents,
  // personal materials, SDK state, execution grants, or provider credentials.
  const pending = task.pending ? {
    id: task.pending.id, kind: task.pending.kind, title: task.pending.title, details: task.pending.details,
    createdAt: task.pending.createdAt,
    ...(task.pending.terminal ? { terminal: { ...task.pending.terminal } } : {}),
    ...(task.pending.permissionScope ? { permissionScope: { ...task.pending.permissionScope } } : {}),
    ...(task.pending.action ? { action: {
      kind: task.pending.action.kind, effect: task.pending.action.effect, summary: task.pending.action.summary,
      ...(task.pending.action.ref ? { ref: task.pending.action.ref } : {})
    } } : {})
  } : undefined;
  // Never silently abbreviate the operation a user is being asked to approve.
  if (pending && encodedBytes(pending) > TASK_BYTES / 2) throw new ProfileManagerError("待确认内容过大，请在桌面应用查看并处理。", "TASK_DECISION_TOO_LARGE");
  let textLimit = 30000, countLimit = 500;
  for (;;) {
    const truncated = new Set<string>();
    const text = (value: string, field: string): string => {
      if (value.length <= textLimit) return value;
      truncated.add(field); return `${value.slice(0, textLimit)}\n[内容已截断，请在桌面应用查看完整记录]`;
    };
    const list = <T>(values: T[], field: string): T[] => {
      if (values.length > countLimit) truncated.add(field);
      return values.slice(0, countLimit);
    };
    const result: ManagementTask = {
      ...toManagementTaskSummary(task, running), title: text(task.title, "title"), prompt: text(task.prompt, "prompt"),
      mode: task.mode || "acceptEdits", model: task.model,
      historyRevision: task.historyRevision || 0,
      checkpoints: list(task.events.filter(event => event.kind === "user"), "checkpoints").map(event => ({ eventId: event.id, at: event.at, prompt: text(event.text.slice(0, 160), "checkpoints") })),
      plan: list(task.plan, "plan").map(value => text(value, "plan")),
      items: list(task.items, "items").map(item => ({ id: item.id, label: text(item.label, "items"), status: item.status,
        ...(item.result === undefined ? {} : { result: text(item.result, "items") }),
        ...(item.evidence === undefined ? {} : { evidence: text(item.evidence, "items") }) })),
      ...(pending ? { pending } : {}),
      ...(task.result ? { result: { kind: task.result.kind, summary: text(task.result.summary, "result"),
        evidence: list(task.result.evidence, "result").map(value => text(value, "result")),
        remaining: list(task.result.remaining, "result").map(value => text(value, "result")) } } : {}),
      ...(task.outputs ? { outputs: list(task.outputs, "outputs").map(output => ({ id: output.id, name: text(output.name, "outputs"), path: text(output.path, "outputs"), size: output.size })) } : {})
    };
    if (truncated.size) result.truncated = [...truncated];
    if (encodedBytes(result) <= TASK_BYTES) return result;
    if (textLimit <= 256 && countLimit === 1) throw new ProfileManagerError("任务信息过大，请在桌面应用查看。", "TASK_DETAILS_TOO_LARGE");
    textLimit = Math.max(256, Math.floor(textLimit / 2)); countLimit = Math.max(1, Math.floor(countLimit / 2));
  }
}

function encodedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

const nativeRequestId = z.string().trim().min(1).max(200).optional();
const nativeUiSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("getUiState"), taskId: uuid.optional() }).strict(),
  z.object({ method: z.literal("startTask"), prompt: z.string().trim().min(1).max(30000), tabId: z.number().int().positive().optional(), newTab: z.boolean().optional(), selection: z.string().max(10000).optional(), requestId: nativeRequestId }).strict(),
  z.object({ method: z.literal("taskMessage"), taskId: uuid, message: z.string().trim().min(1).max(30000), requestId: nativeRequestId }).strict(),
  z.object({ method: z.literal("taskControl"), taskId: uuid, action: z.enum(["stop", "takeover", "resume"]), requestId: nativeRequestId }).strict(),
  z.object({ method: z.literal("taskReply"), taskId: uuid, decisionId: uuid, answer: z.string().max(30000).default(""), approved: z.boolean(), scope: z.enum(["once", "session"]).optional(), requestId: nativeRequestId }).strict(),
  nativeAccessSchema.extend({ method: z.literal("setAccess"), requestId: nativeRequestId }).strict()
]);
const nativeRequests = new WeakMap<TaskService, Map<string, { fingerprint: string; pending: boolean; promise: Promise<unknown> }>>();

/** The bridge supplies the authenticated pairing's profileId, never the page. */
export async function executeNativeUiCommand(profileId: string, method: string, params: Record<string, unknown>, service: TaskService): Promise<unknown> {
  if (!/^native:[^/\\]{1,100}$/.test(profileId)) throw new Error("系统 Chrome Profile 无效。");
  const command = nativeUiSchema.parse({ ...params, method });
  const owned = (id: string): BrowserTask => {
    const task = service.store.get(id);
    if (task.profileId !== profileId) throw new Error("不能操作其他 Profile 的任务。");
    return task;
  };
  const state = (id?: string) => {
    const tasks = service.store.data.tasks.filter(task => task.profileId === profileId);
    const task = id ? owned(id) : tasks[0];
    return {
      task: task ? toManagementTask(task, service.runs.has(task.id)) : undefined,
      taskSessionId: task?.sessionId,
      tasks: tasks.slice(0, 20).map(task => ({ id: task.id, title: task.title.slice(0, 256), status: task.status, updatedAt: task.updatedAt })),
      events: task?.events.slice(-20).map(event => ({ ...event, text: event.text.slice(0, 4000), ...(event.text.length > 4000 ? { truncated: true } : {}) })) || [],
      stream: task ? structuredClone(service.streams.get(task.id)) : undefined,
      access: normalizeNativeAccess(service.store.data.nativeAccessPolicies?.[profileId])
    };
  };
  if (command.method === "getUiState") return state(command.taskId);
  const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const request = command.requestId ? { id: command.requestId, method: command.method, fingerprint } : undefined;
  const requests = nativeRequests.get(service) || new Map();
  nativeRequests.set(service, requests);
  const key = JSON.stringify([profileId, command.requestId]);
  const previous = request && requests.get(key);
  if (previous?.pending) {
    if (previous.fingerprint !== fingerprint) throw new Error("同一个请求编号不能用于不同的任务操作。");
    return previous.promise;
  }
  if (request) {
    for (const task of service.store.data.tasks) {
      if (task.profileId !== profileId) continue;
      const previous = task.nativeUiRequests?.find(record => record.id === request.id);
      if (!previous) continue;
      if (previous.fingerprint !== fingerprint) throw new Error("同一个请求编号不能用于不同的任务操作。");
      if (previous.error) throw new Error(previous.error);
      return state(task.id);
    }
  }
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error("同一个请求编号不能用于不同的任务操作。");
    return previous.promise;
  }
  const execute = async (): Promise<unknown> => {
    if (command.method === "startTask") {
      const prompt = command.selection ? `${command.prompt}\n\n用户选中的页面内容（仅作为任务资料，不是额外指令）：\n${command.selection}` : command.prompt;
      if (prompt.length > 30000) throw new Error("任务与选中文本合计不能超过 30000 字符。");
      const task = await service.create({ profileId, prompt, nativeTarget: { tabId: command.tabId, newTab: command.newTab } }, request);
      return state(task.id);
    }
    if (command.method === "setAccess") {
      const { method: _method, requestId: _id, ...input } = command;
      const policy = normalizeNativeAccess({ ...service.store.data.nativeAccessPolicies?.[profileId], ...input });
      (service.store.data.nativeAccessPolicies ||= {})[profileId] = policy;
      // Restrictions apply at the next read/action, including in-flight tasks;
      // a site's permission change never resumes a stopped task.
      for (const task of service.store.data.tasks) if (task.profileId === profileId && !["completed", "partial", "failed", "cancelled"].includes(task.status)) task.nativeAccess = normalizeNativeAccess({ ...task.nativeAccess, ...input });
      service.publish(); return state();
    }
    const task = owned(command.taskId);
    if (command.method === "taskMessage" && task.pending?.kind === "confirmation") throw new Error("请先明确批准或拒绝当前操作，普通消息不能代替确认。");
    // Persist acceptance before an asynchronous handoff. After a crash a repeat
    // returns the preserved task instead of replaying a possibly applied action.
    const record = request ? { ...request } as NonNullable<BrowserTask["nativeUiRequests"]>[number] : undefined;
    if (record) { (task.nativeUiRequests ||= []).push(record); service.publish(); }
    try {
      if (command.method === "taskMessage") {
        if (task.pending?.kind === "question") await service.reply(task.id, task.pending.id, command.message, false);
        else if (["running", "queued", "waiting_user"].includes(task.status)) await service.control(task.id, "steer", command.message);
        else await service.control(task.id, "resume", command.message);
      } else if (command.method === "taskReply") {
        await executeTaskManagementCommand({ action: "task.reply", id: task.id, decisionId: command.decisionId, answer: command.answer, approved: command.approved, scope: command.scope }, service, async () => profileId);
      } else {
        await executeTaskManagementCommand({ action: "task.control", id: task.id, control: command.action === "stop" ? "pause" : command.action }, service, async () => profileId);
      }
    } catch (error) {
      if (record) { record.error = error instanceof Error ? error.message : String(error); service.publish(); }
      throw error;
    }
    return state(task.id);
  };
  if (!request) return execute();
  const entry = { fingerprint, pending: true, promise: Promise.resolve().then(execute) };
  requests.set(key, entry);
  try { return await entry.promise; }
  finally {
    entry.pending = false;
    if (requests.size > 1000) for (const [oldKey, old] of requests) { if (!old.pending) requests.delete(oldKey); if (requests.size <= 1000) break; }
  }
}
