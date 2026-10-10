import type { TaskSkillDefinition, TaskSkillRun, TaskSkillSelection } from "./task-skills";
export type TaskStatus = "queued" | "running" | "waiting_user" | "paused" | "completed" | "partial" | "failed" | "cancelled";
export type ItemStatus = "pending" | "running" | "waiting_user" | "completed" | "skipped" | "failed" | "uncertain";
export type Effect = "read" | "edit" | "submit" | "send" | "purchase" | "delete";
export interface ExecutionGrant { origin: string; effects: Array<"submit" | "send" | "delete">; maxActions: number; used: number; }
export interface TaskAttachment { id: string; name: string; path: string; size: number; }
export interface PersonalMaterial { id: string; name: string; scope: string; content: string; version: number; updatedAt: string; }
export interface TaskItem { id: string; label: string; status: ItemStatus; result?: string; evidence?: string; }
export interface TaskEvent { id: string; at: string; kind: "user" | "assistant" | "action" | "system" | "error"; text: string; streamId?: string; }
export type TaskPermissionMode = "manual" | "plan" | "acceptEdits";
export interface NativeAccessPolicy { allowedOrigins?: string[]; blockedOrigins?: string[]; confirmActions?: boolean; }
export interface NativeTaskTarget { tabId?: number; newTab?: boolean; }
export interface TaskPermissionRule { id: string; kind: "browser" | "terminal"; scope: string; label: string; createdAt: string; }
export interface TaskStream { id: string; text: string; updatedAt: string; }
export interface TaskStreamUpdate { taskId: string; stream: TaskStream; }
export interface TaskMessageOptions { requestId?: string; attachmentIds?: string[]; }
export interface TaskReplyOptions extends TaskMessageOptions { scope?: "once" | "session"; }
export interface TaskQueuedMessage { id: string; message: string; attachmentIds: string[]; createdAt: string; }
export interface TaskArtifactPreview { name: string; mime: string; text?: string; dataUrl?: string; truncated?: boolean; }
export interface TaskContext { summary: string; throughEventId: string; compactedAt: string; }
export interface TaskAgentActivity { id: string; name?: string; role?: string; description: string; status: string; summary?: string; updatedAt: string; }
export interface ProfileMemoryFile { name: string; content: string; revision: string; updatedAt: string; }
export interface ProfileMemorySnapshot { profileId: string; enabled: boolean; busy: boolean; files: ProfileMemoryFile[]; }
export interface JevAssessment {
  status: "ready" | "uncertain" | "unavailable"; model: string; version: string; elapsedMs: number; inputTokens: number; note: string;
  answers?: { page: { type: "choice"; choice: string; probabilities?: Record<string, number> };
    next: { type: "choice"; choice: string; probabilities?: Record<string, number> };
    humanRequired: { type: "boolean"; probability: number }; consequence: { type: "score"; score: number; probabilities?: Record<string, number> } };
  confidence?: Record<string, number>;
}
export interface BrowserObservation {
  page?: { frameId?: string; nextCursor?: string; totalControls: number; totalText: number; offset: number; textOffset: number; query?: string };
  frames?: Array<{ id: string; parentId?: string; url: string; name?: string; oopif: boolean }>;
  version: string; fingerprint: string; at: string; url: string; title: string;
  snapshot: string; screenshotPath?: string; screenshotDataUrl?: string; account: string;
  jev?: JevAssessment;
  viewport?: { width: number; height: number; x: number; y: number; scrollWidth: number; scrollHeight: number };
  fast?: { document: string; guard: string; candidates: BrowserCandidate[] };
}
export interface BrowserCandidate {
  ref: string; role: string; label: string; kind: "click" | "fill" | "select";
  value?: string; checked?: boolean; multiple?: boolean; selectedValues?: string[];
  inputType?: string;
  options?: Array<{ value: string; label: string; selected?: boolean }>;
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
  terminal?: { command: string; summary: string; runtime: "shell" | "node"; cwd: string; background: boolean; timeout_ms: number; yield_ms: number };
  exportResult?: { name: string; format: "csv" | "json" | "markdown" | "html"; columns: string[]; rows: Array<Array<string | number | boolean | null>>; text: string };
  permissionScope?: { kind: "browser" | "terminal"; scope: string; label: string };
}
export interface TaskReceipt {
  id: string; at: string; action: BrowserAction; status: "started" | "executed" | "uncertain";
  result?: string; observationVersion?: string;
  // Covered by a verified completion, so later conversation turns do not
  // reinterpret a successfully executed historical action as interrupted.
  verifiedAt?: string;
  reconciliation?: { outcome: "completed" | "not_completed" | "uncertain"; evidence: string; at: string };
}
export interface TaskResult { kind?: "answer" | "verified"; summary: string; evidence: string[]; remaining: string[]; }
export interface JevDecisionRecord {
  at: string; mode: "driver" | "advisory"; status: "running" | "completed" | "interrupted";
  operation?: string; target?: string; probability?: number; confidence?: number;
  elapsedMs: number; inputTokens: number; note?: string; outcome?: string;
}
export interface BrowserTask {
  skill?: TaskSkillRun;
  historyRevision?: number;
  messageQueue?: TaskQueuedMessage[];
  messageReceipts?: Array<{ id: string; fingerprint: string; at: string }>;
  nativeUiRequests?: Array<{ id: string; method: string; fingerprint: string; error?: string }>;
  nativeTarget?: NativeTaskTarget; nativeAccess?: NativeAccessPolicy;
  mode?: TaskPermissionMode; model?: string;
  permissionRules?: TaskPermissionRule[];
  context?: TaskContext;
  agentActivities?: TaskAgentActivity[];
  sdkTokenBaseline?: { inputTokens: number; outputTokens: number };
  costAccounting?: { version: string; sessionId: string; sdkUsd: number; originalUsd?: number; correctedAt?: string };
  cachedInputTokens?: number;
  costRecords?: TaskCostRecord[];
  modelTokenUsage?: ModelTokenUsage[];
  browserConnection?: "gateway" | "extension";
  // Set before browser I/O: even a failed request may have acquired a lease.
  browserLeaseAttempted?: boolean;
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
  resumeContext?: { reason: string; url?: string; userResponse?: string; returnedAt?: string; observed?: boolean; remaining?: string[] };
  usage: { inputTokens: number; outputTokens: number; costUsd: number; elapsedMs: number; actions: number; jev?: { calls: number; completedCalls?: number; inputTokens: number; elapsedMs: number }; helper?: { calls: number; inputTokens: number; outputTokens: number; elapsedMs: number }; jevActions?: number };
  limits: { minutes: number; actions: number; budgetUsd: number };
  needsReconciliation: boolean; scheduledBy?: string;
  grant?: ExecutionGrant;
  outputs?: TaskAttachment[];
}
export interface CreateTaskInput {
  skill?: TaskSkillSelection;
  nativeTarget?: NativeTaskTarget; nativeAccess?: NativeAccessPolicy;
  mode?: TaskPermissionMode; model?: string;
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
  memoryPolicies?: Record<string, { enabled: boolean }>;
  skills?: TaskSkillDefinition[];
  skillIssues?: string[];
  streams?: Record<string, TaskStream>;
  nativeAccessPolicies?: Record<string, NativeAccessPolicy>;
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
  getMemory(profileId: string): Promise<ProfileMemorySnapshot>;
  setMemoryEnabled(profileId: string, enabled: boolean): Promise<ProfileMemorySnapshot>;
  writeMemory(profileId: string, name: string, content: string, revision: string | null): Promise<ProfileMemorySnapshot>;
  deleteMemory(profileId: string, name: string, revision: string): Promise<ProfileMemorySnapshot>;
  openLink(url: string): Promise<void>;
  listModels(): Promise<string[]>;
  pairNativeBrowser(profileId: string): Promise<{ code: string; expiresAt: string }>;
  getNativeLiveView(profileId: string): Promise<import("./types").CdpLiveView>;
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
  control(id: string, action: "pause" | "resume" | "takeover" | "cancel" | "rerun" | "steer" | "queue", message?: string, options?: TaskMessageOptions): Promise<void>;
  reply(id: string, decisionId: string, answer: string, approved: boolean, options?: TaskReplyOptions): Promise<void>;
  queue(id: string, removeId?: string): Promise<TaskQueuedMessage[]>;
  permissions(id: string, revokeId?: string): Promise<TaskPermissionRule[]>;
  setLimits(id: string, limits: Partial<BrowserTask["limits"]>): Promise<void>;
  setModel(id: string, model: string): Promise<void>;
  previewArtifact(id: string, taskId?: string): Promise<TaskArtifactPreview>;
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
  exportData(kind: "task" | "task-markdown" | "materials" | "diagnostics", id?: string): Promise<string | null>;
  openArtifact(id: string, taskId?: string): Promise<void>;
  onChanged(listener: (snapshot: TaskSnapshot) => void): () => void;
  onStream?(listener: (update: TaskStreamUpdate) => void): () => void;
}
export const TASK_CHANNEL = "tasks:request";
export const TASK_CHANGED = "tasks:changed";
export const TASK_STREAM = "tasks:stream";
export const TASK_PREVIEW = "tasks:preview";
export interface TaskModelRun { id: string; endpoint: string; at: string; }
export interface TaskPreviewUpdate {
  taskId: string; state: "connecting" | "live" | "unavailable" | "ended";
  message: string; url?: string; frame?: string; frameId?: number;
}
export const TERMINAL_TASKS = new Set<TaskStatus>(["completed", "partial", "failed", "cancelled"]);
export interface NativeBrowserState {
  taskTabs?: boolean;
  /** Extension worker identity plus its latest stop generation. */
  controlGeneration?: string;
  tabId?: number;
  pausedByBrowser?: boolean;
  profileId: string; connected: boolean; ownerSessionId?: string; ownership: "agent" | "user";
  tabTitle?: string; url?: string;
}
export function hasTaskBrowser(task: BrowserTask): boolean { return Boolean(task.port || task.browserConnection === "extension"); }
