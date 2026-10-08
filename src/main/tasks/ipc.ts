import { BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from "electron";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkspaceShell } from "../workspace-shell";
import { IPC_CHANNELS } from "../../shared/ipc";
import { z } from "zod";
import { taskLinkUrl } from "../../shared/task-link";
import { TASK_CHANNEL, TASK_CHANGED, TASK_PREVIEW, TERMINAL_TASKS, jevProviderFor, type JevProvider, type TaskSchedule } from "../../shared/tasks";
import { TaskPreviewStream } from "./preview";
import type { ProfileManager } from "../profile-manager";
import { defaultDataDir } from "../fs-util";
import { WrapperBrowser } from "./browser";
import { BrowserServiceClient } from "../browser-service/client";
import { browserServiceLaunchInfo, saveBrowserServiceLaunch } from "../browser-service/launcher";
import { nativeProfileAvailability } from "./native-compatibility";
import { executeNativeUiCommand } from "./management";
import { NativeBrowser, RoutedBrowser, isNativeTask } from "./native-browser";
import { NativePreviewStream } from "./native-preview";
import { TaskStore, createTaskSchema, scrubDiagnostics, now } from "./store";
import { listServiceModels } from "./model-catalog";
import { TaskService, workerEnvironment } from "./service";
import { redactProviderSecrets } from "./conversation";
import { previewTaskFile, taskMarkdown } from "./presentation";
import { JEV_KEYS_URL, JEV_BILLING_URL, JEV_CONSOLE_URL, testJevConnection } from "./jev";
import { writeAgentBrowserControlWaitStateSync, clearAgentBrowserControlWaitStateSync } from "../agent-browser-session";
const messageOptions = z.object({ requestId: z.string().min(1).max(200).optional(), attachmentIds: z.array(z.string().uuid()).max(50).optional() }).strict();

export function registerTaskService(profileManager: ProfileManager): TaskService {
  const root = path.join(process.env.CPM_DATA_DIR || defaultDataDir(), "browser-tasks");
  const store = new TaskStore(root);
  const previews = new Map<number, { taskId: string; stream: TaskPreviewStream | NativePreviewStream }>();
  const previewSenders = new WeakSet<Electron.WebContents>();
  const stopPreview = (id: number): void => { previews.get(id)?.stream.close(); previews.delete(id); };
  const vaultPath = path.join(root, "credentials.bin");
  // The original vault belongs to Vercel. Never send a saved key to a different provider.
  const jevVault = (provider: JevProvider) => path.join(root, provider === "typesafe" ? "jev-typesafe-credentials.bin" : "jev-credentials.bin");
  store.data.settings.jevProvider ||= existsSync(jevVault("vercel")) ? "vercel" : "typesafe";
  store.data.settings.jevMode ||= "driver";
  const jevApiKey = (): string => {
    const jevVaultPath = jevVault(jevProviderFor(store.data.settings));
    if (!existsSync(jevVaultPath)) return "";
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据保护不可用，无法读取 Jev 密钥。");
    return safeStorage.decryptString(readFileSync(jevVaultPath));
  };
  const apiKey = (): string => {
    if (!existsSync(vaultPath)) return "";
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据保护不可用，无法读取 API 密钥。");
    return safeStorage.decryptString(readFileSync(vaultPath));
  };
  store.data.settings.hasApiKey = existsSync(vaultPath);
  store.data.settings.hasJevApiKey = existsSync(jevVault(jevProviderFor(store.data.settings)));
  store.data.settings.jevEnabled = store.data.settings.jevEnabled === true && store.data.settings.hasJevApiKey;
  store.save();
  saveBrowserServiceLaunch(root, browserServiceLaunchInfo(path.resolve(__dirname, '../../..')));
  const native = new BrowserServiceClient(root, () => broadcast());
  let service!: TaskService;
  const snapshot = () => ({ ...store.snapshot(), streams: Object.fromEntries(service?.streams || []), nativeBrowsers: native.states(), nativeInstallations: native.installationStates() });
  const broadcast = () => { const value = snapshot(); for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(TASK_CHANGED, value); };
  const saveSettings = (patch: Partial<import("../../shared/tasks").TaskSettings> & { apiKey?: string }): void => {
    const input = z.object({ model: z.string().trim().min(1).max(200), baseUrl: z.string().url(), authMode: z.enum(["apiKey", "bearer"]).optional(), maxConcurrent: z.number().int().min(1).max(6), retentionDays: z.number().int().min(1).max(3650), saveScreenshots: z.boolean(), notifications: z.boolean(), apiKey: z.string().max(1000).optional() }).partial().parse(patch);
    const endpoint = new URL(input.baseUrl || store.data.settings.baseUrl);
    if (endpoint.origin !== new URL(store.data.settings.baseUrl).origin && !input.apiKey?.trim() && existsSync(vaultPath)) throw new Error("切换模型服务时请输入新服务的 API 密钥，避免将原密钥发送给其他服务。");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw new Error("模型地址需要 HTTPS，本机服务可使用 HTTP；不能包含凭据或查询参数。");
    if (input.apiKey !== undefined) {
      if (!input.apiKey.trim()) { if (existsSync(vaultPath)) rmSync(vaultPath); }
      else {
        if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error("系统安全存储不可用，未保存密钥。");
        writeFileSync(vaultPath, safeStorage.encryptString(input.apiKey.trim()), { mode: 0o600 });
      }
    }
    const { apiKey: _secret, ...settings } = input;
    store.data.settings = { ...store.data.settings, ...settings, hasApiKey: existsSync(vaultPath) };
    service.publish(); void service.tick(); return;
  };
  service = new TaskService(store, {
    profileAvailability: id => id.startsWith("native:") ? nativeProfileAvailability(native.states().find(state => state.profileId === id)) : undefined,
    saveSettings, testConnection: () => testConnection(store, apiKey()), listModels: () => listServiceModels(store.data.settings, apiKey()),
    closePreview: () => { for (const id of previews.keys()) stopPreview(id); },
    closeBrowser: () => native.close(),
    browser: new RoutedBrowser(new WrapperBrowser(path.join(root, "artifacts")), new NativeBrowser(native, path.join(root, "artifacts"))), apiKey, jevApiKey,
    profileName: async (id) => {
      const profile = (await profileManager.getState()).profiles.find((entry) => entry.id === id);
      if (!profile) throw new Error("请选择有效的浏览器 Profile。");
      if (profile.source !== "native" && (profile.source !== "isolated" || profile.agentAccessDisabled)) throw new Error("请选择允许 Agent 连接的独立 Profile。");
      return profile.name;
    },
    prepareProfile: async (id) => {
      const profile = (await profileManager.getState()).profiles.find(p => p.id === id);
      if (!profile) throw new Error("Profile 不存在。");
      if (profile.source === "native") {
        const availability = nativeProfileAvailability(native.states().find(state => state.profileId === id));
        if (!availability.ready) throw new Error(availability.reason);
        return { name: profile.name, browserConnection: "extension" };
      }
      if (profile.source !== "isolated" || profile.agentAccessDisabled) throw new Error("请选择允许 Agent 连接的独立 Profile。");
      const port = await profileManager.prepareProfileForAgent(id);
      await profileManager.launchProfileWithCdp(id, port);
      return { port, name: (await profileManager.getState()).profiles.find((profile) => profile.id === id)?.name || id };
    },
    changed: broadcast,
    notify: (title, body, taskId) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: `ProfilePilot · ${title}`, body });
      notification.on("click", () => {
        const window = BrowserWindow.getAllWindows().find(window => isWorkspaceShell(window.webContents.getURL(), path.resolve(__dirname, "../../../public")) || /\/(tasks|index)\.html(?:\?|$)/.test(window.webContents.getURL()));
        if (!window) return;
        if (window.isMinimized()) window.restore(); window.show(); window.focus();
        if (taskId) {
          if (isWorkspaceShell(window.webContents.getURL(), path.resolve(__dirname, "../../../public"))) window.webContents.send(IPC_CHANNELS.navigateWorkspace, `./tasks.html?task=${encodeURIComponent(taskId)}`);
          else void window.loadFile(path.resolve(__dirname, "../../../public/tasks.html"), { query: { task: taskId } });
        }
      });
      notification.show();
    },
    controlReceiver: (sessionId, waiting) => {
      if (waiting) writeAgentBrowserControlWaitStateSync(sessionId);
      else clearAgentBrowserControlWaitStateSync(sessionId, process.pid);
    }
  });
  native.configureUi(async (profileId, method, params) => {
    if (!(await profileManager.getState()).profiles.some(profile => profile.id === profileId && profile.source === "native")) throw new Error("Profile 不存在。");
    const result = await executeNativeUiCommand(profileId, method, params, service) as Record<string, unknown>;
    return { ...result, browser: native.states().find(state => state.profileId === profileId) };
  });
  native.onEvent(event => {
    if (event.type === "cdp") return;
    if (event.type === "state" && event.state?.connected && event.state.taskTabs && !event.state.ownerSessionId && !event.state.pausedByBrowser) service.reconcileIdleNativeProfile(event.profileId);
    if (event.sessionId && !native.isDirectSession(event.profileId, event.sessionId)) {
      const task = store.data.tasks.find(t => t.profileId === event.profileId && t.sessionId === event.sessionId);
      if ((!task || TERMINAL_TASKS.has(task.status)) && event.state?.ownerSessionId) {
        void native.request(event.profileId, "control", { action: "release", sessionId: event.sessionId }).catch(() => {});
      } else service.externalControl(event.sessionId, event.state?.ownership || "user", "active", event.type === "disconnected" ? "extension-disconnected" : event.state?.ownership === "agent" ? "user-return" : event.state?.pausedByBrowser ? "extension-paused" : "extension-takeover");
    }
    broadcast();
  });
  // The desktop subscribes to the same independent service used by the CLI.
  // Fresh installations can start it on their first explicit browser action.
  if (existsSync(path.join(root, 'native-browser-credentials.bin')) || existsSync(path.join(root, 'native-control.json'))) {
    void native.start().catch(error => { console.error('浏览器服务连接失败：', error); broadcast(); });
  }
  const idSchema = z.string().uuid();
  ipcMain.handle(TASK_CHANNEL, async (event, method: string, ...args: any[]) => {
    const url = event.senderFrame?.url || "";
    let source = "";
    try { source = fileURLToPath(url.split("?")[0]); } catch { throw new Error("任务接口只能由本地桌面界面调用。"); }
    const publicDir = path.resolve(__dirname, "../../../public");
    const shellFrame = isWorkspaceShell(url, path.resolve(__dirname, "../../../public")) && event.senderFrame === event.sender?.mainFrame;
    if (!shellFrame && !["tasks.html", "index.html", "tools.html"].some((name) => path.resolve(source) === path.join(publicDir, name))) throw new Error("不允许此页面调用任务接口。");
    switch (method) {
      case "watchPreview": {
        const id = z.string().uuid().nullable().parse(args[0]);
        const sender = event.sender;
        if (previews.get(sender.id)?.taskId === id) return;
        stopPreview(sender.id);
        if (!id) return;
        const task = store.get(id);
        if (isNativeTask(task)) for (const [otherId, item] of previews) {
          if (otherId !== sender.id && store.data.tasks.find(t => t.id === item.taskId)?.profileId === task.profileId) stopPreview(otherId);
        }
        if (!previewSenders.has(sender)) {
          previewSenders.add(sender);
          sender.once("destroyed", () => stopPreview(sender.id));
          sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (mainFrame) stopPreview(sender.id); });
        }
        const emit = (update: import("../../shared/tasks").TaskPreviewUpdate) => {
          if (!sender.isDestroyed()) sender.send(TASK_PREVIEW, update);
        };
        const getTask = () => store.data.tasks.find(t => t.id === id);
        const stream = isNativeTask(task) ? new NativePreviewStream(native, getTask, emit) : new TaskPreviewStream(getTask, emit);
        previews.set(sender.id, { taskId: id, stream }); stream.start(); return;
      }
      case "ackPreview": {
        const id = idSchema.parse(args[0]); const frameId = z.number().int().positive().parse(args[1]);
        const preview = previews.get(event.sender.id);
        if (preview?.taskId === id) preview.stream.ack(frameId);
        return;
      }
      case "snapshot": return snapshot();
      case "authorizeNativeBrowser":
      case "pairNativeBrowser": {
        const id = z.string().max(150).parse(args[0]);
        const profile = (await profileManager.getState()).profiles.find(p => p.id === id && p.source === "native");
        if (!profile) throw new Error("请选择本机已发现的系统 Chrome Profile。");
        if (store.data.tasks.some(t => t.profileId === id && t.status === "running")) throw new Error("请先暂停此 Profile 上的任务，再重新配对。");
        if (method === "authorizeNativeBrowser") {
          const request = await native.authorize(id, profile.name);
          await profileManager.launchProfileWithUrls(id, [request.url]);
          await native.beginInstallation(request.url);
          return { expiresAt: request.expiresAt };
        }
        return native.pair(id);
      }
      case "disconnectNativeBrowser": {
        const id = z.string().max(150).parse(args[0]);
        if (!(await profileManager.getState()).profiles.some(p => p.id === id && p.source === "native")) throw new Error("Profile 不存在。");
        await native.disconnect(id); broadcast(); return;
      }
      case "openNativeExtensionFolder": {
        await native.revealExtension(); return;
      }
      case "focusTaskBrowser": {
        const task = store.get(idSchema.parse(args[0]));
        if (isNativeTask(task)) await native.request(task.profileId, "focus", { sessionId: task.sessionId });
        else await profileManager.focusProfile(task.profileId);
        return;
      }
      case "create": return service.create(createTaskSchema.parse(args[0]));
      case "retryItems": return service.retryItems(idSchema.parse(args[0]), z.array(idSchema).min(1).max(500).parse(args[1]));
      case "control": return service.control(idSchema.parse(args[0]), z.enum(["pause", "resume", "takeover", "cancel", "rerun", "steer", "queue"]).parse(args[1]), z.string().max(30000).parse(args[2] || ""), messageOptions.parse(args[3] || {}));
      case "reply": {
        const options = messageOptions.extend({ scope: z.enum(["once", "session"]).optional() }).parse(args[4] || {});
        return service.reply(idSchema.parse(args[0]), idSchema.parse(args[1]), z.string().max(30000).parse(args[2] || ""), z.boolean().parse(args[3]), options.scope, options);
      }
      case "queue": return service.queue(idSchema.parse(args[0]), z.string().min(1).max(200).optional().parse(args[1]));
      case "permissions": return service.permissions(idSchema.parse(args[0]), z.union([idSchema, z.literal("all")]).optional().parse(args[1]));
      case "setLimits": return service.setLimits(idSchema.parse(args[0]), args[1]);
      case "setModel": return service.setModel(idSchema.parse(args[0]), z.string().trim().min(1).max(200).parse(args[1]));
      case "saveMaterial": {
        const data = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(100), scope: z.string().max(300).default(""), content: z.string().trim().min(1).max(60000) }).parse(args[0]);
        const previous = store.data.materials.find((item) => item.id === data.id);
        if (data.id && !previous) throw new Error("资料不存在。");
        const material = { ...data, id: data.id || randomUUID(), version: (previous?.version || 0) + 1, updatedAt: now() };
        store.data.materials = [material, ...store.data.materials.filter((item) => item.id !== material.id)];
        service.publish(); return material;
      }
      case "deleteMaterial": {
        const id = idSchema.parse(args[0]);
        if ([...store.data.templates, ...store.data.schedules].some(item => item.task.materialIds?.includes(id))) throw new Error("资料被模板或计划引用，请先编辑相应任务。");
        store.data.materials = store.data.materials.filter((item) => item.id !== id); service.publish(); return;
      }
      case "importAttachments": {
        const result = await dialog.showOpenDialog({ title: "选择任务附件", properties: ["openFile", "multiSelections"] });
        if (result.canceled) return [];
        return service.importAttachmentPaths(result.filePaths);
      }
      case "deleteAttachment": {
        const id = idSchema.parse(args[0]);
        if (store.data.tasks.some((task) => task.attachments.some((file) => file.id === id) || task.messageQueue?.some(message => message.attachmentIds.includes(id)))) throw new Error("附件仍被会话历史或排队消息使用，请先移除相应引用或删除会话。");
        if ([...store.data.templates, ...store.data.schedules].some(item => item.task.attachmentIds?.includes(id))) throw new Error("附件被模板或计划引用，请先编辑相应任务。");
        const file = store.data.attachments.find((file) => file.id === id);
        if (file && path.resolve(file.path).startsWith(path.resolve(root, "attachments") + path.sep)) rmSync(file.path, { force: true });
        store.data.attachments = store.data.attachments.filter((file) => file.id !== id); service.publish(); return;
      }
      case "saveSettings": return saveSettings(args[0]);
      case "testConnection": return testConnection(store, apiKey());
      case "listModels": return listServiceModels(store.data.settings, apiKey());
      case "saveJevSettings": {
        const input = z.object({ enabled: z.boolean(), provider: z.enum(["typesafe", "vercel"]).optional(), mode: z.enum(["driver", "advisory"]).optional(), apiKey: z.string().trim().max(1000).optional() }).parse(args[0]);
        const provider = input.provider || jevProviderFor(store.data.settings);
        const jevVaultPath = jevVault(provider);
        const deleting = input.apiKey === "";
        if (input.enabled && !deleting && !input.apiKey && !existsSync(jevVaultPath)) throw new Error(`请先填写 ${provider === "typesafe" ? "TypeSafe" : "Vercel AI Gateway"} API Key，再启用 Jev。`);
        if (deleting) rmSync(jevVaultPath, { force: true });
        else if (input.apiKey) {
          if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error("系统安全存储不可用，未保存 Jev 密钥。");
          writeFileSync(jevVaultPath, safeStorage.encryptString(input.apiKey), { mode: 0o600 });
        }
        store.data.settings.jevProvider = provider;
        store.data.settings.jevMode = input.mode || store.data.settings.jevMode || "driver";
        store.data.settings.hasJevApiKey = existsSync(jevVaultPath);
        store.data.settings.jevEnabled = input.enabled && store.data.settings.hasJevApiKey;
        service.publish(); return;
      }
      case "testJevConnection": return testJevConnection(jevApiKey(), jevProviderFor(store.data.settings));
      case "openLink": {
        const url = taskLinkUrl(args[0]);
        if (!url) throw new Error("只能打开有效的 HTTP 或 HTTPS 网页链接。");
        return shell.openExternal(url);
      }
      case "openJevConsole": {
        const page = z.enum(["keys", "billing"]).parse(args[0]);
        return shell.openExternal(jevProviderFor(store.data.settings) === "typesafe" ? JEV_CONSOLE_URL : page === "keys" ? JEV_KEYS_URL : JEV_BILLING_URL);
      }
      case "saveSchedule": {
        const input = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(100), task: createTaskSchema, at: z.string().datetime(), timezone: z.string().min(1).max(100), repeat: z.enum(["once", "daily"]), enabled: z.boolean() }).parse(args[0]);
        new Intl.DateTimeFormat("zh-CN", { timeZone: input.timezone });
        if (input.enabled && Date.parse(input.at) <= Date.now()) throw new Error("请选择未来的执行时间。");
        const previous = store.data.schedules.find(schedule => schedule.id === input.id);
        if (input.id && !previous) throw new Error("计划不存在。");
        const schedule: TaskSchedule = { ...previous, ...input, id: input.id || randomUUID(), missedAt: previous?.at === input.at ? previous.missedAt : undefined };
        store.data.schedules = [schedule, ...store.data.schedules.filter((value) => value.id !== schedule.id)]; service.publish(); return schedule;
      }
      case "deleteSchedule": { const id = idSchema.parse(args[0]); store.data.schedules = store.data.schedules.filter((entry) => entry.id !== id); service.publish(); return; }
      case "saveTemplate": {
        const input = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(100), task: createTaskSchema }).parse(args[0]);
        if (input.id && !store.data.templates.some(template => template.id === input.id)) throw new Error("模板不存在。");
        const template = { ...input, id: input.id || randomUUID(), updatedAt: now() };
        store.data.templates = [template, ...store.data.templates.filter(template => template.id !== input.id)]; service.publish(); return template;
      }
      case "deleteTemplate": { const id = idSchema.parse(args[0]); store.data.templates = store.data.templates.filter(template => template.id !== id); service.publish(); return; }
      case "deleteTask": return service.deleteTask(idSchema.parse(args[0]));
      case "updateTaskMetadata": return service.updateTaskMetadata(idSchema.parse(args[0]), args[1]);
      case "exportData": {
        const kind = z.enum(["task", "task-markdown", "materials", "diagnostics"]).parse(args[0]);
        const value = kind === "materials" ? store.data.materials : kind === "diagnostics" ? scrubDiagnostics(store.data) : store.get(idSchema.parse(args[1]));
        const markdown = kind === "task-markdown";
        const target = await dialog.showSaveDialog({ title: "导出本地数据", defaultPath: `profilepilot-${kind}-${Date.now()}.${markdown ? "md" : "json"}`, filters: [{ name: markdown ? "Markdown" : "JSON", extensions: [markdown ? "md" : "json"] }] });
        if (target.canceled || !target.filePath) return null;
        writeFileSync(target.filePath, markdown ? taskMarkdown(store.get(idSchema.parse(args[1]))) : JSON.stringify(value, (key, value) => key === "screenshotDataUrl" ? undefined : value, 2), { encoding: "utf8", mode: 0o600 });
        return target.filePath;
      }
      case "previewArtifact":
      case "openArtifact": {
        const id = idSchema.parse(args[0]);
        const task = args[1] ? store.get(idSchema.parse(args[1])) : undefined;
        const file = task ? [...task.attachments, ...(task.outputs || [])].find(file => file.id === id) : store.data.attachments.find(file => file.id === id);
        if (!file) throw new Error("附件不存在。");
        if (method === "previewArtifact") return previewTaskFile(file);
        const error = await shell.openPath(file.path); if (error) throw new Error(error); return;
      }
      default: throw new Error("未知任务操作。");
    }
  });
  service.start();
  return service;
}

async function testConnection(store: TaskStore, key: string): Promise<string> {
  if (!key) throw new Error("请先保存 API 密钥。");
  const cwd = path.join(store.root, "connection-test"); mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "worker.js"), [], { cwd, env: workerEnvironment(), execArgv: [], ...{ windowsHide: true }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let done = false;
    const timer = setTimeout(() => finish(new Error("连接测试超时，请检查网络、模型名称及 API 配置。")), 60000);
    function finish(error?: Error): void { if (done) return; done = true; clearTimeout(timer); child.kill(); error ? reject(new Error(redactProviderSecrets(error.message, [key]))) : resolve("模型连接成功。"); }
    child.stdout?.resume(); child.stderr?.resume();
    child.on("message", (message: any) => {
      if (message.kind === "result") finish(message.success ? undefined : new Error(message.result));
      if (message.kind === "error") finish(new Error(message.text));
    });
    child.on("error", finish); child.on("exit", () => { if (!done) finish(new Error("SDK 进程提前退出。")); });
    child.send({ kind: "start", test: true, task: {}, settings: store.data.settings, apiKey: key, cwd });
  });
}
