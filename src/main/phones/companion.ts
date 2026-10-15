import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

const RELEASE_PACKAGE = "io.github.profilepilot.phone";
const metadataSchema = z.object({ schemaVersion: z.literal(1), variant: z.enum(["debug", "release"]),
  applicationId: z.string(), versionCode: z.number().int().positive(), versionName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) });

export function readCompanion(apkPath: string) {
  const file = `${apkPath}.json`;
  // Older distributed desktop packages contain the release APK without metadata.
  const metadata = fs.existsSync(file) ? metadataSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : undefined;
  const debug = metadata?.variant === "debug";
  const packageName = RELEASE_PACKAGE + (debug ? ".debug" : "");
  if (metadata && metadata.applicationId !== packageName) throw new Error("手机安装包与构建信息不匹配，请重新构建。");
  return { packageName, variant: debug ? "debug" as const : "release" as const,
    name: debug ? "ProfilePilot 开发版" : "ProfilePilot 移动版", port: debug ? 18763 : 18761,
    pairingScheme: debug ? "profilepilot-dev" : "profilepilot", sha256: metadata?.sha256,
    mainActivity: `${packageName}/${RELEASE_PACKAGE}.MainActivity`,
    accessibilityService: `${packageName}/${RELEASE_PACKAGE}.PhoneAccessibility` };
}

export function verifyCompanionApk(apkPath: string, apk: Buffer, expectedPackage: string): string {
  const current = readCompanion(apkPath);
  if (current.packageName !== expectedPackage) throw new Error("手机安装包已切换开发版或正式版，请重启电脑端后再连接。");
  const hash = createHash("sha256").update(apk).digest("hex");
  if (current.sha256 && current.sha256 !== hash) throw new Error("手机安装包校验失败，请重新构建后再连接。");
  return hash;
}
