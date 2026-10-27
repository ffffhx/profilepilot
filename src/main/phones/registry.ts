import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PhoneDevice, PhoneNearbyApp } from "../../shared/phones";

const recordSchema = z.object({ deviceId: z.string().uuid(), name: z.string().min(1).max(80), model: z.string().max(100), address: z.string().ipv4() });
/** Remember an explicitly selected discovery result without creating control authority. */
export class PhoneRegistry {
  private records: z.infer<typeof recordSchema>[];
  private file: string;
  constructor(root: string) {
    this.file = path.join(root, "registered-devices.json");
    this.records = fs.existsSync(this.file) ? z.array(recordSchema).max(128).parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) : [];
  }
  private persist(): void { fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.records), { mode: 0o600 }); fs.renameSync(this.file + ".tmp", this.file); }
  add(app: PhoneNearbyApp): PhoneDevice {
    if (!app.deviceId) throw new Error("请更新手机 App 后再添加；旧版仍可通过 USB 或 Wi-Fi 调试连接。");
    const previous = this.records.find(r => r.deviceId === app.deviceId);
    if (!previous && this.records.length >= 128) throw new Error("请先移除不用的设备。");
    if (previous) previous.address = app.ip;
    else this.records.push(recordSchema.parse({ deviceId: app.deviceId, name: app.name.slice(0, 80), model: app.name, address: app.ip }));
    this.persist(); return this.devices().find(d => d.registration?.deviceId === app.deviceId)!;
  }
  rename(id: string, name: string): void {
    const record = this.records.find(r => `registered-${r.deviceId}` === id);
    if (!record) throw new Error("设备不存在。"); record.name = name; this.persist();
  }
  forget(id: string): void { this.records = this.records.filter(r => `registered-${r.deviceId}` !== id); this.persist(); }
  devices(): PhoneDevice[] {
    return this.records.map(r => ({ id: `registered-${r.deviceId}`, name: r.name, model: r.model, transport: "registered", connection: "missing", companion: "unknown", state: null, confirmedAt: null, pending: null, error: "", registration: { deviceId: r.deviceId, source: "lan", address: r.address } }));
  }
}
