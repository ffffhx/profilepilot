import type { AdbRunner } from "./adb";
import type { AdbProcess, AdbProcessOptions } from "./adb-process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

type Mapping = { lease: string; id: string; generation: number; kind: "forward" | "reverse"; local: string; remote: string };
/** Forwarding outlives an adb client. Keep task ownership separately, and never
 * let --remove-all delete the companion channel or another tool's sockets. */
export class AdbForwarding {
  private mappings = new Map<string, Mapping>();
  private cleaning = new Map<string, Promise<void>>();
  constructor(private adb: AdbRunner, private journal?: string) {
    if (journal && fs.existsSync(journal)) {
      const entries = z.array(z.object({ lease: z.string().uuid(), id: z.string().regex(/^[a-zA-Z0-9_.:[\]-]{1,200}$/), generation: z.number().int().nonnegative(),
        kind: z.enum(["forward", "reverse"]), local: z.string().min(1).max(4096), remote: z.string().min(1).max(4096) }).strict()).max(4096).parse(JSON.parse(fs.readFileSync(journal, "utf8")));
      for (const mapping of entries) this.mappings.set(this.key(mapping), mapping);
    }
  }
  private persist() {
    if (!this.journal) return;
    fs.mkdirSync(path.dirname(this.journal), { recursive: true });
    const temporary = this.journal + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify([...this.mappings.values()]), { mode: 0o600 });
    fs.renameSync(temporary, this.journal);
  }
  owners() { return [...new Map([...this.mappings.values()].map(m => [m.lease, { lease: m.lease, generation: m.generation }])).values()]; }
  private key(m: Pick<Mapping, "id" | "kind" | "local">) { return `${m.id}\0${m.kind}\0${m.local}`; }
  spawn(lease: string, generation: number, id: string, args: string[], options: AdbProcessOptions): AdbProcess {
    const kind = args[0] as "forward" | "reverse", tail = args.slice(1);
    if (tail.length === 1 && tail[0] === "--list") return this.adb.spawn!(["-s", id, ...args], options);
    if (tail[0] === "--remove" && tail.length === 2 || tail[0] === "--remove-all" && tail.length === 1) {
      const targets = [...this.mappings.values()].filter(m => m.lease === lease && m.id === id && m.kind === kind && (tail[0] === "--remove-all" || m.local === tail[1]));
      if (tail[0] === "--remove" && !targets.length) throw new Error("只能删除本任务创建的端口映射。");
      const abort = new AbortController();
      return { done: (async () => { for (const target of targets) await this.remove(target, abort.signal); return { code: 0, signal: null }; })(),
        end() {}, write: async () => { throw new Error("端口操作不接受 stdin。"); }, abort: () => abort.abort() };
    }
    const endpoints = tail[0] === "--no-rebind" ? tail.slice(1) : tail;
    if (endpoints.length !== 2 || endpoints.some(e => !/^(?:tcp:\d{1,5}|(?:localabstract|localreserved|localfilesystem|dev|dev-raw):[^\x00-\x1f]+|jdwp:\d+|vsock:\d+:\d+)$/.test(e))) throw new Error("端口映射参数无效。");
    const [local, remote] = endpoints;
    if (this.mappings.has(this.key({ id, kind, local }))) throw new Error("端口已有映射；请先移除本任务的旧映射。");
    let stdout = "";
    const child = this.adb.spawn!(["-s", id, kind, "--no-rebind", ...endpoints], {
      ...options, stdout: bytes => { stdout = (stdout + bytes.toString("utf8")).slice(0, 1024); options.stdout(bytes); }
    });
    return { ...child, done: child.done.then(result => {
      if (result.code === 0) {
        const actual = local === "tcp:0" ? `tcp:${stdout.trim()}` : local;
        if (local === "tcp:0" && !/^tcp:[1-9]\d{0,4}$/.test(actual)) throw new Error("ADB 未返回已分配的端口；请核对映射状态。");
        const mapping: Mapping = { lease, generation, id, kind, local: actual, remote };
        this.mappings.set(this.key(mapping), mapping);
        this.persist();
      }
      return result;
    }) };
  }
  private async remove(mapping: Mapping, signal?: AbortSignal) {
    const key = this.key(mapping);
    if (this.mappings.get(key) !== mapping) return;
    const listing = await this.adb.run(["-s", mapping.id, mapping.kind, "--list"], 5000, undefined, signal);
    const matches = listing.split(/\r?\n/).some(line => {
      const words = line.trim().split(/\s+/);
      return words.length === 3 && (mapping.kind === "reverse" || words[0] === mapping.id) && words[1] === mapping.local && words[2] === mapping.remote;
    });
    if (matches) await this.adb.run(["-s", mapping.id, mapping.kind, "--remove", mapping.local], 5000, undefined, signal);
    // If a mapping was externally replaced, it is no longer ours to remove.
    if (this.mappings.get(key) === mapping) { this.mappings.delete(key); this.persist(); }
  }
  cleanup(lease: string): Promise<void> {
    const current = this.cleaning.get(lease); if (current) return current;
    const work = (async () => {
      const errors: string[] = [];
      for (const mapping of [...this.mappings.values()].filter(m => m.lease === lease)) {
        try { await this.remove(mapping); } catch (error) { errors.push((error as Error).message); }
      }
      if (errors.length) throw new Error("端口清理尚未完成，保留所有权供重试：" + errors.join("; "));
    })().finally(() => this.cleaning.delete(lease));
    this.cleaning.set(lease, work); return work;
  }
}
