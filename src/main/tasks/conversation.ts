import { createHash } from "node:crypto";
import type { BrowserAction, BrowserObservation, BrowserTask, TaskDecision, TaskEvent, TaskReceipt } from "../../shared/tasks";

const externalEffect = (receipt: TaskReceipt): boolean => ["submit", "send", "purchase", "delete"].includes(receipt.action.effect);
const reconciled = (receipt: TaskReceipt): boolean => ["completed", "not_completed"].includes(receipt.reconciliation?.outcome || "");

export function unresolvedExternalReceipts(task: BrowserTask): TaskReceipt[] {
  return task.receipts.filter(receipt => externalEffect(receipt) && !reconciled(receipt) &&
    (receipt.status === "started" || receipt.status === "uncertain" || receipt.reconciliation?.outcome === "uncertain"));
}

export function preserveVerifiedReceipts(task: BrowserTask, at = task.updatedAt): void {
  // Also migrates old completed records before resume/recovery. Never infer a
  // per-action success for a started/uncertain receipt from a task-level result.
  if (task.status !== "completed" || task.result?.kind !== "verified" || !task.result.evidence.length ||
    task.result.remaining.length || task.items.some(item => !["completed", "skipped"].includes(item.status)) ||
    task.needsReconciliation || unresolvedExternalReceipts(task).length) return;
  for (const receipt of task.receipts) if (receipt.status === "executed") receipt.verifiedAt ??= at;
}

export function interruptReceipts(task: BrowserTask, includeExecuted = true): void {
  for (const receipt of task.receipts) {
    if (receipt.status === "started" || (includeExecuted && externalEffect(receipt) && receipt.status === "executed" &&
      !receipt.verifiedAt && !reconciled(receipt))) receipt.status = "uncertain";
  }
  // A persisted flag with no receipt may represent older recovery state. Only
  // explicit observation/reconciliation can clear it, never a conversation turn.
  if (unresolvedExternalReceipts(task).length) task.needsReconciliation = true;
}

export function answerRemaining(task: BrowserTask, remaining: string[]): string[] {
  const unresolved = unresolvedExternalReceipts(task);
  return [...new Set([
    ...remaining, ...(task.resumeContext?.remaining || []),
    ...task.items.filter(item => !["completed", "skipped"].includes(item.status)).map(item => item.label),
    ...unresolved.map(receipt => `外部操作仍待核查：${receipt.action.summary}`),
    ...(task.needsReconciliation && !unresolved.length ? ["此前外部工作仍待核查；本轮仅完成回答，未验证其结果。"] : [])
  ])];
}

export function actionProgress(observation: BrowserObservation | undefined, action: BrowserAction): { signature: string; state: string } {
  const refs = new Map<string, string>();
  const canonicalRef = (ref: string): string => {
    ref = ref.replace(/^@/, "");
    if (!refs.has(ref)) refs.set(ref, `control-${refs.size}`);
    return refs.get(ref)!;
  };
  const candidates = observation?.fast?.candidates || [];
  for (const candidate of candidates) canonicalRef(candidate.ref);
  const snapshot = (observation?.snapshot || "").replace(/\[ref=(@?e\d+)\]/g, (_match, ref) => `[ref=${canonicalRef(ref)}]`)
    .replace(/(^|\n)(\s*)@(e\d+)(?=\s)/g, (_match, start, space, ref) => `${start}${space}@${canonicalRef(ref)}`);
  const ref = action.ref?.replace(/^@/, "");
  const candidate = candidates.find(entry => entry.ref === ref);
  let target: unknown = ref;
  const identities = candidates.map(({ ref: _ref, value: _value, checked: _checked, offscreen: _offscreen, ...identity }) => JSON.stringify(identity));
  if (candidate) {
    const index = candidates.indexOf(candidate), identity = identities[index];
    // Identical labels can belong to distinct cards/buttons. Preserve their
    // relative occurrence, but not an ephemeral eN assigned after a rerender.
    target = [identity, identities.slice(0, index).filter(value => value === identity).length];
  } else if (ref && refs.has(ref)) target = canonicalRef(ref);
  let values: unknown, focus: unknown;
  try {
    const guard = JSON.parse(observation?.fast?.guard || "");
    values = guard[4];
    focus = guard[5] ? { ...guard[5], focusedRef: guard[5].focusedRef ? canonicalRef(guard[5].focusedRef) : undefined } : undefined;
  } catch { /* A11y observations still have a reference-normalized snapshot. */ }
  const state = createHash("sha256").update(JSON.stringify([
    observation?.url, observation?.title, observation?.fast?.document,
    observation?.page ? [observation.page.frameId, observation.page.offset, observation.page.textOffset, observation.page.query] : undefined,
    snapshot, observation?.viewport,
    candidates.map(({ ref: _ref, ...entry }) => entry), values, focus
  ])).digest("hex");
  const signature = JSON.stringify({ kind: action.kind, target, value: action.value, attachmentId: action.attachmentId });
  return { signature, state };
}

export function conversationEvents(task: BrowserTask): TaskEvent[] {
  const index = task.context ? task.events.findIndex(event => event.id === task.context!.throughEventId) : -1;
  return task.events.slice(index + 1);
}

export function contextDescription(task: BrowserTask): { characters: number; approximateTokens: number; compacted: boolean; events: number } {
  const events = conversationEvents(task);
  const characters = (task.context?.summary.length || 0) + events.reduce((sum, event) => sum + event.text.length, 0);
  return { characters, approximateTokens: Math.ceil(characters / 3), compacted: Boolean(task.context), events: events.length };
}

export function formStructure(observation: BrowserObservation): string {
  if (observation.fast) {
    // Values and scroll visibility are expected to change while filling. Keep
    // identities, labels, roles, options and any disabled/semantic metadata.
    // Disabled controls disappear from FastBrowser candidates, which also
    // changes this signature and stops the rest of the batch.
    return JSON.stringify([observation.url, observation.fast.document, observation.page?.frameId,
      observation.page?.offset, observation.page?.query,
      observation.fast.candidates.map(({ value: _value, checked: _checked, offscreen: _offscreen, ...candidate }) => candidate)]);
  }
  return observation.snapshot.split("\n").filter(line => /ref=e\d+|^\s*@e\d+\s/.test(line)).map(line => {
    const marker = line.match(/\[ref=e\d+\]/);
    if (!marker || marker.index === undefined) return line.replace(/checked=(?:true|false)/g, "checked").replace(/\]:.*$/, "]");
    const end = marker.index + marker[0].length;
    return line.slice(0, end) + line.slice(end).replace(/\s+value=(?:"(?:\\.|[^"\\])*"|[^\s]+)/g, "").replace(/\s+checked=(?:true|false)/g, "").replace(/^:\s*.*/, "");
  }).join("\n");
}

export function browserPermissionScope(task: BrowserTask, action: BrowserAction): TaskDecision["permissionScope"] {
  if (!task.observation || action.effect === "read" || action.effect === "purchase") return undefined;
  let origin: string;
  try { origin = new URL(task.observation.url).origin; } catch { return undefined; }
  if (!/^https?:\/\//.test(origin)) return undefined;
  // The user approves this explicit origin/effect/action-kind tuple. No wildcard
  // hosts and no permissions carry over to forks or other tasks.
  return { kind: "browser", scope: JSON.stringify([origin, action.effect, action.kind]), label: `${origin} · ${action.effect} · ${action.kind}` };
}

export function terminalPermissionScope(input: NonNullable<TaskDecision["terminal"]>): NonNullable<TaskDecision["permissionScope"]> {
  const scope = createHash("sha256").update(JSON.stringify([input.runtime, input.cwd, input.command, input.background, input.timeout_ms])).digest("hex");
  return { kind: "terminal", scope, label: `${input.runtime} · ${input.cwd} · ${input.command.slice(0, 300)}` };
}

export function hasSessionPermission(task: BrowserTask, scope: TaskDecision["permissionScope"]): boolean {
  return Boolean(scope && task.permissionRules?.some(rule => rule.kind === scope.kind && rule.scope === scope.scope));
}

// Provider errors can echo request headers. Also withhold a possible credential
// prefix at the end of a live stream until the next delta resolves it.
export function redactProviderSecrets(text: string, secrets: string[], streaming = false): string {
  const values = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  for (const secret of values) text = text.split(secret).join("[REDACTED]");
  if (streaming) {
    let suffix = 0;
    for (const secret of values) {
      for (let length = Math.min(secret.length - 1, text.length); length > suffix; length--) {
        if (text.endsWith(secret.slice(0, length))) { suffix = length; break; }
      }
    }
    if (suffix) text = text.slice(0, -suffix);
  }
  return text;
}
