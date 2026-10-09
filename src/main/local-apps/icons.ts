import fs from "node:fs/promises";
import path from "node:path";
import type { LocalAppConfig } from "../../shared/local-apps";

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const imageExtensions = [".png", ".svg", ".ico", ".icns", ".jpg", ".webp"];
const normalizeName = (name: string) => name.replace(/[\s._-]/g, "").toLowerCase();
type ReadIcon = (file: string) => Promise<string | undefined>;
type PackageMetadata = {
  icon?: unknown;
  build?: { icon?: unknown; win?: { icon?: unknown }; mac?: { icon?: unknown }; linux?: { icon?: unknown }; directories?: { buildResources?: unknown } };
  config?: { forge?: { packagerConfig?: { icon?: unknown } } };
};

async function readPackage(directory: string): Promise<PackageMetadata> {
  try {
    const file = path.join(directory, "package.json");
    if ((await fs.stat(file)).size > MAX_ICON_BYTES) return {};
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

// Modern ICNS files contain PNG representations. Decode the largest available
// representation without relying on Windows being able to load macOS icons.
export function icnsPng(buffer: Buffer): Buffer | undefined {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== "icns" || buffer.readUInt32BE(4) !== buffer.length) return;
  let best: Buffer | undefined;
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) return;
    const chunk = buffer.subarray(offset + 8, offset + length);
    if (chunk.length >= 24 && chunk.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && (!best || chunk.readUInt32BE(16) > best.readUInt32BE(16))) best = chunk;
    offset += length;
  }
  return best;
}

// Discover only explicit metadata and conventional app assets, never scan dependencies
// or execute a project's build configuration just to display its icon.
export async function localAppIconCandidates(config: LocalAppConfig, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const candidates = new Set<string>();
  const add = (file: unknown, base = config.cwd) => {
    if (typeof file === "string" && file && (base || path.isAbsolute(file))) candidates.add(path.resolve(base, file));
  };
  const addImage = (file: unknown) => {
    if (typeof file !== "string" || !file) return;
    const ext = path.extname(file).toLowerCase();
    if (ext === ".icns" || ext === ".ico") add(file.slice(0, -ext.length) + ".png");
    if (ext) add(file);
    else for (const suffix of imageExtensions) add(file + suffix);
  };
  if (config.cwd) {
    const pkg = await readPackage(config.cwd);
    const build = pkg.build;
    const platformBuild = build?.[platform === "win32" ? "win" : platform === "darwin" ? "mac" : "linux"];
    addImage(platformBuild?.icon);
    addImage(build?.icon);
    addImage(pkg.icon);
    addImage(pkg.config?.forge?.packagerConfig?.icon);
    const resourceDir = typeof build?.directories?.buildResources === "string" ? build.directories.buildResources : "build";
    for (const directory of [resourceDir, "desktop", "resources", "assets", "public", "public/assets", "", "resources/app.asar.unpacked/resources", "Contents/Resources"]) {
      for (const name of ["icon", "app-icon", "logo", "favicon"]) {
        for (const ext of imageExtensions) add(path.join(directory, name + ext));
      }
    }
    try {
      const names = new Set([config.name, path.basename(config.cwd), config.serviceProcess ? path.parse(config.serviceProcess).name : ""].filter(Boolean).map(normalizeName));
      for (const entry of await fs.readdir(config.cwd, { withFileTypes: true })) {
        if (entry.isFile() && imageExtensions.includes(path.extname(entry.name).toLowerCase()) && names.has(normalizeName(path.parse(entry.name).name))) add(entry.name);
      }
    } catch { /* The project may have been moved or removed. */ }
  }
  // Use the real executable/bundle when available, excluding generic runtimes.
  // Quoted paths may contain spaces; commands are inspected as text, never run.
  const commandPaths = [...config.command.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';&|]+)/g)]
    .map(match => match[1] || match[2] || match[3]);
  for (const file of [config.serviceProcess, config.cwd, ...commandPaths]) {
    if (!file) continue;
    if (platform === "darwin") {
      const bundle = file.match(/^(.+?\.app)(?:\/|$)/i)?.[1];
      if (bundle && path.basename(bundle).toLowerCase() !== "electron.app") add(bundle);
    } else if (platform === "win32" && /\.exe$/i.test(file) && !/^(electron|node|cmd|powershell|pwsh|uninstall.*)\.exe$/i.test(path.basename(file))) add(file);
  }
  if (config.cwd && platform === "win32") {
    // Installed applications often launch through a script. Match the app's name
    // rather than borrowing an unrelated helper executable's icon.
    try {
      for (const entry of await fs.readdir(config.cwd, { withFileTypes: true })) {
        if (entry.isFile() && /\.exe$/i.test(entry.name) && normalizeName(entry.name.slice(0, -4)) === normalizeName(config.name)) add(entry.name);
      }
    } catch { /* Missing/inaccessible directories keep the default icon. */ }
  }
  return [...candidates];
}

export function createLocalAppIconResolver(readIcon: ReadIcon, platform: NodeJS.Platform = process.platform) {
  const cache = new Map<string, { key: string; expires: number; value: Promise<string | undefined> }>();
  return (config: LocalAppConfig): Promise<string | undefined> => {
    const key = JSON.stringify([config.cwd, config.command, config.serviceProcess, config.name]);
    const previous = cache.get(config.id);
    if (previous?.key === key && previous.expires > Date.now()) return previous.value;
    const value = (async () => {
      for (const file of await localAppIconCandidates(config, platform)) {
        try {
          const stat = await fs.stat(file);
          const ext = path.extname(file).toLowerCase();
          if (ext === ".app" ? !stat.isDirectory() : !stat.isFile()) continue;
          if (ext !== ".exe" && ext !== ".app" && stat.size > MAX_ICON_BYTES) continue;
          const icon = await readIcon(file);
          if (icon) return icon;
        } catch { /* A missing or invalid candidate must not break the app list. */ }
      }
      return undefined;
    })().catch(() => undefined);
    cache.set(config.id, { key, expires: Date.now() + 60_000, value });
    return value;
  };
}
