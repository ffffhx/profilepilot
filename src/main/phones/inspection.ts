import { deviceShell, type AdbRunner } from "./adb";

export function packageName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(value) || value.length > 255)
    throw new Error("应用包名无效。");
  return value;
}

export function parsePackageDump(name: string, output: string) {
  packageName(name);
  // Dumpsys can include both the installed package and a disabled system copy.
  // Keep the first exact installed package block, not the first version anywhere.
  const escaped = name.replaceAll(".", "\\.");
  const block = output.match(new RegExp(`^([ \\t]*)Package \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^\\1Package \\[|^Hidden system packages:|$(?![\\s\\S]))`, "m"))?.[2];
  const text = block || "";
  return {
    versionCode: text.match(/^\s*versionCode=(\d+)\b/m)?.[1] ?? null,
    versionName: text.match(/^\s*versionName=(.*)$/m)?.[1]?.trim() ?? null,
    firstInstallTime: text.match(/^\s*firstInstallTime=(.*)$/m)?.[1]?.trim() ?? null,
    lastUpdateTime: text.match(/^\s*lastUpdateTime=(.*)$/m)?.[1]?.trim() ?? null,
    installerPackageName: text.match(/^\s*installerPackageName=(.*)$/m)?.[1]?.trim() ?? null,
    parsed: !!block
  };
}

export class PhoneInspection {
  constructor(private adb: AdbRunner) {}
  private shell(id: string, args: string[], signal?: AbortSignal) {
    return this.adb.run(["-s", id, "shell", deviceShell(args)], 12000, undefined, signal);
  }
  async app(id: string, name: string, signal?: AbortSignal) {
    packageName(name);
    const pathsOutput = await this.shell(id, ["pm", "path", name], signal);
    const lines = pathsOutput.split(/\r?\n/).filter(line => line.trim());
    const paths = lines.filter(line => line.startsWith("package:/")).map(line => line.slice(8));
    if (lines.some(line => !line.startsWith("package:/")))
      throw new Error("无法确认应用安装状态：" + pathsOutput.slice(0, 1000));
    if (!paths.length) return { id, packageName: name, status: "missing" as const, checkedAt: Date.now(), paths, versionCode: null, versionName: null, evidence: { paths: pathsOutput, package: "" } };
    const dump = await this.shell(id, ["dumpsys", "package", name], signal);
    const version = parsePackageDump(name, dump);
    return { id, packageName: name, status: "installed" as const, checkedAt: Date.now(), paths, ...version,
      evidence: { paths: pathsOutput, package: dump } };
  }
  async packages(id: string, scope: "all" | "user" | "system" = "all", filter = "", signal?: AbortSignal) {
    if (filter.length > 255 || /[\x00-\x1f]/.test(filter)) throw new Error("应用筛选文本无效。");
    const output = await this.shell(id, ["pm", "list", "packages", "-f", ...(scope === "user" ? ["-3"] : scope === "system" ? ["-s"] : [])], signal);
    const unparsed: string[] = [];
    const packages = output.split(/\r?\n/).filter(Boolean).flatMap(line => {
      // APK paths may contain '='; the package name is the final field.
      const match = line.match(/^package:(\/.*)=([A-Za-z][\w.]*)$/);
      if (!match) { unparsed.push(line); return []; }
      return match[2].toLowerCase().includes(filter.toLowerCase()) ? [{ packageName: match[2], apkPath: match[1] }] : [];
    });
    return { id, checkedAt: Date.now(), scope, filter, packages, coverage: unparsed.length ? "partial" : "complete", unparsed, evidence: output };
  }
  async diagnose(id: string, signal?: AbortSignal) {
    const commands: Record<string, string[]> = {
      properties: ["getprop"], displaySize: ["wm", "size"], displayDensity: ["wm", "density"],
      features: ["pm", "list", "features"], services: ["service", "list"], processes: ["ps", "-A"],
      window: ["dumpsys", "window", "windows"]
    };
    const evidence: Record<string, string> = {}, errors: Record<string, string> = {};
    // Fixed bounded queries; no App installation, launch, permission grant or session start.
    await Promise.all(Object.entries(commands).map(async ([key, args]) => {
      signal?.throwIfAborted();
      try { evidence[key] = await this.shell(id, args, signal); }
      catch (error) { signal?.throwIfAborted(); errors[key] = (error as Error).message; }
    }));
    const properties = Object.fromEntries((evidence.properties || "").split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\[([^\]]+)\]: \[(.*)\]$/); return match ? [[match[1], match[2]]] : [];
    }));
    return { id, checkedAt: Date.now(), properties, coverage: Object.keys(errors).length ? "partial" : "complete", evidence, errors };
  }
}
