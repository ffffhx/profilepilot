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
  else if (code === "NATIVE_FRAME_SESSION_STALE") result = {
    stage: "observation", actionOutcome: "unknown", requiresUser: false, nextStep: "reobserve",
    instruction: "子 frame 调试会话已失效。重新发现当前标签页的 frame 后重新观察并核查先前操作结果，选择新引用；不要重放输入，也不需要请求用户交还控制。"
  };
  else if (/OBSERVATION_STALE|STALE_REFERENCE|STALE_REF|PHONE_SESSION_STALE|PHONE_SESSION_ENDED/.test(code)) result = {
    stage: "observation", actionOutcome: "not-executed", requiresUser: false, nextStep: "reobserve",
    instruction: "读取新的观察并重新确认目标，使用新 version/ref。原动作未执行，不要重复提交旧引用。"
  };
  else if (/USER_IN_CONTROL|USER_TAKEOVER|CONTROL_PAUSED/.test(code)) result = {
    stage: "ownership", actionOutcome: "unknown", requiresUser: true, nextStep: "return-control",
    instruction: "等待用户明确交还控制，再恢复并重新观察；先核查之前操作的结果。"
  };
  else if (code === "PHONE_SCREEN_LOCKED") result = {
    stage: "validation", actionOutcome: "not-executed", requiresUser: false, nextStep: "check-readiness",
    instruction: "手机当前锁屏。按已有授权使用 phone wake/unlock 或等待解锁，再读取状态和新 generation；锁屏暂停不等于用户主动接管，不重放先前输入。"
  };
  else if (/PHONE_CONNECTION_REQUIRED|PHONE_PAIRING_REQUIRED|PHONE_DEVICE_NOT_FOUND/.test(code)) result = {
    stage: "connection", actionOutcome: "not-executed", requiresUser: false, nextStep: "check-connection",
    instruction: "运行 phone list/readiness 核查目标手机，按缺项执行 connect 或配对；连接后重新确认会话，不自动开始或恢复控制。"
  };
  else if (/SESSION_CONFLICT|SESSION_BUSY|TARGET_BUSY|SESSION_IN_USE|LEASE_CONFLICT|SESSION_ALREADY_BOUND/.test(code)) result = {
    stage: "ownership", actionOutcome: "not-executed", requiresUser: false, nextStep: "wait-for-owner",
    instruction: "读取 status 中的占用任务和暂停原因，等待原任务释放或明确交接；不要替换会话绕过占用。"
  };
  else if (code === "NATIVE_DEBUGGER_RECOVERED") result = {
    stage: "observation", actionOutcome: "unknown", requiresUser: false, nextStep: "reobserve",
    instruction: "页面调试连接已自动恢复，任务仍持有控制权。重新观察页面核查先前操作的结果；不要重新提交或重放输入，也无需请求用户交还控制。"
  };
  else if (code === 'NATIVE_EXTENSION_UI_ACTIVE') result = {
    stage: 'validation', actionOutcome: 'not-executed', requiresUser: false, nextStep: 'check-readiness',
    instruction: '当前会话处于扩展界面模式。使用 extension-ui observe/click；先 disconnect 再继续普通网页操作。'
  };
  else if (/EXTENSION_FRAME_CONFLICT|FRAME_GUARD_UNAVAILABLE|DEBUGGER_BUSY|DEBUGGER_UNAVAILABLE|DEBUGGER_TARGET_UNAVAILABLE|DEBUGGER_RECOVERY_LIMIT/.test(code)) result = {
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
  else if (code === "PHONE_USER_PERMISSION_REQUIRED") result = {
    stage: "validation", actionOutcome: "not-executed", requiresUser: true, nextStep: "check-readiness",
    instruction: "读取 phone readiness 的缺项，请用户在手机上允许顶部胶囊或通知权限；授权完成后重新检查，不从失败的 start 结果构造动作。"
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
