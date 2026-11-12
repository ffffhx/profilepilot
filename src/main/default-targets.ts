import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DefaultProfile, DefaultPhone } from "../shared/default-targets";

const target = z.object({ id: z.string().min(1).max(500), name: z.string().min(1).max(200) });
const phone = target.extend({ hardwareId: z.string().min(1).max(200).optional(), statusDeviceId: z.string().min(1).max(200).optional(), udid: z.string().min(1).max(200).optional() });

/** Shared by the UI and CLI. A missing target is retained, never silently replaced. */
export class DefaultTargetStore {
  constructor(private root: string) {}
  profile(): DefaultProfile | null { return this.read("default-profile.json", target); }
  phone(): DefaultPhone | null { return this.read("default-phone.json", phone); }
  setProfile(value: DefaultProfile | null): void { this.write("default-profile.json", value === null ? null : target.parse(value)); }
  setPhone(value: DefaultPhone | null): void { this.write("default-phone.json", value === null ? null : phone.parse(value)); }
  private read<T>(file: string, schema: z.ZodType<T>): T | null {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.root, file), "utf8"));
      return value === null ? null : schema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`默认目标设置无法读取（${file}），请修复设置后继续。`, { cause: error });
    }
  }
  private write(file: string, value: unknown): void {
    fs.mkdirSync(this.root, { recursive: true });
    const destination = path.join(this.root, file), temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
