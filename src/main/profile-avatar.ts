import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_AVATAR_BYTES = 1024 * 1024;
const cache = new Map<string, { signature: string; data: string | null }>();

/** Read Chrome's cached account picture locally; never fetch account URLs. */
export async function readProfileAvatar(profilePath: string, fileName: unknown = "Google Profile Picture.png"): Promise<string | null> {
  if (typeof fileName !== "string" || !fileName || /[/\\:]/.test(fileName) || fileName === "." || fileName === "..") return null;
  const file = path.join(profilePath, fileName);
  try {
    const [root, resolved, stat] = await Promise.all([fs.realpath(profilePath), fs.realpath(file), fs.stat(file)]);
    if (path.dirname(resolved) !== root || !stat.isFile() || stat.size > MAX_AVATAR_BYTES) return null;
    const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = cache.get(file);
    if (cached?.signature === signature) return cached.data;
    const bytes = await fs.readFile(resolved);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const data = bytes.length <= MAX_AVATAR_BYTES && (png || jpeg) ? `data:image/${png ? "png" : "jpeg"};base64,${bytes.toString("base64")}` : null;
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(file, { signature, data });
    return data;
  } catch {
    cache.delete(file);
    return null;
  }
}
