import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import QRCode from "qrcode";
import type { PhoneCloudStatus, PhoneDevice } from "../../shared/phones";
import { readinessSchema } from "./readiness-schema";

export const DEFAULT_STATUS_URL = "https://124-221-36-36.anyip.dev:8443/profilepilot-status";
const credential = z.string().regex(/^[a-f0-9]{64}$/);
const channelSchema = z.object({ id: z.string().uuid(), token: credential, url: z.string().url(), name: z.string().max(80) });
const reportSchema = z.object({ deviceId: z.string().uuid(), name: z.string().min(1).max(80), permissions: z.object({ accessibility: z.boolean(), overlay: z.boolean(), notifications: z.boolean() }), readiness: readinessSchema });
export function statusUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("状态服务器必须使用 HTTPS，且不能包含凭据或查询参数。");
  return url.href.replace(/\/+$/, "");
}
type Channel = z.infer<typeof channelSchema>;
export class PhoneCloud {
  private channels: Channel[];
  private states = new Map<string, PhoneCloudStatus>();
  private errors = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private creating = false;
  private file: string;
  constructor(root: string, private changed: () => void, private request = fetch, private now = Date.now) {
    this.file = path.join(root, "status-channels.json");
    this.channels = fs.existsSync(this.file) ? z.array(channelSchema).max(32).parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) : [];
    for (const channel of this.channels) channel.url = statusUrl(channel.url);
  }
  private persist(): void { fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.channels), { mode: 0o600 }); fs.renameSync(this.file + ".tmp", this.file); }
  private async call(channel: Channel, method: string, extra = {}): Promise<unknown> {
    const response = await this.request(`${channel.url}/v1/${method}`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${channel.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: channel.id, ...extra }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 || response.status === 401 ? "状态同步已失效，请移除后重新扫码配对。" : `状态服务器暂不可达（${response.status}）`);
    const body = await response.text(); if (body.length > 16384) throw new Error("状态响应过大。"); return JSON.parse(body);
  }
  start(): void { if (!this.timer && !this.closed) { this.timer = setInterval(() => void this.refresh(), 10000); this.timer.unref(); void this.refresh(); } }
  async pair(url = DEFAULT_STATUS_URL) {
    if (this.creating) throw new Error("正在生成配对码，请稍候。");
    if (this.channels.length >= 32) throw new Error("请先移除不用的状态同步设备。");
    this.creating = true;
    try {
      const channel: Channel = { id: randomUUID(), token: randomBytes(32).toString("hex"), url: statusUrl(url), name: "等待手机扫码" };
      const pairToken = randomBytes(32).toString("hex");
      const result = z.object({ expires: z.number() }).parse(await this.call(channel, "create", { pairToken }));
      this.channels.push(channel); this.persist(); this.changed();
      const uri = `profilepilot://status?${new URLSearchParams({ url: channel.url, id: channel.id, token: pairToken })}`;
      return { id: channel.id, uri, qrCode: await QRCode.toDataURL(uri, { width: 300, margin: 1 }), expiresAt: result.expires };
    } finally { this.creating = false; }
  }
  async forget(id: string): Promise<void> {
    const channel = this.channels.find(c => `cloud-${c.id}` === id); if (!channel) throw new Error("状态同步设备不存在。");
    try { await this.call(channel, "revoke"); } catch (error) { if (!(error as Error).message.includes("已失效")) throw error; }
    this.channels = this.channels.filter(c => c !== channel); this.states.delete(channel.id); this.errors.delete(channel.id); this.persist(); this.changed();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.all(this.channels.map(async channel => {
      const startedAt = this.now();
      try {
        const result = z.object({ paired: z.boolean(), ageMs: z.number().nonnegative().nullable(), report: reportSchema.nullable() }).parse(await this.call(channel, "status"));
        if (this.closed || !this.channels.includes(channel)) return;
        this.states.set(channel.id, { paired: result.paired, report: result.report, reportedAt: result.report && result.ageMs !== null ? startedAt - result.ageMs : null });
        this.errors.delete(channel.id);
        if (result.report && result.report.name !== channel.name) { channel.name = result.report.name; this.persist(); }
      } catch (error) { if (!this.closed && this.channels.includes(channel)) this.errors.set(channel.id, (error as Error).message); }
    })).then(() => { if (!this.closed) this.changed(); }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  devices(): PhoneDevice[] { return this.channels.map(c => ({ id: `cloud-${c.id}`, name: c.name, model: c.name, transport: "cloud", connection: "missing", companion: "unavailable", state: null, confirmedAt: null, pending: null, error: this.errors.get(c.id) || "", cloud: { ...(this.states.get(c.id) || { paired: false, report: null, reportedAt: null }), channelId: c.id } })); }
  close(): void { this.closed = true; clearInterval(this.timer); }
}
