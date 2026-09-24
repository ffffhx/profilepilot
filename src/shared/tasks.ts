export type TaskStatus = "queued" | "running" | "waiting_user" | "paused" | "completed" | "partial" | "failed" | "cancelled";
export type ItemStatus = "pending" | "running" | "waiting_user" | "completed" | "skipped" | "failed" | "uncertain";
export type Effect = "read" | "edit" | "submit" | "send" | "purchase" | "delete";
export interface ExecutionGrant { origin: string; effects: Array<"submit" | "send" | "delete">; maxActions: number; used: number; }
export interface TaskAttachment { id: string; name: string; path: string; size: number; }
export interface PersonalMaterial { id: string; name: string; scope: string; content: string; version: number; updatedAt: string; }
export interface TaskItem { id: string; label: string; status: ItemStatus; result?: string; evidence?: string; }
export interface TaskEvent { id: string; at: string; kind: "user" | "assistant" | "action" | "system" | "error"; text: string; }
export interface JevAssessment {
  status: "ready" | "uncertain" | "unavailable"; model: string; version: string; elapsedMs: number; inputTokens: number; note: string;
  answers?: { page: { type: "choice"; choice: string; probabilities?: Record<string, number> };
    next: { type: "choice"; choice: string; probabilities?: Record<string, number> };
    humanRequired: { type: "boolean"; probability: number }; consequence: { type: "score"; score: number; probabilities?: Record<string, number> } };
  confidence?: Record<string, number>;
}
export interface BrowserObservation {
  version: string; fingerprint: string; at: string; url: string; title: string;
  snapshot: string; screenshotPath?: string; screenshotDataUrl?: string; account: string;
  jev?: JevAssessment;
  viewport?: { width: number; height: number; x: number; y: number; scrollWidth: number; scrollHeight: number };
  fast?: { document: string; guard: string; candidates: BrowserCandidate[] };
}
export interface BrowserCandidate {
  ref: string; role: string; label: string; kind: "click" | "fill" | "select";
  value?: string; checked?: boolean; options?: Array<{ value: string; label: string }>;
  submit?: boolean;
  href?: string;
  offscreen?: boolean;
}
export interface BrowserAction {
  kind: "open" | "click" | "hover" | "fill" | "select" | "check" | "uncheck" | "press" | "scroll" | "upload" | "download" | "back" | "switch_tab" | "close_tab";
  version?: string; ref?: string; value?: string; attachmentId?: string;
  effect: Effect; summary: string;
}
export interface TaskDecision {
  id: string; kind: "question" | "confirmation" | "handoff"; title: string;
  details: string; action?: BrowserAction; observationVersion?: string; createdAt: string;
}
export interface TaskReceipt {
  id: string; at: string; action: BrowserAction; status: "started" | "executed" | "uncertain";
  result?: string; observationVersion?: string;
  reconciliation?: { outcome: "completed" | "not_completed" | "uncertain"; evidence: string; at: string };
}
export interface TaskResult { summary: string; evidence: string[]; remaining: string[]; }
export interface JevDecisionRecord {
  at: string; mode: "driver" | "advisory"; status: "running" | "completed" | "interrupted";
  operation?: string; target?: string; probability?: number; confidence?: number;
  elapsedMs: number; inputTokens: number; note?: string; outcome?: string;
}
export interface BrowserTask {
  costAccounting?: { version: string; sessionId: string; sdkUsd: number; originalUsd?: number; correctedAt?: string };
  cachedInputTokens?: number;
  costRecords?: TaskCostRecord[];
  modelTokenUsage?: ModelTokenUsage[];
  browserConnection?: "gateway" | "extension";
  browserReleasePending?: boolean;
  modelRuns?: TaskModelRun[];
  id: string; title: string; prompt: string; profileId: string; profileName: string;
  pinnedAt?: string; archivedAt?: string; metadataUpdatedAt?: string;
  status: TaskStatus; createdAt: string; updatedAt: string; sessionId: string; sdkSessionId?: string;
  runningSince?: string;
  sourceTaskId?: string;
  port?: number; authorization: string; attachments: TaskAttachment[]; materials: PersonalMaterial[];
  events: TaskEvent[]; items: TaskItem[]; plan: string[]; receipts: TaskReceipt[];
  pending?: TaskDecision; observation?: BrowserObservation; result?: TaskResult;
  evidencePages?: Array<Pick<BrowserObservation, "version" | "at" | "url" | "title" | "snapshot">>;
  execution?: { engine: "preparing" | "jev" | "model"; activity: string; at: string; reason?: string };
  jevDecisions?: JevDecisionRecord[];
  resumeContext?: { reason: string; url?: string; userResponse?: string; returnedAt?: string; observed?: boolean };
  usage: { inputTokens: number; outputTokens: number; costUsd: number; elapsedMs: number; actions: number; jev?: { calls: number; completedCalls?: number; inputTokens: number; elapsedMs: number }; helper?: { calls: number; inputTokens: number; outputTokens: number; elapsedMs: number }; jevActions?: number };
  limits: { minutes: number; actions: number; budgetUsd: number };
  needsReconciliation: boolean; scheduledBy?: string;
  grant?: ExecutionGrant;
  outputs?: TaskAttachment[];
}
export interface CreateTaskInput {
  prompt: string; profileId: string; authorization?: string; materialIds?: string[];
  attachmentIds?: string[]; items?: string[]; limits?: Partial<BrowserTask["limits"]>;
  grant?: Omit<ExecutionGrant, "used">;
}
export interface TaskMetadataInput { title?: string; pinned?: boolean; archived?: boolean; }
export interface TaskSchedule {
  id: string; name: string; task: CreateTaskInput; at: string; timezone: string;
  repeat: "once" | "daily"; enabled: boolean; lastRunAt?: string; lastTaskId?: string; missedAt?: string;
}
export interface TaskTemplate { id: string; name: string; task: CreateTaskInput; updatedAt: string; }
export type JevProvider = "typesafe" | "vercel";
export interface TaskSettings {
  authMode?: "apiKey" | "bearer";
  model: string; baseUrl: string; maxConcurrent: number; retentionDays: number;
  saveScreenshots: boolean; notifications: boolean; hasApiKey: boolean;
  jevEnabled?: boolean; hasJevApiKey?: boolean; jevProvider?: JevProvider;
  jevMode?: "driver" | "advisory";
}
export function jevProviderFor(settings: TaskSettings): JevProvider {
  return settings.jevProvider || (settings.hasJevApiKey ? "vercel" : "typesafe");
}
export interface TaskSnapshot {
  tokenRecords?: TaskTokenRecord[];
  nativeInstallations?: Array<{ profileId: string; stage: string; message: string }>;
  nativeBrowsers?: NativeBrowserState[];
  tasks: BrowserTask[]; materials: PersonalMaterial[]; attachments: TaskAttachment[];
  schedules: TaskSchedule[]; templates: TaskTemplate[]; settings: TaskSettings;
}
/** Cumulative counters per task, retained independently of task history. No prompts or credentials. */
export interface TaskTokenRecord {
  costRecords?: TaskCostRecord[];
  sdkCostUsd?: number;
  models?: ModelTokenUsage[];
  modelNames?: string[];
  taskId: string; createdAt: string; updatedAt: string;
  inputTokens: number; outputTokens: number;
  jevInputTokens: number; helperInputTokens: number; helperOutputTokens: number;
}
export interface ModelTokenUsage { model: string; inputTokens: number; outputTokens: number; }
export interface TaskCostRecord {
  id: string; source: "model" | "helper"; model: string; at: string;
  inputTokens: number; outputTokens: number;
  estimate?: { currency: "CNY" | "USD"; min: number; max: number; basis: string; priceDate: string };
}
export interface TaskApi {
  openLink(url: string): Promise<void>;
  listModels(): Promise<string[]>;
  pairNativeBrowser(profileId: string): Promise<{ code: string; expiresAt: string }>;
  authorizeNativeBrowser(profileId: string): Promise<{ expiresAt: string }>;
  disconnectNativeBrowser(profileId: string): Promise<void>;
  openNativeExtensionFolder(): Promise<void>;
  focusTaskBrowser(id: string): Promise<void>;
  watchPreview(id: string | null): Promise<void>;
  ackPreview(id: string, frameId: number): Promise<void>;
  onPreview(listener: (update: TaskPreviewUpdate) => void): () => void;
  snapshot(): Promise<TaskSnapshot>;
  create(input: CreateTaskInput): Promise<BrowserTask>;
  retryItems(id: string, itemIds: string[]): Promise<BrowserTask>;
  control(id: string, action: "pause" | "resume" | "takeover" | "cancel" | "rerun" | "steer", message?: string): Promise<void>;
  reply(id: string, decisionId: string, answer: string, approved: boolean): Promise<void>;
  saveMaterial(input: Partial<PersonalMaterial>): Promise<PersonalMaterial>;
  deleteMaterial(id: string): Promise<void>;
  importAttachments(): Promise<TaskAttachment[]>;
  deleteAttachment(id: string): Promise<void>;
  saveSettings(input: Partial<TaskSettings> & { apiKey?: string }): Promise<void>;
  testConnection(): Promise<string>;
  saveJevSettings(input: { enabled: boolean; apiKey?: string; provider?: JevProvider; mode?: "driver" | "advisory" }): Promise<void>;
  testJevConnection(): Promise<string>;
  openJevConsole(page: "keys" | "billing"): Promise<void>;
  saveSchedule(input: Partial<TaskSchedule>): Promise<TaskSchedule>;
  deleteSchedule(id: string): Promise<void>;
  saveTemplate(input: Partial<TaskTemplate>): Promise<TaskTemplate>;
  deleteTemplate(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  updateTaskMetadata(id: string, input: TaskMetadataInput): Promise<void>;
  exportData(kind: "task" | "materials" | "diagnostics", id?: string): Promise<string | null>;
  openArtifact(id: string, taskId?: string): Promise<void>;
  onChanged(listener: (snapshot: TaskSnapshot) => void): () => void;
}
export const TASK_CHANNEL = "tasks:request";
export const TASK_CHANGED = "tasks:changed";
export const TASK_PREVIEW = "tasks:preview";
export interface TaskModelRun { id: string; endpoint: string; at: string; }
export interface TaskPreviewUpdate {
  taskId: string; state: "connecting" | "live" | "unavailable" | "ended";
  message: string; url?: string; frame?: string; frameId?: number;
}
export const TERMINAL_TASKS = new Set<TaskStatus>(["completed", "partial", "failed", "cancelled"]);
export interface NativeBrowserState {
  taskTabs?: boolean;
  tabId?: number;
  pausedByBrowser?: boolean;
  profileId: string; connected: boolean; ownerSessionId?: string; ownership: "agent" | "user";
  tabTitle?: string; url?: string;
}
export function hasTaskBrowser(task: BrowserTask): boolean { return Boolean(task.port || task.browserConnection === "extension"); }
