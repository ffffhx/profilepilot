import fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export type WirelessServerEvidence = {
  source: "adb-server";
  reason: "AUTH_REQUIRED" | "CONNECTION_REFUSED" | "NETWORK_TIMEOUT";
  signature: string;
};
export type WirelessLogCursor = { file: FileHandle; offset: number };

/** Read only bytes appended during this command. Never return raw log lines:
 * the shared server log can contain keys and unrelated devices' activity. */
export function wirelessServerEvidence(text: string, operation: string, address: string): WirelessServerEvidence | undefined {
  const pending = new Map<string, { signature: string; line: number }>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+[A-Z]\s+adb\s*:\s*(.*)$/);
    if (!match) continue;
    const thread = `${match[1]}:${match[2]}`, body = match[3];
    if (operation === "pair" && body.includes(`cannot connect to ${address}:`)) {
      if (/10061|ECONNREFUSED|Connection refused|拒绝/i.test(body))
        return { source: "adb-server", reason: "CONNECTION_REFUSED", signature: "pairing connection refused" };
      if (/10060|ETIMEDOUT|timed out|unreachable|超时/i.test(body))
        return { source: "adb-server", reason: "NETWORK_TIMEOUT", signature: "pairing connection unreachable" };
    }
    if (operation !== "connect") continue;
    const certificate = body.match(/\[(SSLV3_ALERT_(?:CERTIFICATE_UNKNOWN|BAD_CERTIFICATE|CERTIFICATE_EXPIRED|CERTIFICATE_REVOKED)|TLSV1_ALERT_UNKNOWN_CA|CERTIFICATE_VERIFY_FAILED)\]/);
    if (certificate) pending.set(thread, { signature: certificate[1], line: i });
    // TLS errors don't contain the endpoint; the immediately associated transport
    // teardown on the SAME server thread does. Other threads/devices cannot match.
    const transport = body.match(/kicking transport \S+ (\S+)\s*$/);
    if (transport) {
      const error = pending.get(thread); pending.delete(thread);
      if (transport[1] === address && error && i - error.line <= 8)
        return { source: "adb-server", reason: "AUTH_REQUIRED", signature: error.signature };
    }
  }
  return undefined;
}

export function adbServerLogPath(status: string): string | undefined {
  const quoted = status.match(/^log_absolute_path:\s*("(?:[^"\\]|\\.)*")\s*$/m)?.[1];
  if (!quoted) return;
  try {
    // Protobuf TextFormat uses C octal escapes for UTF-8 paths, and doubled
    // backslashes on Windows. Decode without evaluating any path as code.
    let octal = false;
    const escaped = quoted.replace(/\\(?:["\\/bfnrt]|[0-7]{3})/g, token => {
      if (!/^\\[0-7]{3}$/.test(token)) return token;
      octal = true;
      return `\\u00${parseInt(token.slice(1), 8).toString(16).padStart(2, "0")}`;
    });
    const decoded = JSON.parse(escaped);
    const value = octal ? Buffer.from(decoded, "latin1").toString("utf8") : decoded;
    return typeof value === "string" && !value.includes("\0") && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) ? value : undefined;
  } catch { return; }
}

export class WirelessServerLog {
  private location?: { at: number; path?: string };
  constructor(private status: () => Promise<string>) {}
  async capture(): Promise<WirelessLogCursor | undefined> {
    let file: FileHandle | undefined;
    try {
      if (!this.location || Date.now() - this.location.at > 30000) {
        this.location = { at: Date.now(), path: adbServerLogPath(await this.status()) };
      }
      if (!this.location.path) return;
      file = await fs.open(this.location.path, "r");
      const stat = await file.stat();
      if (!stat.isFile()) { await file.close(); return; }
      return { file, offset: stat.size };
    } catch {
      await file?.close().catch(() => {});
      this.location = { at: Date.now() };
      return;
    }
  }
  async finish(cursor: WirelessLogCursor | undefined, operation: string, address: string, failed: boolean): Promise<WirelessServerEvidence | undefined> {
    if (!cursor) return;
    try {
      if (!failed) return;
      const length = (await cursor.file.stat()).size - cursor.offset;
      // Rotation/truncation or excess concurrent logging makes correlation uncertain.
      if (length <= 0 || length > 256 * 1024) return;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await cursor.file.read(buffer, 0, length, cursor.offset);
      return wirelessServerEvidence(buffer.subarray(0, bytesRead).toString("utf8"), operation, address);
    } catch { return; }
    finally { await cursor.file.close().catch(() => {}); }
  }
}
