import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface ValidatedUnpackedExtension {
  path: string;
  manifestPath: string;
  name: string;
  version?: string;
  manifestVersion: 2 | 3;
}

export function validateUnpackedExtensionPath(input: string): ValidatedUnpackedExtension {
  const requestedPath = typeof input === "string" ? input.trim() : "";
  if (!requestedPath) {
    throw extensionPathError("EXTENSION_PATH_REQUIRED", "请提供未打包扩展目录的绝对路径");
  }
  if (!path.isAbsolute(requestedPath)) {
    throw extensionPathError("EXTENSION_PATH_MUST_BE_ABSOLUTE", "未打包扩展目录必须使用绝对路径");
  }

  let extensionPath: string;
  try {
    extensionPath = realpathSync(requestedPath);
  } catch {
    throw extensionPathError("EXTENSION_PATH_NOT_FOUND", `未打包扩展目录不存在：${requestedPath}`);
  }

  let directoryStat;
  try {
    directoryStat = statSync(extensionPath);
  } catch {
    throw extensionPathError("EXTENSION_PATH_NOT_FOUND", `未打包扩展目录不存在：${extensionPath}`);
  }
  if (!directoryStat.isDirectory()) {
    throw extensionPathError("EXTENSION_PATH_NOT_DIRECTORY", `未打包扩展路径不是目录：${extensionPath}`);
  }

  const manifestPath = path.join(extensionPath, "manifest.json");
  let manifestStat;
  try {
    manifestStat = statSync(manifestPath);
  } catch {
    throw extensionPathError("EXTENSION_MANIFEST_NOT_FOUND", `扩展目录缺少 manifest.json：${extensionPath}`);
  }
  if (!manifestStat.isFile() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw extensionPathError("EXTENSION_MANIFEST_INVALID", "manifest.json 必须是小于 1MB 的非空文件");
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be an object");
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw extensionPathError("EXTENSION_MANIFEST_INVALID", `manifest.json 不是合法 JSON：${manifestPath}`);
  }

  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  const manifestVersion = Number(manifest.manifest_version);
  if (!name || (manifestVersion !== 2 && manifestVersion !== 3)) {
    throw extensionPathError(
      "EXTENSION_MANIFEST_INVALID",
      "manifest.json 必须包含 name，且 manifest_version 必须为 2 或 3"
    );
  }

  return {
    path: extensionPath,
    manifestPath,
    name,
    version: version || undefined,
    manifestVersion
  };
}

function extensionPathError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
