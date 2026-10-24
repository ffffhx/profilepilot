import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const pluginRoot = path.join(repositoryRoot, "plugins", "profilepilot");

// Explicit inputs prevent local preferences, credentials, and device artifacts
// from entering either the Git marketplace or the uploaded ZIP.
const generatedSources = {
  "assets/icon.svg": "public/assets/profilepilot-mark.svg",
  "LICENSE": "LICENSE",
  ...Object.fromEntries([
    "browser-extension.md", "agent-browser.md", "profiles.md", "phone.md", "phone-adb.md", "captcha.md", "site-adapters.md"
  ].map(name => [`skills/profilepilot/references/${name}`, `skills/profilepilot/references/${name}`]))
};
export const packageFiles = [
  "plugin.json", "skills/profilepilot/SKILL.md", "skills/setup/SKILL.md",
  ...Object.keys(generatedSources)
].sort();

function normalizedText(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
}

async function regularFile(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === "..")) {
    throw new Error(`Unsafe package path: ${relative}`);
  }
  let current = root;
  for (const part of ["", ...relative.split("/")]) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not publishable: ${current}`);
  }
  if (!(await lstat(current)).isFile()) throw new Error(`Not a regular file: ${current}`);
  return current;
}

async function fileInventory(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not publishable: ${name}`);
    if (entry.isDirectory()) result.push(...await fileInventory(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported package entry: ${name}`);
  }
  return result.sort();
}

export async function syncGeneratedFiles({ check = false } = {}) {
  for (const [destination, source] of Object.entries(generatedSources)) {
    const expected = normalizedText(await readFile(await regularFile(repositoryRoot, source)));
    const target = path.join(pluginRoot, destination);
    if (check) {
      const actual = normalizedText(await readFile(await regularFile(pluginRoot, destination)));
      if (!actual.equals(expected)) throw new Error(`${destination} is stale. Run npm run plugin:sync.`);
    } else {
      // Check existing ancestors before creating directories or overwriting.
      let parent = pluginRoot;
      for (const part of ["", ...destination.split("/").slice(0, -1)]) {
        parent = path.join(parent, part);
        await mkdir(parent, { recursive: true });
        if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Refusing symlink: ${parent}`);
      }
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing symlink: ${target}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await writeFile(target, expected);
    }
  }
}

export async function collectPluginFiles(root = pluginRoot) {
  const inventory = await fileInventory(root);
  if (JSON.stringify(inventory) !== JSON.stringify(packageFiles)) {
    const unexpected = inventory.filter(name => !packageFiles.includes(name));
    const missing = packageFiles.filter(name => !inventory.includes(name));
    throw new Error(`Package inventory mismatch; unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
  }
  const files = new Map();
  for (const name of packageFiles) files.set(name, normalizedText(await readFile(await regularFile(root, name))));
  const manifest = JSON.parse(files.get("plugin.json"));
  if (manifest.name !== "profilepilot" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid plugin identity/version");
  const extension = manifest.extensions?.["com.openai"];
  if (extension?.requires_local_executor !== true) throw new Error("ProfilePilot requires local execution");
  if (manifest.mcpServers || extension.apps || extension.hooks) throw new Error("The published package is skills-only and contains no hooks or app references");
  const listing = extension.interface;
  for (const [field, limit] of Object.entries({ displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80, category: 120 })) {
    if (typeof listing?.[field] !== "string" || !listing[field].trim() || [...listing[field]].length > limit) throw new Error(`Invalid listing field: ${field}`);
  }
  for (const target of [extension.onboardingSkill, listing.composerIcon, listing.logo]) {
    if (!target?.startsWith("./") || !files.has(target.slice(2))) throw new Error(`Missing package resource: ${target}`);
  }
  for (const [name, bytes] of files) {
    if (!name.endsWith(".md")) continue;
    const content = bytes.toString("utf8");
    if (name.endsWith("SKILL.md") && !/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/.test(content)) throw new Error(`Invalid skill frontmatter: ${name}`);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^(https?:|#)/.test(link)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link.split("#")[0]));
      if (!files.has(target)) throw new Error(`Broken bundled reference: ${name} -> ${link}`);
    }
  }
  return { manifest, files };
}

// A small deterministic ZIP writer using Node's built-in CRC and deflate.
// UTF-8 names, fixed 1980-01-01 timestamps, and sorted inputs work on both OSes.
export function createPluginZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    local.copy(header, 6, 4, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

async function main() {
  const mode = process.argv[2] || "--pack";
  if (!["--sync", "--check", "--pack"].includes(mode) || process.argv.length > 3) throw new Error("Usage: node scripts/package-codex-plugin.mjs [--sync|--check|--pack]");
  await syncGeneratedFiles({ check: mode !== "--sync" });
  const { manifest, files } = await collectPluginFiles();
  if (mode !== "--pack") {
    console.log(`${manifest.name}@${manifest.version}: ${files.size} files ${mode === "--sync" ? "synchronized and validated" : "validated"}`);
    return;
  }
  const zip = createPluginZip(files);
  const output = path.join(repositoryRoot, "dist", "plugins", `${manifest.name}-${manifest.version}.zip`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, zip);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  await writeFile(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`);
  console.log(JSON.stringify({ plugin: manifest.name, version: manifest.version, files: files.size, bytes: zip.length, sha256, output }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
