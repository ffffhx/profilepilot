import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./build.mjs";
const script = path.join(root, "scripts/preview.mjs");
await mkdir(path.join(root, "artifacts"), { recursive: true });
try {
  const live = await fetch("http://127.0.0.1:43821/health", { signal: AbortSignal.timeout(1500) }).then(r => r.json());
  if (live.app === "bilingual-reader-preview") { console.log(JSON.stringify({ ...live, url: "http://127.0.0.1:43821", existing: true })); process.exit(0); }
  throw new Error("Preview port is occupied by another service.");
} catch (error) { if (error.message.includes("occupied")) throw error; }
if (process.platform === "win32") {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const ps = `$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$launch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quote('"' + process.execPath + '" "' + script + '"')}; CurrentDirectory = ${quote(root)}; ProcessStartupInformation = $startup }
if ($launch.ReturnValue -ne 0) { throw "Independent preview launch failed" }
$launch.ProcessId`;
  const launch = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
  if (launch.status !== 0) throw new Error(launch.stderr || launch.stdout);
} else {
  const child = spawn(process.execPath, [script], { cwd: root, detached: true, stdio: "ignore" }); child.unref();
}
let info;
for (let i = 0; i < 40; i++) {
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    info = await fetch("http://127.0.0.1:43821/health", { signal: AbortSignal.timeout(700) }).then(r => r.json());
    if (info.app === "bilingual-reader-preview") break;
  } catch {}
}
if (!info?.pid) throw new Error("Preview did not start.");
await new Promise(resolve => setTimeout(resolve, 2000));
process.kill(info.pid, 0);
console.log(await readFile(path.join(root, "artifacts/preview.json"), "utf8"));
