// A per-application supervisor survives desktop navigation and ProfilePilot restarts.
// Its private authenticated pipe identifies the process; stale PIDs are never killed.
import fs from "node:fs";
import net from "node:net";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { atomicJson, idleRuntime, launchCommand, parseEnvironment, type LocalAppLaunch } from "./protocol";

async function main(): Promise<void> {
  const launchPath = process.argv[2];
  const input = JSON.parse(fs.readFileSync(launchPath, "utf8")) as LocalAppLaunch;
  fs.unlinkSync(launchPath);
  const runtime = idleRuntime();
  runtime.status = "starting";
  runtime.startedAt = new Date().toISOString();
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  let finished = false;
  let logBytes = 0;
  const persist = () => atomicJson(input.recordPath, { socket: input.socket, token: input.token, workerPid: process.pid, runtime });
  const log = (text: string) => {
    if (logBytes > 2 * 1024 * 1024) {
      fs.renameSync(input.logPath, `${input.logPath}.previous`);
      logBytes = 0;
    }
    fs.appendFileSync(input.logPath, text, { mode: 0o600 });
    logBytes += Buffer.byteLength(text);
  };
  fs.writeFileSync(input.logPath, "", { mode: 0o600 });
  const server = net.createServer(socket => {
    let buffer = ""; socket.setEncoding("utf8"); socket.setTimeout(3000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 4096) return socket.destroy();
      if (!buffer.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        try {
          const request = JSON.parse(buffer.split("\n")[0]);
          if (request.token !== input.token) throw new Error("应用连接身份不匹配。");
          if (request.action === "stop") { socket.setTimeout(12_000); await stop(); }
          else if (request.action !== "status") throw new Error("未知的应用操作。");
          socket.end(JSON.stringify({ runtime }) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: String(error) }) + "\n"); }
      })();
    });
  });
  function finish(code: number | null, error = ""): void {
    if (finished) return;
    finished = true;
    runtime.status = error || (code !== 0 && !stopping) ? "failed" : "stopped";
    runtime.exitCode = code; runtime.pid = null; runtime.error = error;
    persist(); log(`\n[ProfilePilot] 应用已退出${code === null ? "" : `（退出码 ${code}）`}${error ? `：${error}` : ""}\n`);
    // Give an in-flight stop response time to flush before releasing the socket.
    setTimeout(() => { server.close(); if (process.platform !== "win32") fs.rmSync(input.socket, { force: true }); }, 300);
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!child?.pid || finished) return;
      runtime.status = "stopping"; persist();
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          execFile("taskkill.exe", ["/PID", String(child!.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }, error => {
            if (error && !finished) reject(new Error(`停止应用失败：${error.message}`)); else resolve();
          });
        });
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await new Promise(resolve => setTimeout(resolve, 1200));
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      const deadline = Date.now() + 3000;
      while (!finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!finished) throw new Error("应用仍在退出，请稍后重试。");
    })().catch(error => { stopping = undefined; runtime.status = "running"; persist(); throw error; });
    return stopping;
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.socket, resolve); });
  if (process.platform !== "win32") fs.chmodSync(input.socket, 0o600);
  persist();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Do not leak ProfilePilot's test hooks or app data routing into managed Electron apps.
  for (const key of Object.keys(env)) if (key.startsWith("CPM_") || key.startsWith("PROFILEPILOT_")) delete env[key];
  Object.assign(env, parseEnvironment(input.config.environment));
  env.PROFILEPILOT_CDP_PORT = String(input.config.cdpPort ?? "");
  env.PROFILEPILOT_INSPECT_PORT = String(input.config.inspectPort ?? "");
  const invocation = launchCommand(input.config, process.platform, env);
  child = spawn(invocation.executable, invocation.args, {
    cwd: input.config.cwd, env, windowsHide: true, windowsVerbatimArguments: process.platform === "win32",
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("spawn", () => { runtime.pid = child!.pid!; runtime.status = "running"; persist(); });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    stream?.on("data", chunk => log(decoder.write(chunk)));
    stream?.on("end", () => { const tail = decoder.end(); if (tail) log(tail); });
  }
  child.once("error", error => finish(null, error.message));
  child.once("close", code => finish(code));
}

if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
