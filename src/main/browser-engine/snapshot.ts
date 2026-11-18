import { randomInt, randomUUID } from "node:crypto";
import type { Page, Frame, Locator } from "playwright-core";
import { EngineError, has, option } from "./arguments";

const INTERACTIVE_ROLE_RE = /^\s*-\s+(?:button|link|textbox|searchbox|combobox|listbox|checkbox|radio|switch|slider|spinbutton|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem|gridcell|summary)\b/;
const LANDMARK_ANCESTOR_ROLE_RE = /^\s*-\s+(?:dialog|alertdialog|navigation|main|form|table|row|listitem|region|heading)\b/;

export function isInteractiveSnapshotLine(line: string): boolean {
  return INTERACTIVE_ROLE_RE.test(line) || /\[cursor=pointer\]/i.test(line);
}

export function isLandmarkSnapshotLine(line: string): boolean {
  return LANDMARK_ANCESTOR_ROLE_RE.test(line);
}

/**
 * Structure-preserving interactive filter (`snapshot -i`):
 * Retains interactive elements (including `[cursor=pointer]`, `summary`, `gridcell`,
 * `menuitemcheckbox`, `menuitemradio`) AND ancestor landmark/container lines
 * (`dialog`, `alertdialog`, `navigation`, `main`, `form`, `table`, `row`, `listitem`,
 * `region`, `heading`) that contain interactive descendants.
 */
export function filterInteractiveSnapshot(snapshot: string): string {
  if (!snapshot.trim()) return "";
  const lines = snapshot.split("\n");
  const keep = new Array<boolean>(lines.length).fill(false);
  const indents = new Array<number>(lines.length).fill(0);
  const stack: Array<{ index: number; indent: number; landmark: boolean }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(\s*)-\s+/);
    if (!match) continue;
    const indent = match[1].length;
    indents[i] = indent;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const interactive = isInteractiveSnapshotLine(line);
    const landmark = isLandmarkSnapshotLine(line);
    if (interactive) {
      keep[i] = true;
      for (const ancestor of stack) {
        if (ancestor.landmark) {
          keep[ancestor.index] = true;
        }
      }
    }
    stack.push({ index: i, indent, landmark: landmark || interactive });
  }

  const keptStack: number[] = [];
  const output: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep[i]) continue;
    const origIndent = indents[i];
    while (keptStack.length > 0 && keptStack[keptStack.length - 1] >= origIndent) {
      keptStack.pop();
    }
    const content = lines[i].replace(/^\s*-\s+/, "- ");
    output.push(`${"  ".repeat(keptStack.length)}${content}`);
    keptStack.push(origIndent);
  }
  return output.join("\n");
}

function normalizeLineForDelta(line: string): string {
  return line.replace(/\s*\[ref=e\d+\]/g, "").trimEnd();
}

export interface SnapshotDeltaResult {
  changed: boolean;
  added: number;
  removed: number;
  delta: string;
}

export function computeSnapshotDelta(
  previousSnapshot: string | undefined,
  currentSnapshot: string
): SnapshotDeltaResult {
  const currLines = currentSnapshot ? currentSnapshot.split("\n") : [];
  if (previousSnapshot === undefined) {
    return {
      changed: true,
      added: currLines.length,
      removed: 0,
      delta: currLines.map((line) => `+ ${line}`).join("\n")
    };
  }
  const prevLines = previousSnapshot ? previousSnapshot.split("\n") : [];
  const prevNorm = prevLines.map(normalizeLineForDelta);
  const currNorm = currLines.map(normalizeLineForDelta);

  if (
    prevNorm.length === currNorm.length &&
    prevNorm.every((line, index) => line === currNorm[index])
  ) {
    return {
      changed: false,
      added: 0,
      removed: 0,
      delta: "(unchanged)"
    };
  }

  let prefix = 0;
  while (
    prefix < prevNorm.length &&
    prefix < currNorm.length &&
    prevNorm[prefix] === currNorm[prefix]
  ) {
    prefix += 1;
  }
  let prevEnd = prevNorm.length - 1;
  let currEnd = currNorm.length - 1;
  while (
    prevEnd >= prefix &&
    currEnd >= prefix &&
    prevNorm[prevEnd] === currNorm[currEnd]
  ) {
    prevEnd -= 1;
    currEnd -= 1;
  }

  const prevMid = prevNorm.slice(prefix, prevEnd + 1);
  const currMid = currNorm.slice(prefix, currEnd + 1);
  const prevMidRaw = prevLines.slice(prefix, prevEnd + 1);
  const currMidRaw = currLines.slice(prefix, currEnd + 1);

  type EditOp = { type: "equal" | "add" | "remove"; text: string };
  const ops: EditOp[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: "equal", text: currLines[i] });
  }

  const m = prevMid.length;
  const n = currMid.length;
  if (m * n <= 250_000) {
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i][j] = prevMid[i] === currMid[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (prevMid[i] === currMid[j]) {
        ops.push({ type: "equal", text: currMidRaw[j] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "remove", text: prevNorm[prefix + i] });
        i += 1;
      } else {
        ops.push({ type: "add", text: currMidRaw[j] });
        j += 1;
      }
    }
    while (i < m) {
      ops.push({ type: "remove", text: prevNorm[prefix + i] });
      i += 1;
    }
    while (j < n) {
      ops.push({ type: "add", text: currMidRaw[j] });
      j += 1;
    }
  } else {
    for (let i = 0; i < m; i += 1) ops.push({ type: "remove", text: prevMidRaw[i].replace(/\s*\[ref=e\d+\]/g, "") });
    for (let j = 0; j < n; j += 1) ops.push({ type: "add", text: currMidRaw[j] });
  }

  for (let j = currEnd + 1; j < currLines.length; j += 1) {
    ops.push({ type: "equal", text: currLines[j] });
  }

  let added = 0;
  let removed = 0;
  const include = new Array<boolean>(ops.length).fill(false);
  const CONTEXT = 1;
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (ops[idx].type !== "equal") {
      if (ops[idx].type === "add") added += 1;
      else removed += 1;
      const start = Math.max(0, idx - CONTEXT);
      const end = Math.min(ops.length - 1, idx + CONTEXT);
      for (let k = start; k <= end; k += 1) include[k] = true;
    }
  }

  const out: string[] = [];
  let skippedContext = false;
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (!include[idx]) {
      skippedContext = true;
      continue;
    }
    if (skippedContext && out.length > 0) {
      out.push("...");
    }
    skippedContext = false;
    const op = ops[idx];
    if (op.type === "add") out.push(`+ ${op.text}`);
    else if (op.type === "remove") out.push(`- ${op.text}`);
    else out.push(`  ${op.text}`);
  }

  return {
    changed: added > 0 || removed > 0,
    added,
    removed,
    delta: out.join("\n")
  };
}

/** References are owned by this service, never recycled after a navigation. */
export class EngineReferences {
  private next = randomInt(100000, 900000);
  private refs = new Map<string, { page: Page; locator: Locator }>();
  private previousSnapshots = new WeakMap<object, Map<string, { url: string; snapshot: string }>>();
  version?: string;
  clear(): void { this.refs.clear(); this.version = undefined; }
  clearHistory(): void { this.previousSnapshots = new WeakMap(); }
  async boxes(page: Page): Promise<Array<{ ref: string; x: number; y: number; width: number; height: number }>> {
    const boxes = [];
    for (const [ref, entry] of this.refs) {
      if (entry.page !== page) continue;
      const box = await entry.locator.boundingBox().catch(() => null);
      if (box) boxes.push({ ref, ...box });
    }
    return boxes;
  }
  locator(page: Page, frame: Frame, selector: string): Locator {
    if (/^@?(?:e\d+|f\d+e\d+)$/.test(selector)) {
      const entry = this.refs.get(selector.replace(/^@/, ""));
      if (!entry || entry.page !== page) throw new EngineError("Element ref is stale or belongs to another tab. Take a fresh snapshot.", "BROWSER_STALE_REF");
      return entry.locator;
    }
    return frame.locator(selector);
  }
  async snapshot(
    page: Page,
    frame: Frame,
    args: string[]
  ): Promise<{
    snapshot: string;
    version: string;
    refs: Record<string, { role: string; name: string }>;
    delta?: boolean;
    changed?: boolean;
    added?: number;
    removed?: number;
  }> {
    const depth = option(args, "--depth", "-d");
    if (depth !== undefined && (!/^\d+$/.test(depth) || Number(depth) > 100)) throw new EngineError("Invalid snapshot depth", "BROWSER_INVALID_ARGUMENTS");
    const selector = option(args, "--selector", "-s");
    const interactive = has(args, "-i", "--interactive");
    const compact = has(args, "-c", "--compact");
    const deltaRequested = has(args, "--delta");
    const settings = { mode: "ai" as const, depth: depth === undefined ? undefined : Number(depth), timeout: 15000 };
    const raw = selector ? await frame.locator(selector).ariaSnapshot(settings)
      : frame === page.mainFrame() ? await page.ariaSnapshot(settings) : await frame.locator("body").ariaSnapshot(settings);
    this.clear();
    const metadata: Record<string, { role: string; name: string }> = {};
    const mapping = new Map<string, string>();
    let snapshot = raw.replace(/\[ref=([a-z0-9]+)\]/g, (_, source: string) => {
      let ref = mapping.get(source);
      if (!ref) {
        ref = `e${this.next++}`;
        mapping.set(source, ref);
        this.refs.set(ref, { page, locator: frame === page.mainFrame() ? page.getByRef(source) : frame.locator(`aria-ref=${source}`) });
      }
      return `[ref=${ref}]`;
    });
    if (interactive) {
      snapshot = filterInteractiveSnapshot(snapshot);
    }
    if (compact) {
      snapshot = snapshot.split("\n").filter(line => !/^\s*-\s+(?:generic|group):?\s*$/.test(line)).join("\n");
    }
    for (const line of snapshot.split("\n")) {
      const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
      if (ref) {
        const match = line.match(/^\s*-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
        metadata[ref] = { role: match?.[1] || "element", name: match?.[2] || "" };
      }
    }
    this.version = randomUUID();
    const frameKeyObj = (frame && typeof frame === "object") ? frame : page;
    let byMode = this.previousSnapshots.get(frameKeyObj);
    if (!byMode) {
      byMode = new Map();
      this.previousSnapshots.set(frameKeyObj, byMode);
    }
    const currentUrl = typeof (frame as { url?: unknown })?.url === "function"
      ? frame.url()
      : typeof (page as { url?: unknown })?.url === "function"
        ? page.url()
        : "";
    const modeKey = `${selector || ""}|i=${interactive ? 1 : 0}|c=${compact ? 1 : 0}|d=${depth || ""}`;
    const prev = byMode.get(modeKey);
    byMode.set(modeKey, { url: currentUrl, snapshot });

    if (deltaRequested) {
      const diff = computeSnapshotDelta(prev && prev.url === currentUrl ? prev.snapshot : undefined, snapshot);
      return {
        snapshot: diff.delta,
        version: this.version,
        refs: metadata,
        delta: true,
        changed: diff.changed,
        added: diff.added,
        removed: diff.removed
      };
    }
    return { snapshot, version: this.version, refs: metadata };
  }
}
