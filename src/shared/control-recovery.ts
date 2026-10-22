/** Public, transport-independent recovery contract. Unknown execution is never
 * made retryable just because the transport can reconnect. */
export interface ControlRecovery {
  cause: string;
  stage: "validation" | "ownership" | "observation" | "execution" | "connection" | "installation";
  actionOutcome: "not-executed" | "completed" | "unknown" | "not-applicable";
  requiresUser: boolean;
  nextStep: "fix-input" | "reobserve" | "inspect-result" | "check-connection" | "repair-installation" | "wait-for-owner" | "return-control" | "check-readiness";
  instruction: string;
  automaticReplay: false;
}

export function controlRecovery(code: string, context: Partial<Pick<ControlRecovery, "stage" | "actionOutcome">> = {}): ControlRecovery {
  let result: Omit<ControlRecovery, "cause" | "automaticReplay">;
  if (/INVALID|VALIDATION|REQUEST_CONFLICT/.test(code)) result = {
    stage: "validation", actionOutcome: "not-executed", requiresUser: false, nextStep: "fix-input",
    instruction: "修正参数后重新调用；不要从失败结果中读取会话或元素引用。"
  };
  else if (/OBSERVATION_STALE|STALE_REFERENCE|STALE_REF/.test(code)) result = {
    stage: "observation", actionOutcome: "not-executed", requiresUser: false, nextStep: "reobserve",
    instruction: "读取新的观察并重新确认目标，使用新 version/ref。原动作未执行，不要重复提交旧引用。"
  };
  else if (/USER_IN_CONTROL|USER_TAKEOVER|CONTROL_PAUSED/.test(code)) result = {
    stage: "ownership", actionOutcome: "unknown", requiresUser: true, nextStep: "return-control",
    instruction: "等待用户明确交还控制，再恢复并重新观察；先核查之前操作的结果。"
  };
  else if (/SESSION_CONFLICT|SESSION_BUSY|TARGET_BUSY|SESSION_IN_USE|LEASE_CONFLICT|SESSION_ALREADY_BOUND/.test(code)) result = {
    stage: "ownership", actionOutcome: "not-executed", requiresUser: false, nextStep: "wait-for-owner",
    instruction: "读取 status 中的占用任务和暂停原因，等待原任务释放或明确交接；不要替换会话绕过占用。"
  };
  else if (/EXTENSION_FRAME_CONFLICT|DEBUGGER_BUSY|DEBUGGER_UNAVAILABLE/.test(code)) result = {
    stage: "connection", actionOutcome: "unknown", requiresUser: false, nextStep: "check-connection",
    instruction: "运行目标 doctor 并处理扩展框架或调试器冲突。技术故障不代表用户接管；连接修复后重新观察并核查结果。"
  };
  else if (/UPDATE_REQUIRED|RUNTIME_MISSING|INSTALL/.test(code)) result = {
    stage: "installation", actionOutcome: "not-executed", requiresUser: false, nextStep: "repair-installation",
    instruction: "检查实际运行的 CLI、服务、扩展或手机 App 版本，按 doctor 的缺项修复，再验证目标连接。"
  };
  else if (/RENDER_UNAVAILABLE/.test(code)) result = {
    stage: "observation", actionOutcome: "unknown", requiresUser: false, nextStep: "reobserve",
    instruction: "检查 observation 中 DOM、截图和坐标各自的可用性；可继续读取文字，不使用旧截图，也不重放先前输入。"
  };
  else if (/DISCONNECTED|CONNECT_FAILED|APP_NOT_RUNNING|SERVICE_UNAVAILABLE|DEBUGGER_DETACHED/.test(code)) result = {
    stage: "connection", actionOutcome: "unknown", requiresUser: false, nextStep: "check-connection",
    instruction: "先检查目标连接和会话状态；恢复连接不会自动恢复控制。重新观察并核查已发送操作的结果。"
  };
  else if (/NOT_READY|PERMISSION/.test(code)) result = {
    stage: "validation", actionOutcome: "not-executed", requiresUser: false, nextStep: "check-readiness",
    instruction: "读取目标 readiness/doctor 的缺项和下一步，不从失败的 start 返回值继续构造 action。"
  };
  else result = {
    stage: "execution", actionOutcome: "unknown", requiresUser: false, nextStep: "inspect-result",
    instruction: "执行结果尚不确定；读取当前状态和页面结果后再决定下一步，不能直接重放输入或提交。"
  };
  return { cause: code, ...result, ...context, automaticReplay: false };
}

/** Accept only our small public schema across the local transport. */
export function parseControlRecovery(value: unknown): ControlRecovery | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as ControlRecovery;
  if (typeof v.cause !== "string" || !/^[A-Z][A-Z0-9_]{1,100}$/.test(v.cause) ||
      !["validation", "ownership", "observation", "execution", "connection", "installation"].includes(v.stage) ||
      !["not-executed", "completed", "unknown", "not-applicable"].includes(v.actionOutcome) ||
      typeof v.requiresUser !== "boolean" || v.automaticReplay !== false ||
      !["fix-input", "reobserve", "inspect-result", "check-connection", "repair-installation", "wait-for-owner", "return-control", "check-readiness"].includes(v.nextStep) ||
      typeof v.instruction !== "string") return;
  return { cause: v.cause, stage: v.stage, actionOutcome: v.actionOutcome, requiresUser: v.requiresUser,
    nextStep: v.nextStep, instruction: v.instruction.slice(0, 1000), automaticReplay: false };
}
