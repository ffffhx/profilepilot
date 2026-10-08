import { StringDecoder } from "node:string_decoder";

/** Windows PowerShell may serialize stderr even with -OutputFormat Text.
 * Consume only CLIXML string records; never interpret XML as terminal markup.
 * Both UTF-8 characters and XML records can cross arbitrary pipe boundaries. */
export class ShellTextDecoder {
  private readonly utf8 = new StringDecoder("utf8");
  private pending = "";
  private xml = false;
  constructor(private readonly powershell = false) {}
  write(chunk: Buffer): string { return this.consume(this.utf8.write(chunk), false); }
  end(): string { return this.consume(this.utf8.end(), true); }
  private consume(text: string, final: boolean): string {
    if (!this.powershell) return text;
    this.pending += text;
    let result = "";
    for (;;) {
      if (!this.xml) {
        const marker = this.pending.indexOf("#< CLIXML");
        if (marker >= 0) { result += this.pending.slice(0, marker); this.pending = this.pending.slice(marker + 9); this.xml = true; continue; }
        // Retain only a possible partial marker at the end of an ordinary chunk.
        let hold = 0;
        if (!final) for (let size = 1; size < 9; size++) if ("#< CLIXML".startsWith(this.pending.slice(-size))) hold = size;
        result += this.pending.slice(0, this.pending.length - hold);
        this.pending = hold ? this.pending.slice(-hold) : ""; break;
      }
      const record = /<S\b[^>]*>([\s\S]*?)<\/S>/.exec(this.pending);
      const end = this.pending.indexOf("</Objs>");
      if (record && (end < 0 || record.index < end)) {
        result += decodeString(record[1]); this.pending = this.pending.slice(record.index + record[0].length); continue;
      }
      if (end >= 0) { this.pending = this.pending.slice(end + 7); this.xml = false; continue; }
      if (final) { if (this.pending.trim()) result += "\n[PowerShell 输出记录不完整]\n"; this.pending = ""; }
      else if (this.pending.length > 1024 * 1024) { this.pending = ""; this.xml = false; result += "\n[PowerShell 输出记录过长]\n"; }
      break;
    }
    return result;
  }
}
function decodeString(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") { const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)); return point <= 0x10ffff ? String.fromCodePoint(point) : "�"; }
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[entity] || match;
  }).replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
