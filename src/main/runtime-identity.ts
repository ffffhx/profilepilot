import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function readControlBuild(directory = __dirname): { buildId: string; builtAt: string; cliSha256: string; extensionVersion: string } | null {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, "control-build.json"), "utf8"));
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.buildId) || !/^[a-f0-9]{64}$/.test(value.cliSha256) || typeof value.extensionVersion !== "string") return null;
    return { buildId: value.buildId, builtAt: value.builtAt, cliSha256: value.cliSha256, extensionVersion: value.extensionVersion };
  } catch { return null; }
}

function captureRuntimeIdentity() {
  const build = readControlBuild();
  let entry = process.argv[1] ? path.resolve(process.argv[1]) : __filename;
  try { if (!statSync(entry).isFile()) entry = path.join(__dirname, "entry.js"); } catch { entry = __filename; }
  let entrySha256: string | null = null;
  try { entrySha256 = createHash("sha256").update(readFileSync(entry)).digest("hex"); } catch { /* report unknown, never a guessed version */ }
  return { ...build, entry, entrySha256, runtime: process.execPath, startedAt: new Date().toISOString(), pid: process.pid, platform: process.platform };
}

// Capture once: rebuilding files cannot make an old process claim a new build.
export const RUNNING_CONTROL_BUILD = Object.freeze(captureRuntimeIdentity());
