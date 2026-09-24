/** Only web links may leave the task window through the OS browser handler. */
export function taskLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 || !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
