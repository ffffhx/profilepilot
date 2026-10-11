import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import type { AndroidLicense, AndroidSystemImage } from "../../shared/android-setup";

export const ANDROID_REPOSITORY = "https://dl.google.com/android/repository/";
// A fixed tool version keeps the Java entry points stable across installations.
export const COMMAND_TOOLS_VERSION = "19.0";
export interface AndroidArchive { url: string; bytes: number; checksum: string; algorithm: "sha1" | "sha256"; }
export interface AndroidCatalog {
  tools: AndroidArchive;
  images: AndroidSystemImage[];
  licenses: AndroidLicense[];
  licenseToken: string;
}
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function repository(xml: string): any {
  if (xml.length > 12 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Android 组件目录格式无效。");
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml);
  const repo = Object.values(parsed).find((value: any) => value?.remotePackage);
  if (!repo) throw new Error("未能读取 Android 组件目录，请重试。");
  return repo;
}
export function androidHost(platform: string, arch: string): { os: string; abi: string; label: string } {
  if (platform === "win32" && arch === "x64") return { os: "windows", abi: "x86_64", label: "Windows · Intel / AMD" };
  if (platform === "darwin" && arch === "arm64") return { os: "macosx", abi: "arm64-v8a", label: "macOS · Apple 芯片" };
  if (platform === "darwin" && arch === "x64") return { os: "macosx", abi: "x86_64", label: "macOS · Intel" };
  if (platform === "linux" && arch === "x64") return { os: "linux", abi: "x86_64", label: "Linux · Intel / AMD" };
  throw new Error("这台电脑的系统或处理器暂不支持自动安装 Android 模拟器。");
}
export function parseAndroidCatalog(baseXml: string, imageXml: string, platform: string, arch: string): AndroidCatalog {
  const host = androidHost(platform, arch), base = repository(baseXml), imagesRepo = repository(imageXml);
  const packages = array<any>(base.remotePackage);
  const tools = packages.find(p => p["@_path"] === `cmdline-tools;${COMMAND_TOOLS_VERSION}`);
  const complete = array<any>(tools?.archives?.archive).find(a => a["host-os"] === host.os)?.complete;
  const url = new URL(complete?.url || "", ANDROID_REPOSITORY);
  const checksum = String(complete?.checksum?.["#text"] || ""), algorithm = complete?.checksum?.["@_type"];
  if (!complete || url.origin !== "https://dl.google.com" || !url.pathname.startsWith("/android/repository/") || !["sha1", "sha256"].includes(algorithm) || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(checksum) || !Number(complete.size)) throw new Error("Android 安装包信息不完整，请稍后重试。");
  const imagePackages = array<any>(imagesRepo.remotePackage).filter(p => {
    const match = String(p["@_path"]).match(/^system-images;android-(\d+);google_apis;(x86_64|arm64-v8a)$/);
    return match && Number(match[1]) >= 30 && match[2] === host.abi && (!p.channelRef || p.channelRef["@_ref"] === "channel-0") && !p.obsolete;
  });
  const versions: Record<number, string> = { 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17" };
  const images: AndroidSystemImage[] = imagePackages.map(p => {
    const api = Number(p["type-details"]["api-level"]);
    return { id: p["@_path"], api, abi: host.abi, label: `Android ${versions[api] || `API ${api}`} · Google APIs`, bytes: Number(array<any>(p.archives?.archive)[0]?.complete?.size || 0), installed: false };
  }).sort((a, b) => b.api - a.api);
  const needed = new Set([tools, ...packages.filter(p => ["emulator", "platform-tools"].includes(p["@_path"]) && (!p.channelRef || p.channelRef["@_ref"] === "channel-0")), ...imagePackages].map(p => p?.["uses-license"]?.["@_ref"]).filter(Boolean));
  const licenses = [...new Map([...array<any>(base.license), ...array<any>(imagesRepo.license)].filter(l => needed.has(l["@_id"])).map(l => [l["@_id"], { id: l["@_id"], text: String(l["#text"] || "") }])).values()];
  if (!licenses.length || licenses.some(l => !l.text) || [...needed].some(id => !licenses.some(l => l.id === id))) throw new Error("无法读取 Android 许可协议，请刷新组件目录。");
  return { tools: { url: url.href, bytes: Number(complete.size), checksum, algorithm }, images, licenses, licenseToken: createHash("sha256").update(JSON.stringify(licenses)).digest("hex") };
}
