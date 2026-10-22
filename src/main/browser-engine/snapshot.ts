import { randomInt, randomUUID } from "node:crypto";
import type { Page, Frame, Locator } from "playwright-core";
import { EngineError, has, option } from "./arguments";

/** References are owned by this service, never recycled after a navigation. */
export class EngineReferences {
  private next = randomInt(100000, 900000);
  private refs = new Map<string, { page: Page; locator: Locator }>();
  version?: string;
  clear(): void { this.refs.clear(); this.version = undefined; }
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
  async snapshot(page: Page, frame: Frame, args: string[]): Promise<{ snapshot: string; version: string; refs: Record<string, { role: string; name: string }> }> {
    const depth = option(args, "--depth", "-d");
    if (depth !== undefined && (!/^\d+$/.test(depth) || Number(depth) > 100)) throw new EngineError("Invalid snapshot depth", "BROWSER_INVALID_ARGUMENTS");
    const selector = option(args, "--selector", "-s");
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
    for (const line of snapshot.split("\n")) {
      const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
      if (ref) {
        const match = line.match(/^\s*-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
        metadata[ref] = { role: match?.[1] || "element", name: match?.[2] || "" };
      }
    }
    if (has(args, "-i", "--interactive")) {
      snapshot = snapshot.split("\n").filter(line => /^\s*-\s+(?:button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|tab|menuitem|option|treeitem)\b/.test(line)).join("\n");
    }
    if (has(args, "-c", "--compact")) snapshot = snapshot.split("\n").filter(line => !/^\s*-\s+(?:generic|group):?\s*$/.test(line)).join("\n");
    this.version = randomUUID();
    return { snapshot, version: this.version, refs: metadata };
  }
}
