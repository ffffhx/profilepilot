export type ReviewKind = "daily" | "weekly";
export const REVIEW_METHODS: readonly string[] = ["reviewSnapshot", "reviewConfigure", "reviewRun", "reviewReport", "reviewFeedback", "reviewExportWorkflow", "reviewSaveAsTemplate", "reviewSaveWorkflowTemplate"];
export type ReviewSource = "profilepilot" | "codex" | "claude" | "trace";
export type ReviewFeedback = "accepted" | "dismissed" | "existing" | "pending";
export interface ReviewSettings {
  enabled: boolean;
  time: string;
  timezone: string;
  weeklyDay: number;
  sources: Record<ReviewSource, boolean>;
  enabledAt?: string;
}
export interface ReviewEvidence {
  id: string;
  source: ReviewSource;
  session: string;
  label: string;
  at: string;
  text: string;
  location: string;
}
export interface ReviewFinding {
  id: string;
  key: string;
  kind: "tool" | "workflow";
  title: string;
  observation: string;
  suggestion: string;
  verification: string;
  evidenceIds: string[];
  confidence: "low" | "medium" | "high";
  workflow?: { when: string; inputs: string[]; steps: string[]; exceptions: string[]; done: string };
}
export interface ReviewCoverage {
  source: ReviewSource;
  records: number;
  sessions: number;
  partial: boolean;
  note: string;
}
export interface ReviewReportInfo {
  id: string;
  key: string;
  kind: ReviewKind;
  from: string;
  until: string;
  createdAt: string;
  status: "complete" | "failed" | "running";
  summary: string;
}
export interface ReviewReport extends ReviewReportInfo {
  evidence: ReviewEvidence[];
  coverage: ReviewCoverage[];
  findings: ReviewFinding[];
  suppressed: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface ReviewFeedbackRecord {
  key: string;
  value: ReviewFeedback;
  note: string;
  at: string;
  title: string;
}
export interface ReviewSnapshot {
  settings: ReviewSettings;
  reports: ReviewReportInfo[];
  feedback: ReviewFeedbackRecord[];
  running: boolean;
  model: string;
  configured: boolean;
  directory: string;
  error?: string;
}
