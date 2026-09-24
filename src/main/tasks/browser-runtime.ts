import { existsSync } from "node:fs";
import path from "node:path";

export function browserBinaryName(platform = process.platform, arch = process.arch): string {
  const target = platform === "win32" && arch === "arm64" ? "x64" : arch;
  if (!["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(target)) throw new Error("当前系统暂不支持内置浏览器执行器。");
  return `agent-browser-${platform}-${target}${platform === "win32" ? ".exe" : ""}`;
}

// The task runtime is private to the application. Never discover a user's CLI
// on PATH or inherit its version/configuration to run product tasks.
export function bundledBrowserExecutable(options: { resourcesPath?: string; packageRoot?: string; platform?: NodeJS.Platform; arch?: string; exists?: (file: string) => boolean } = {}): string {
  const binary = browserBinaryName(options.platform, options.arch as NodeJS.Architecture | undefined);
  const exists = options.exists || existsSync;
  const resources = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const packaged = path.join(resources, "browser-runtime", binary);
    if (exists(packaged)) return packaged;
    if (exists(path.join(resources, "app.asar"))) throw new Error("安装包缺少内置浏览器执行器，请重新安装 ProfilePilot。");
  }
  const local = path.join(options.packageRoot || path.dirname(require.resolve("agent-browser/package.json")), "bin", binary);
  if (exists(local)) return local;
  throw new Error("应用依赖中的浏览器执行器缺失，请重新安装项目依赖或 ProfilePilot。");
}
