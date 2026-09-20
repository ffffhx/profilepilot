import { BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from "electron";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TASK_CHANNEL, TASK_CHANGED, TERMINAL_TASKS, jevProviderFor, type JevProvider, type TaskSchedule } from "../../shared/tasks";
import type { ProfileManager } from "../profile-manager";
import { defaultDataDir } from "../fs-util";
import { WrapperBrowser } from "./browser";
import { TaskStore, createTaskSchema, scrubDiagnostics, now } from "./store";
import { TaskService, workerEnvironment } from "./service";
import { JEV_KEYS_URL, JEV_BILLING_URL, JEV_CONSOLE_URL, testJevConnection } from "./jev";
import { writeAgentBrowserControlWaitStateSync, clearAgentBrowserControlWaitStateSync } from "../agent-browser-session";

export function registerTaskService(profileManager: ProfileManager): TaskService {
  const root = path.join(process.env.CPM_DATA_DIR || defaultDataDir(), "browser-tasks");
  const store = new TaskStore(root);
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
  const service = new TaskService(store, {
    browser: new WrapperBrowser(path.join(root, "artifacts")), apiKey, jevApiKey,
    profileName: async (id) => {
      const profile = (await profileManager.getState()).profiles.find((entry) => entry.id === id);
      if (!profile || profile.source !== "isolated" || profile.agentAccessDisabled) throw new Error("请选择允许 Agent 连接的独立 Profile。");
      return profile.name;
    },
    prepareProfile: async (id) => {
      const port = await profileManager.prepareProfileForAgent(id);
      await profileManager.launchProfileWithCdp(id, port);
      return { port, name: (await profileManager.getState()).profiles.find((profile) => profile.id === id)?.name || id };
    },
    changed: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(TASK_CHANGED, snapshot);
    },
    notify: (title, body, taskId) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: `ProfilePilot · ${title}`, body });
      notification.on("click", () => {
        const window = BrowserWindow.getAllWindows().find(window => /\/(tasks|index)\.html(?:\?|$)/.test(window.webContents.getURL()));
        if (!window) return;
        if (window.isMinimized()) window.restore(); window.show(); window.focus();
        if (taskId) void window.loadFile(path.resolve(__dirname, "../../../public/tasks.html"), { query: { task: taskId } });
      });
      notification.show();
    },
    controlReceiver: (sessionId, waiting) => {
      if (waiting) writeAgentBrowserControlWaitStateSync(sessionId);
      else clearAgentBrowserControlWaitStateSync(sessionId, process.pid);
    }
  });
  const idSchema = z.string().uuid();
  ipcMain.handle(TASK_CHANNEL, async (event, method: string, ...args: any[]) => {
    const url = event.senderFrame?.url || "";
    let source = "";
    try { source = fileURLToPath(url.split("?")[0]); } catch { throw new Error("任务接口只能由本地桌面界面调用。"); }
    const publicDir = path.resolve(__dirname, "../../../public");
    if (!["tasks.html", "index.html"].some((name) => path.resolve(source) === path.join(publicDir, name))) throw new Error("不允许此页面调用任务接口。");
    switch (method) {
      case "snapshot": return store.snapshot();
      case "create": return service.create(createTaskSchema.parse(args[0]));
      case "retryItems": return service.retryItems(idSchema.parse(args[0]), z.array(idSchema).min(1).max(500).parse(args[1]));
      case "control": return service.control(idSchema.parse(args[0]), z.enum(["pause", "resume", "takeover", "cancel", "rerun", "steer"]).parse(args[1]), z.string().max(30000).parse(args[2] || ""));
      case "reply": return service.reply(idSchema.parse(args[0]), idSchema.parse(args[1]), z.string().max(30000).parse(args[2] || ""), z.boolean().parse(args[3]));
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
        const dir = path.join(root, "attachments"); mkdirSync(dir, { recursive: true, mode: 0o700 });
        const validated = result.filePaths.map((file) => {
          const stat = statSync(file); if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("附件需为小于 50 MB 的文件。");
          const id = randomUUID(); const destination = path.join(dir, `${id}${path.extname(file).slice(0, 20)}`);
          return { source: file, id, name: path.basename(file), path: destination, size: stat.size };
        });
        const copied: string[] = [];
        try { for (const file of validated) { copyFileSync(file.source, file.path); copied.push(file.path); } }
        catch (error) { for (const file of copied) rmSync(file, { force: true }); throw error; }
        const files = validated.map(({ source: _source, ...file }) => file);
        store.data.attachments.push(...files); service.publish(); return files;
      }
      case "deleteAttachment": {
        const id = idSchema.parse(args[0]);
        if (store.data.tasks.some((task) => !TERMINAL_TASKS.has(task.status) && task.attachments.some((file) => file.id === id))) throw new Error("附件仍被未结束的任务使用。");
        if ([...store.data.templates, ...store.data.schedules].some(item => item.task.attachmentIds?.includes(id))) throw new Error("附件被模板或计划引用，请先编辑相应任务。");
        const file = store.data.attachments.find((file) => file.id === id);
        if (file && path.resolve(file.path).startsWith(path.resolve(root, "attachments") + path.sep)) rmSync(file.path, { force: true });
        store.data.attachments = store.data.attachments.filter((file) => file.id !== id); service.publish(); return;
      }
      case "saveSettings": {
        const input = z.object({ model: z.string().trim().min(1).max(200), baseUrl: z.string().url(), authMode: z.enum(["apiKey", "bearer"]).optional(), maxConcurrent: z.number().int().min(1).max(6), retentionDays: z.number().int().min(1).max(3650), saveScreenshots: z.boolean(), notifications: z.boolean(), apiKey: z.string().max(1000).optional() }).parse(args[0]);
        const endpoint = new URL(input.baseUrl);
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
      }
      case "testConnection": return testConnection(store, apiKey());
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
      case "exportData": {
        const kind = z.enum(["task", "materials", "diagnostics"]).parse(args[0]);
        const value = kind === "materials" ? store.data.materials : kind === "diagnostics" ? scrubDiagnostics(store.data) : store.get(idSchema.parse(args[1]));
        const target = await dialog.showSaveDialog({ title: "导出本地数据", defaultPath: `profilepilot-${kind}-${Date.now()}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
        if (target.canceled || !target.filePath) return null;
        writeFileSync(target.filePath, JSON.stringify(value, (key, value) => key === "screenshotDataUrl" ? undefined : value, 2), { encoding: "utf8", mode: 0o600 });
        return target.filePath;
      }
      case "openArtifact": {
        const id = idSchema.parse(args[0]);
        const file = args[1] ? store.get(idSchema.parse(args[1])).outputs?.find((file) => file.id === id) : store.data.attachments.find((file) => file.id === id);
        if (!file) throw new Error("附件不存在。");
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
    function finish(error?: Error): void { if (done) return; done = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve("模型连接成功。"); }
    child.stdout?.resume(); child.stderr?.resume();
    child.on("message", (message: any) => {
      if (message.kind === "result") finish(message.success ? undefined : new Error(message.result));
      if (message.kind === "error") finish(new Error(message.text));
    });
    child.on("error", finish); child.on("exit", () => { if (!done) finish(new Error("SDK 进程提前退出。")); });
    child.send({ kind: "start", test: true, task: {}, settings: store.data.settings, apiKey: key, cwd });
  });
}
