const modifiers = ["Control", "Alt", "Shift", "Command", "Super"];
const namedKeys = new Set(["Space", "Tab", "Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right", "Plus"]);
const punctuation = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);

/** Canonical Electron accelerator; resolves platform aliases before comparing bindings. */
export function normalizeQuickLaunchShortcut(value: unknown, platform: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.trim().split("+");
  const key = parts.pop()!;
  const normalizedModifiers = parts.map((part) => {
    if (part === "CommandOrControl" || part === "CmdOrCtrl") return platform === "darwin" ? "Command" : "Control";
    if (part === "Ctrl") return "Control";
    if (part === "Cmd") return "Command";
    if (part === "Option") return "Alt";
    if (part === "Meta") return platform === "darwin" ? "Command" : "Super";
    return part;
  });
  if (normalizedModifiers.some((part) => !modifiers.includes(part))) return null;
  if (platform !== "darwin" && normalizedModifiers.includes("Command")) return null;
  const normalizedKey = /^[a-z0-9]$/i.test(key) ? key.toUpperCase() : key;
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.test(normalizedKey);
  if (!/^[A-Z0-9]$/.test(normalizedKey) && !functionKey && !namedKeys.has(normalizedKey) && !punctuation.has(normalizedKey)) return null;
  // Single letters, digits and Shift alone would intercept ordinary typing globally.
  if (!functionKey && !normalizedModifiers.some((part) => part !== "Shift")) return null;
  return [...modifiers.filter((part) => normalizedModifiers.includes(part)), normalizedKey].join("+");
}

export function formatQuickLaunchShortcut(value: string | null | undefined, platform: string): string {
  if (!value) return "";
  const labels: Record<string, string> = platform === "darwin"
    ? { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘", Super: "⌘", CommandOrControl: "⌘" }
    : { Control: "Ctrl", CommandOrControl: "Ctrl", Super: platform === "win32" ? "Win" : "Super", Alt: "Alt", Shift: "Shift" };
  const keys: Record<string, string> = { Space: "Space", Plus: "+", Up: "↑", Down: "↓", Left: "←", Right: "→" };
  return value.split("+").map((part) => labels[part] || keys[part] || part).join(platform === "darwin" ? "" : "+");
}

export function shortcutFromKeyEvent(event: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing">, platform: string): string | null {
  if (event.isComposing || ["Control", "Alt", "Shift", "Meta", "AltGraph", "Dead", "Process", "Unidentified"].includes(event.key)) return null;
  const codes: Record<string, string> = { Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`", NumpadEnter: "Enter", NumpadAdd: "Plus", NumpadSubtract: "-", NumpadDecimal: ".", NumpadDivide: "/" };
  // Option on macOS changes event.key (e.g. Option+K → ˚); use the physical code.
  const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, "") : codes[event.code] || event.key;
  return normalizeQuickLaunchShortcut([
    ...(event.ctrlKey ? ["Control"] : []), ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []), ...(event.metaKey ? [platform === "darwin" ? "Command" : "Super"] : []), key
  ].join("+"), platform);
}

/** Read legacy numbered slots without losing existing bindings on upgrade. */
export function normalizeQuickLaunchShortcuts(input: unknown, legacySlots: unknown, platform: string, validIds?: Set<string>): Record<string, string> {
  const candidates: Record<string, unknown> = Object.create(null);
  if (legacySlots && typeof legacySlots === "object") {
    for (let slot = 1; slot <= 9; slot++) {
      const id = (legacySlots as Record<string, unknown>)[String(slot)];
      if (typeof id === "string" && id && !Object.hasOwn(candidates, id)) candidates[id] = `CommandOrControl+Alt+${slot}`;
    }
  }
  if (input && typeof input === "object" && !Array.isArray(input)) Object.assign(candidates, input);
  const result: Record<string, string> = Object.create(null);
  const used = new Set<string>();
  for (const [id, value] of Object.entries(candidates)) {
    const shortcut = normalizeQuickLaunchShortcut(value, platform);
    if (!id || (validIds && !validIds.has(id)) || !shortcut || used.has(shortcut)) continue;
    result[id] = shortcut;
    used.add(shortcut);
  }
  return result;
}
