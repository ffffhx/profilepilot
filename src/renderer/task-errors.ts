/** Keep the actionable service message without Electron's transport wrapper. */
export function taskErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error ?? "");
  message = message.replace(/^Error:\s*/i, "").replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "").replace(/^Error:\s*/i, "").trim();
  return message || "暂时无法完成操作，请重试。";
}
