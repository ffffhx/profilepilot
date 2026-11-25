import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { z } from "zod";
import type { PhoneSmsEntry } from "../../shared/phone-sms";

const smsSchema = z.object({
  event: z.literal("sms:received"), messageId: z.string().uuid(),
  sender: z.string().max(256), message: z.string().max(65536),
  receivedAt: z.number().int().min(0).max(8640000000000000), simNumber: z.number().int().min(1).max(32).nullable()
}).strict();

export interface SmsProtection {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

/** Only receipt IDs and arrival order are searchable. All user-visible fields are encrypted. */
export class SmsInbox {
  private db?: DatabaseSync;
  constructor(private root: string, private protection: SmsProtection, private notify: (name: string) => void) {}
  private database(): DatabaseSync {
    if (!this.db) {
      const db = new DatabaseSync(path.join(this.root, "sms-inbox.sqlite"));
      db.exec("CREATE TABLE IF NOT EXISTS sms (device TEXT NOT NULL, id TEXT NOT NULL, added INTEGER NOT NULL, data BLOB, UNIQUE(device,id))");
      this.db = db;
    }
    return this.db;
  }
  receive(device: string, deviceName: string, value: unknown): string {
    const sms = smsSchema.parse(value);
    const db = this.database();
    if (db.prepare("SELECT 1 FROM sms WHERE device=? AND id=?").get(device, sms.messageId)) return sms.messageId;
    const encrypted = this.protection.encrypt(JSON.stringify({ ...sms, deviceName }));
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO sms(device,id,added,data) VALUES(?,?,?,?)").run(device, sms.messageId, now, encrypted);
      db.exec("UPDATE sms SET data=NULL WHERE data IS NOT NULL AND rowid <= (SELECT rowid FROM sms ORDER BY rowid DESC LIMIT 1 OFFSET 100)");
      db.prepare("DELETE FROM sms WHERE data IS NULL AND added < ?").run(now - 3 * 86400000);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    try { this.notify(deviceName); } catch { /* Desktop notification settings never affect delivery. */ }
    return sms.messageId;
  }
  list(): PhoneSmsEntry[] {
    const rows = this.database().prepare("SELECT data FROM sms WHERE data IS NOT NULL ORDER BY rowid DESC LIMIT 100").all();
    return rows.map(row => JSON.parse(this.protection.decrypt(Buffer.from(row.data as Uint8Array))));
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
