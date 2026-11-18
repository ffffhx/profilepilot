import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEVICE_ONLY_PROFILE_ID, type CreateTaskInput, type TaskCostRecord, type TaskSettings, type TaskTemplate } from "../../shared/tasks";
import type { ReviewSettings, ReviewKind, ReviewReport, ReviewReportInfo, ReviewSnapshot, ReviewFeedbackRecord, ReviewFinding, ReviewFeedback } from "../../shared/review";
import { collectReviewSources, redactReviewText, type ReviewSourceOptions } from "./sources";
import { analyzeReview, type AnalysisInput } from "./analyze";
import { localDate, reviewWindow } from "./schedule";

const settingsSchema = z.object({ enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "时区无效"),
  weeklyDay: z.number().int().min(0).max(6), sources: z.object({ profilepilot: z.boolean(), codex: z.boolean(), claude: z.boolean(), trace: z.boolean() }).strict(), enabledAt: z.string().datetime().optional() }).strict();
export const reviewSettingsPatchSchema = settingsSchema.omit({ enabledAt: true }).partial();
const infoSchema = z.object({ id: z.string().uuid(), key: z.string(), kind: z.enum(["daily", "weekly"]), from: z.string().datetime(), until: z.string().datetime(),
  createdAt: z.string().datetime(), status: z.enum(["complete", "failed", "running"]), summary: z.string() });
const feedbackSchema = z.object({ key: z.string().min(1).max(120), value: z.enum(["accepted", "dismissed", "existing", "pending"]), note: z.string().max(1000), at: z.string().datetime(), title: z.string() });
type Known = AnalysisInput["known"][number] & { at: string };
interface ReviewState { version: 1; settings: ReviewSettings; reports: ReviewReportInfo[]; feedback: ReviewFeedbackRecord[]; known: Known[]; attempts: Record<string, { count: number; after: number }>; }
export interface ReviewUsageNotification {
  reportId: string;
  kind: ReviewKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  charge?: TaskCostRecord;
  at: string;
}
export interface ReviewDependencies extends ReviewSourceOptions {
  settings(): TaskSettings;
  apiKey(): string;
  analyze?: typeof analyzeReview;
  clock?: () => number;
  notify?: (title: string, message: string) => void;
  onUsage?: (entry: ReviewUsageNotification) => void;
  saveTemplate?: (input: { name: string; task: CreateTaskInput }) => TaskTemplate;
}

export function workflowTemplatePrompt(finding: ReviewFinding): string {
  const workflow = finding.workflow;
  if (!workflow) throw new Error("该建议没有工作流草稿。");
  return [
    finding.title,
    `适用场景：${workflow.when}`,
    workflow.inputs.length ? `所需输入：\n${workflow.inputs.map(row => `- ${row}`).join("\n")}` : "",
    `执行步骤：\n${workflow.steps.map((row, index) => `${index + 1}. ${row}`).join("\n")}`,
    workflow.exceptions.length ? `例外处理：\n${workflow.exceptions.map(row => `- ${row}`).join("\n")}` : "",
    `完成标准：${workflow.done}`
  ].filter(Boolean).join("\n\n");
}

export class ReviewService {
  private state: ReviewState;
  private error?: string;
  private loadError = false;
  private active?: Promise<ReviewReport>;
  private abort?: AbortController;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly clock: () => number;
  readonly directory: string;
  constructor(root: string, private readonly dependencies: ReviewDependencies) {
    this.clock = dependencies.clock || Date.now;
    this.directory = path.join(root, "usage-reviews");
    // External CLI session logs (Codex / Claude Code) are strictly opt-in by default.
    this.state = { version: 1, settings: { enabled: false, time: "21:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", weeklyDay: 0,
      sources: { trace: true, profilepilot: true, codex: false, claude: false } }, reports: [], feedback: [], known: [], attempts: {} };
    const file = path.join(this.directory, "index.json");
    if (existsSync(file)) try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (value.version !== 1) throw new Error("Unknown version");
      this.state.settings = settingsSchema.parse(value.settings);
      this.state.reports = z.array(infoSchema).max(1000).parse(value.reports);
      this.state.feedback = z.array(feedbackSchema).max(10000).parse(value.feedback);
      this.state.known = z.array(z.object({ key: z.string(), kind: z.enum(["tool", "workflow"]), title: z.string(), suggestion: z.string(), verification: z.string(), at: z.string().datetime() })).max(300).parse(value.known);
      this.state.attempts = z.record(z.string(), z.object({ count: z.number().int().min(0), after: z.number().finite() })).parse(value.attempts);
      for (const report of this.state.reports) if (report.status === "running") {
        report.status = "failed"; report.summary = "上次复盘随应用退出而中断，将在下次到期检查时重试。";
        if (this.state.attempts[report.key]) this.state.attempts[report.key].after = 0;
      }
    } catch {
      this.loadError = true; this.state.settings.enabled = false;
      this.error = "复盘索引无法读取，原文件已保留；其他任务不受影响。请修复 usage-reviews/index.json 后重启。";
    }
  }
  snapshot(): ReviewSnapshot {
    const settings = this.dependencies.settings();
    return structuredClone({ settings: this.state.settings, reports: this.state.reports, feedback: this.state.feedback,
      running: Boolean(this.active), model: settings.model, configured: settings.hasApiKey, directory: this.directory, error: this.error });
  }
  configure(patch: unknown): ReviewSnapshot {
    if (this.loadError) throw new Error(this.error);
    const input = reviewSettingsPatchSchema.parse(patch);
    const settings = settingsSchema.parse({ ...this.state.settings, ...input });
    if (!Object.values(settings.sources).some(Boolean)) throw new Error("至少选择一个复盘来源。");
    if (settings.enabled && !this.state.settings.enabled) settings.enabledAt = new Date(this.clock()).toISOString();
    this.commit({ ...this.state, settings });
    if (!settings.enabled) this.abort?.abort(new Error("已关闭自动复盘。"));
    return this.snapshot();
  }
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 60000); this.timer.unref();
    void this.tick();
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.abort?.abort(new Error("应用退出，复盘已中断。"));
    await this.active?.catch(() => {});
  }
  async tick(): Promise<void> {
    if (this.closed || this.active || !this.state.settings.enabled || this.loadError) return;
    try {
      for (const kind of ["daily", "weekly"] as const) {
        if (this.closed || !this.state.settings.enabled) break;
        const now = this.clock(), window = reviewWindow(this.state.settings, kind, now);
        const enabled = Date.parse(this.state.settings.enabledAt || new Date(now).toISOString());
        if (localDate(window.until, this.state.settings.timezone) < localDate(enabled, this.state.settings.timezone)) continue;
        if (this.state.reports.some(report => report.key === window.key && report.status === "complete")) continue;
        const attempt = this.state.attempts[window.key];
        if (attempt && (attempt.after > now || attempt.count >= 3)) continue;
        // After downtime, cover the missed days once, bounded to one week.
        if (kind === "daily") {
          const previous = this.state.reports.find(report => report.kind === kind && report.status === "complete" && !report.key.includes("manual"));
          if (previous) window.from = Math.min(window.from, Math.max(Date.parse(previous.until), window.until - 7 * 86400000));
        }
        await this.runWindow(kind, window);
      }
    } catch (error) { this.error = redactReviewText(error instanceof Error ? error.message : "复盘未完成，请重试。"); }
  }
  run(kind: ReviewKind): Promise<ReviewReport> {
    z.enum(["daily", "weekly"]).parse(kind);
    const until = this.clock();
    return this.runWindow(kind, { key: `${kind}:manual:${until}`, from: until - (kind === "daily" ? 1 : 7) * 86400000, until });
  }
  report(id: string): ReviewReport {
    z.string().uuid().parse(id);
    const info = this.state.reports.find(report => report.id === id);
    if (!info) throw new Error("复盘报告不存在。");
    if (info.status !== "complete") return { ...info, evidence: [], coverage: [], findings: [], suppressed: 0 };
    return JSON.parse(readFileSync(path.join(this.directory, `${id}.json`), "utf8")) as ReviewReport;
  }
  feedback(reportId: string, findingId: string, value: ReviewFeedback, note = ""): ReviewSnapshot {
    const report = this.report(reportId), finding = report.findings.find(item => item.id === findingId);
    if (!finding) throw new Error("该建议不存在。");
    const feedback = feedbackSchema.parse({ key: finding.key, value, note: redactReviewText(note), at: new Date(this.clock()).toISOString(), title: finding.title });
    this.commit({ ...this.state, feedback: [feedback, ...this.state.feedback.filter(item => item.key !== finding.key)].slice(0, 10000) });
    return this.snapshot();
  }
  exportWorkflow(reportId: string, findingId: string): { path: string; content: string } {
    const report = this.report(reportId), finding = report.findings.find(item => item.id === findingId);
    if (!finding?.workflow) throw new Error("该建议没有工作流草稿。");
    const workflow = finding.workflow;
    const content = [`# ${finding.title}`, "", "工作流候选 · 尚未安装或自动执行", "", `适用场景：${workflow.when}`, "", "## 输入", ...workflow.inputs.map(row => `- ${row}`), "", "## 步骤", ...workflow.steps.map((row, i) => `${i + 1}. ${row}`), "", "## 例外", ...workflow.exceptions.map(row => `- ${row}`), "", "## 完成标准", workflow.done, "", "## 验证方法", finding.verification, "", "## 来源", ...report.evidence.filter(row => finding.evidenceIds.includes(row.id)).map(row => `- ${row.at} · ${row.label} · ${row.location}`), ""].join("\n");
    const file = path.join(this.directory, "drafts", `${report.id}-${finding.id}.md`);
    this.writeAtomic(file, content);
    return { path: file, content };
  }
  saveAsTemplate(reportId: string, findingId: string): TaskTemplate {
    const report = this.report(reportId), finding = report.findings.find(item => item.id === findingId);
    if (!finding?.workflow) throw new Error("该建议没有工作流草稿。");
    const prompt = workflowTemplatePrompt(finding).slice(0, 30000);
    const name = finding.title.trim().slice(0, 100) || "复盘工作流模板";
    const task: CreateTaskInput = { prompt, profileId: DEVICE_ONLY_PROFILE_ID };
    if (this.dependencies.saveTemplate) return this.dependencies.saveTemplate({ name, task });
    return { id: randomUUID(), name, task, updatedAt: new Date(this.clock()).toISOString() };
  }
  private runWindow(kind: ReviewKind, window: { key: string; from: number; until: number }): Promise<ReviewReport> {
    if (this.closed) return Promise.reject(new Error("应用正在退出。"));
    if (this.loadError) return Promise.reject(new Error(this.error));
    if (this.active) return Promise.reject(new Error("已有复盘正在进行，请等待完成。"));
    this.abort = new AbortController();
    this.active = this.perform(kind, window, this.abort.signal).finally(() => { this.active = undefined; this.abort = undefined; });
    return this.active;
  }
  private async perform(kind: ReviewKind, window: { key: string; from: number; until: number }, signal: AbortSignal): Promise<ReviewReport> {
    const previous = this.state.reports.find(report => report.key === window.key);
    const info: ReviewReportInfo = { id: previous?.id || randomUUID(), key: window.key, kind, from: new Date(window.from).toISOString(), until: new Date(window.until).toISOString(), createdAt: new Date(this.clock()).toISOString(), status: "running", summary: "正在整理记录…" };
    this.error = undefined;
    this.commit({ ...this.state, reports: [info, ...this.state.reports.filter(report => report.id !== info.id)].slice(0, 90),
      attempts: Object.fromEntries([...Object.entries(this.state.attempts).slice(-89), [window.key, { count: (this.state.attempts[window.key]?.count || 0) + 1, after: this.clock() + 3600000 }]]) });
    try {
      const collected = await collectReviewSources(this.state.settings, window.from, window.until, this.dependencies);
      signal.throwIfAborted();
      const known = this.state.known.slice(0, 60).map(item => ({ ...item, feedback: this.state.feedback.find(feedback => feedback.key === item.key) }));
      const input: AnalysisInput = { kind, from: info.from, until: info.until, ...collected, known,
        recentSummaries: this.state.reports.filter(report => report.status === "complete" && Date.parse(report.until) <= window.until && Date.parse(report.until) > window.until - 14 * 86400000).slice(0, 10).map(report => `${report.kind} ${report.until}: ${report.summary}`) };
      const result = collected.evidence.length ? await (this.dependencies.analyze || analyzeReview)(input, this.dependencies.settings(), this.dependencies.apiKey(), signal)
        : { summary: "本次范围内没有可分析的记录，因此没有新增建议。请查看来源覆盖情况。", findings: [] as ReviewFinding[] };
      signal.throwIfAborted();
      const normalized = (title: string) => title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
      const findings = result.findings.filter(finding => {
        const old = this.state.known.find(item => item.key === finding.key || normalized(item.title) === normalized(finding.title));
        const feedback = this.state.feedback.find(item => item.key === (old?.key || finding.key));
        if (feedback && feedback.value !== "pending") return false;
        return !old || kind === "weekly" && finding.kind === "workflow" || Date.parse(old.at) < this.clock() - 14 * 86400000;
      });
      const resolvedModel = collected.evidence.length ? (result.model || this.dependencies.settings().model) : undefined;
      const report: ReviewReport = { ...info, ...collected, status: "complete", summary: result.summary, findings,
        suppressed: result.findings.length - findings.length, usage: result.usage, model: resolvedModel };
      this.writeAtomic(path.join(this.directory, `${info.id}.json`), JSON.stringify(report, null, 2));
      const additions = findings.map(({ key, kind, title, suggestion, verification }) => ({ key, kind, title, suggestion, verification, at: info.createdAt }));
      this.commit({ ...this.state, reports: [{ ...info, status: "complete", summary: report.summary }, ...this.state.reports.filter(row => row.id !== info.id)],
        known: [...additions, ...this.state.known.filter(row => !additions.some(item => item.key === row.key))].slice(0, 300) });
      if (result.usage && resolvedModel) {
        try {
          this.dependencies.onUsage?.({
            reportId: info.id,
            kind,
            model: resolvedModel,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            charge: result.charge,
            at: info.createdAt
          });
        } catch { /* Usage ledger failures must not invalidate a saved review report. */ }
      }
      try { this.dependencies.notify?.(kind === "daily" ? "每日复盘已完成" : "每周整理已完成", findings.length ? `${findings.length} 条建议与候选，可在设置 → 使用复盘查看。` : "没有新增建议，可在设置 → 使用复盘查看记录范围。"); }
      catch { /* Notification availability must not invalidate a saved report or trigger another paid analysis. */ }
      return report;
    } catch (error) {
      const summary = redactReviewText(error instanceof Error ? error.message : "复盘未完成，请重试。");
      this.error = summary;
      this.commit({ ...this.state, reports: [{ ...info, status: "failed", summary }, ...this.state.reports.filter(row => row.id !== info.id)] });
      throw new Error(summary);
    }
  }
  private commit(next: ReviewState): void {
    if (this.loadError) throw new Error(this.error);
    this.writeAtomic(path.join(this.directory, "index.json"), JSON.stringify(next, null, 2));
    this.state = next;
  }
  private writeAtomic(file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, content, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
