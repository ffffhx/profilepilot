import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Both CLI and service validate the file. Android's package manager verifies
// the APK signature/package and rejects incompatible updates without uninstall.
export async function inspectApk(file: string): Promise<{ sha256: string; bytes: number }> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".apk") throw new Error("请提供本地 APK 文件的绝对路径。");
  const handle = await fs.promises.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 4 || stat.size > 512 * 1024 * 1024) throw new Error("APK 必须是小于 512 MiB 的普通文件。");
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (!header.equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new Error("文件不是有效的 APK 压缩包。");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) throw new Error("APK 超过 512 MiB。");
      hash.update(chunk);
    }
    if (bytes !== stat.size) throw new Error("APK 文件正在改变，请完成构建后再安装。");
    return { sha256: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}
