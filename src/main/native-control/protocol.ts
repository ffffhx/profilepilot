export const NATIVE_CONTROL_METHODS = [
  "status", "tabs", "claim", "observe", "read", "action", "pointer", "screenshot",
  "open", "switch", "newTab", "cdp", "debug", "events", "history", "download", "control",
  "extension.reload", "downloads.start", "downloads.search", "downloads.wait", "downloads.cancel", "downloads.disarm"
] as const;

export type NativeControlMethod = typeof NATIVE_CONTROL_METHODS[number];

export function isNativeControlMethod(method: unknown): method is NativeControlMethod {
  return typeof method === "string" && (NATIVE_CONTROL_METHODS as readonly string[]).includes(method);
}
