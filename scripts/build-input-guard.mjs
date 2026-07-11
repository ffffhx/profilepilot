import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "dist", "native");
const output = path.join(outputDir, "profilepilot-input-guard");
const companionName = "ProfilePilot Input Guard.app";
const executableName = "ProfilePilot Input Guard";
const companion = path.join(outputDir, companionName);
const companionContents = path.join(companion, "Contents");
const companionExecutable = path.join(companionContents, "MacOS", executableName);
const companionResources = path.join(companionContents, "Resources");
const buildInfoPath = path.join(companionResources, "input-guard-build.json");
const sourcePath = path.join(root, "native", "input-guard.c");
const bundleIdentifier = "io.github.ffffhx.profilepilot.input-guard";
const signingIdentityName = "ProfilePilot Input Guard Local Signing";
const compilerArgs = [
  sourcePath,
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-mmacosx-version-min=12.0",
  "-arch",
  "arm64",
  "-arch",
  "x86_64",
  "-framework",
  "ApplicationServices",
  "-framework",
  "CoreFoundation"
];

await mkdir(outputDir, { recursive: true });

if (process.platform !== "darwin") {
  await rm(output, { force: true });
  await rm(companion, { recursive: true, force: true });
  process.exit(0);
}

const source = await readFile(sourcePath);
const signingIdentity = await resolveSigningIdentity();
const buildId = createHash("sha256")
  .update("profilepilot-input-guard-bundle-v2\0")
  .update(source)
  .update("\0")
  .update(JSON.stringify(compilerArgs))
  .update("\0")
  .update(signingIdentity?.fingerprint || "ad-hoc")
  .digest("hex");

let existingBuildId = "";
try {
  existingBuildId = JSON.parse(await readFile(buildInfoPath, "utf8")).buildId || "";
} catch {
  // A missing or partial companion is rebuilt below.
}

if (existingBuildId === buildId) {
  try {
    await copyFile(companionExecutable, output);
    await chmod(output, 0o755);
    process.exit(0);
  } catch {
    // Rebuild a partial cache entry.
  }
}

await rm(output, { force: true });
await rm(companion, { recursive: true, force: true });
await execFileAsync("xcrun", ["clang", ...compilerArgs, "-o", output], {
  cwd: root,
  maxBuffer: 1024 * 1024
});

await mkdir(path.dirname(companionExecutable), { recursive: true });
await mkdir(companionResources, { recursive: true });
await copyFile(output, companionExecutable);
await chmod(companionExecutable, 0o755);
await writeFile(
  path.join(companionContents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>ProfilePilot Input Guard</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>ProfilePilot Input Guard</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
`,
  "utf8"
);
await writeFile(buildInfoPath, `${JSON.stringify({ buildId }, null, 2)}\n`, "utf8");
const codesignArgs = [
  "--force",
  "--timestamp=none",
  "--sign",
  signingIdentity?.fingerprint || "-",
  "--identifier",
  bundleIdentifier,
  companion
];
if (!signingIdentity) {
  await execFileAsync("codesign", codesignArgs, { cwd: root, maxBuffer: 1024 * 1024 });
} else {
  codesignArgs.splice(codesignArgs.length - 1, 0, "--keychain", signingIdentity.keychainPath);
  await withTemporaryKeychainSearchPath(signingIdentity.keychainPath, () =>
    execFileAsync("codesign", codesignArgs, { cwd: root, maxBuffer: 1024 * 1024 })
  );
}

async function resolveSigningIdentity() {
  const signingDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "ProfilePilot",
    "CodeSigning"
  );
  const keychainPath = path.join(signingDir, "input-guard-signing.keychain-db");
  const passwordPath = path.join(signingDir, "keychain-password");
  try {
    const password = (await readFile(passwordPath, "utf8")).trim();
    await execFileAsync("security", ["unlock-keychain", "-p", password, keychainPath]);
    const { stdout } = await execFileAsync("security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      keychainPath
    ]);
    const escapedName = signingIdentityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = stdout.match(new RegExp(`([0-9A-F]{40}) \\"${escapedName}\\"`));
    return match ? { fingerprint: match[1], keychainPath } : null;
  } catch {
    // Distribution and CI builds can still use an ad-hoc signature. The
    // dedicated local identity is an opt-in development setup.
    return null;
  }
}

async function withTemporaryKeychainSearchPath(keychainPath, action) {
  const { stdout } = await execFileAsync("security", ["list-keychains", "-d", "user"]);
  const original = [...stdout.matchAll(/\"([^\"]+)\"/g)].map((match) => match[1]);
  if (original.includes(keychainPath)) {
    return action();
  }
  await execFileAsync("security", ["list-keychains", "-d", "user", "-s", ...original, keychainPath]);
  try {
    return await action();
  } finally {
    await execFileAsync("security", ["list-keychains", "-d", "user", "-s", ...original]);
  }
}
