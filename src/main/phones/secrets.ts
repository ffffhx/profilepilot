import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";

export type UnlockSecretKind = "pattern" | "credential";

export interface UnlockSecretInfo {
  kind: UnlockSecretKind;
  savedAt: number;
  allowAgent: boolean;
}

/** Write-only from the UI's perspective: values are never read back into a snapshot. */
export interface SecretStore {
  available(): boolean;
  status(key: string): UnlockSecretInfo | null;
  get(key: string): string | null;
  save(key: string, input: { kind: UnlockSecretKind; value: string; allowAgent: boolean }): UnlockSecretInfo;
  remove(key: string): boolean;
}

const recordSchema = z.object({
  kind: z.enum(["pattern", "credential"]),
  savedAt: z.number(),
  allowAgent: z.boolean(),
  data: z.string().min(1).max(4096)
});
const fileSchema = z.record(z.string(), recordSchema);
type StoredRecord = z.infer<typeof recordSchema>;

/**
 * Windows DPAPI / macOS Keychain via Electron. Linux falls back to a plain
 * keyring only when a real backend is selected; `basic_text` is rejected.
 */
export function secureStorageAvailable(): boolean {
  try {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    const backend = safeStorage.getSelectedStorageBackend?.();
    return backend !== "basic_text";
  } catch { return false; }
}

export function createSecretStore(file: string): SecretStore {
  let records: Record<string, StoredRecord> | null = null;
  const load = () => {
    if (records) return records;
    try { records = fileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch { records = {}; }
    return records;
  };
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return {
    available: secureStorageAvailable,
    status(key) {
      const record = load()[key];
      return record ? { kind: record.kind, savedAt: record.savedAt, allowAgent: record.allowAgent } : null;
    },
    get(key) {
      const record = load()[key];
      if (!record || !secureStorageAvailable()) return null;
      try { return safeStorage.decryptString(Buffer.from(record.data, "base64")); }
      catch { return null; }
    },
    save(key, input) {
      if (!secureStorageAvailable()) throw new Error("系统安全存储不可用，无法保存解锁凭据。");
      const record: StoredRecord = {
        kind: input.kind, savedAt: Date.now(), allowAgent: input.allowAgent,
        data: safeStorage.encryptString(input.value).toString("base64")
      };
      load()[key] = record; persist();
      return { kind: record.kind, savedAt: record.savedAt, allowAgent: record.allowAgent };
    },
    remove(key) {
      const all = load();
      if (!(key in all)) return false;
      delete all[key]; persist();
      return true;
    }
  };
}
