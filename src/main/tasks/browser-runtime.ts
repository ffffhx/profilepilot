import { existsSync } from "node:fs";
import path from "node:path";

export function browserBinaryName(_platform = process.platform, _arch = process.arch): string {
  return "profilepilot-browser-engine.cjs";
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
  const local = path.join(options.packageRoot || path.resolve(__dirname, __dirname.endsWith("tasks") ? "../.." : ".."), "browser-runtime", binary);
  if (exists(local)) return local;
  throw new Error("应用依赖中的浏览器执行器缺失，请重新安装项目依赖或 ProfilePilot。");
}
