import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { ZipFile } from "yazl";
import type { IphoneWdaArtifact } from "../../shared/iphones";

export const WDA_VERSION = "16.15.3";
export const WDA_SHA256 = "2176793538d902f6b1e61291e9997f68d306541f222ea715d256a7c6ce9d4fc5";
export async function downloadVerified(url: string, sha256: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`下载 iPhone 组件失败（HTTP ${response.status}）。`);
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    bytes += chunk.length; if (bytes > 150 * 1024 * 1024) throw new Error("iPhone 组件下载超出大小限制。"); chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error("iPhone 组件 SHA-256 校验失败，未安装。");
  return content;
}

/** Package Appium's pinned real-device build; this IPA still needs the user's Apple signature. */
export async function prepareWda(root: string, fetcher: typeof fetch): Promise<IphoneWdaArtifact> {
  const directory = path.join(root, `webdriveragent-${WDA_VERSION}`), ipa = path.join(directory, "WebDriverAgent.ipa");
  const receipt = path.join(directory, "prepared.json");
  try {
    const cached = JSON.parse(await fs.readFile(receipt, "utf8"));
    if (cached.format === 2 && cached.sourceSha256 === WDA_SHA256 && cached.ipaSha256 === createHash("sha256").update(await fs.readFile(ipa)).digest("hex"))
      return { version: WDA_VERSION, ipa, app: path.join(directory, "WebDriverAgentRunner-Runner.app"), sourceSha256: WDA_SHA256, requiresSigning: true };
  } catch { /* Missing or modified artifact: download a verified copy. */ }
  await fs.mkdir(directory, { recursive: true });
  const zipPath = path.join(directory, "upstream.zip");
  let content: Buffer | undefined = await fs.readFile(zipPath).catch(() => undefined);
  if (!content || createHash("sha256").update(content).digest("hex") !== WDA_SHA256)
    content = await downloadVerified(`https://github.com/appium/WebDriverAgent/releases/download/v${WDA_VERSION}/WebDriverAgentRunner-Runner.zip`, WDA_SHA256, fetcher);
  await fs.writeFile(zipPath, content);
  const app = await packageWdaIpa(directory, zipPath, ipa);
  await fs.writeFile(receipt, JSON.stringify({ format: 2, sourceSha256: WDA_SHA256, ipaSha256: createHash("sha256").update(await fs.readFile(ipa)).digest("hex") }));
  return { version: WDA_VERSION, ipa, app, sourceSha256: WDA_SHA256, requiresSigning: true };
}

/** Called only after verifying the archive; preserve UNIX modes when packaging on Windows. */
export async function packageWdaIpa(directory: string, zipPath: string, ipa: string): Promise<string> {
  const modes = new Map<string, number>();
  await extractZip(zipPath, { dir: directory, onEntry: entry => { modes.set(entry.fileName, entry.externalFileAttributes >>> 16); } });
  const app = path.join(directory, "WebDriverAgentRunner-Runner.app"), zip = new ZipFile();
  async function add(folder: string, relative: string): Promise<void> {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const name = path.join(folder, item.name), target = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error("控制组件包含不支持的链接，未生成安装包。");
      // Windows stat() loses POSIX executable bits. Retain the upstream IPA permissions.
      const mode = modes.get(target.slice("Payload/".length));
      if (item.isDirectory()) { zip.addEmptyDirectory(target, { mode: mode || 0o40755 }); await add(name, target); }
      else if (item.isFile()) {
        if (!mode) throw new Error("控制组件文件不属于已校验的上游安装包。");
        zip.addFile(name, target, { mode });
      }
    }
  }
  await add(app, "Payload/WebDriverAgentRunner-Runner.app");
  const temporary = `${ipa}.${randomUUID()}.tmp`, output = pipeline(zip.outputStream, createWriteStream(temporary));
  zip.end(); await output; await fs.rename(temporary, ipa);
  return app;
}
