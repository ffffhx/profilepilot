import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { main as launch, runningProfilePilot, developmentProcess } from './start-independent.mjs';
import { fileURLToPath } from 'node:url';
import runtime from './development-runtime.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function build() {
  const child = spawn(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['-c', 'npm run build'], {cwd:root,env:runtime.buildEnvironment(),stdio:'inherit',windowsHide:true});
  const code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve); });
  if (code !== 0) throw new Error(`Development build failed (${code}); the running app was left unchanged.`);
}
const existingPid = runningProfilePilot(root);
if (existingPid) {
  if (!developmentProcess(root, existingPid) || process.argv.includes('--restart')) {
    if (!process.argv.includes('--restart')) throw new Error(`ProfilePilot (${existingPid}) 正在运行，但没有开启源码监听。运行 npm run dev -- --restart 可通过 CLI 正常重启为开发版。`);
    await build();
    const stopped = spawnSync(process.execPath, [path.join(root, 'dist/main/profilepilot-cli.cjs'), 'app', 'quit', '--json'], {encoding:'utf8',windowsHide:true,timeout:10000});
    if (stopped.status !== 0) throw new Error(`当前进程未接受正常退出请求。旧版本首次切换需要从菜单退出一次。${stopped.stderr || stopped.stdout || ''}`);
    const deadline = Date.now() + 30000;
    let alive = true;
    while (Date.now() < deadline) {
      try { process.kill(existingPid, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (alive) throw new Error('应用尚未完成退出，未强制结束进程。请检查当前状态后再启动。');
    process.env.PROFILEPILOT_DEV_WATCH = '1';
    await launch({requireDevelopment:true});
  } else {
  await launch({requireDevelopment: true});
  }
} else {
await build();
process.env.PROFILEPILOT_DEV_WATCH = '1';
await launch({requireDevelopment: true});
}
