import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {windowsPowerShellExecutable} from './windows-platform';

export interface DriverProcess {pid:number; parentPid:number; command:string}

export function isRecordedPidAlive(pid: number | undefined | null): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function readRecordedSessionDaemonPid(agentBrowserDir: string, session: string): { pid?: number; alive: boolean } {
  const candidates: number[] = [];
  try {
    const pidText = readFileSync(path.join(agentBrowserDir, `${session}.pid`), 'utf8').trim();
    const pid = Number(pidText);
    if (Number.isSafeInteger(pid) && pid > 0) candidates.push(pid);
  } catch { /* No .pid file */ }
  try {
    const engineRaw = JSON.parse(readFileSync(path.join(agentBrowserDir, `${session}.engine.json`), 'utf8')) as { pid?: unknown };
    const enginePid = Number(engineRaw?.pid);
    if (Number.isSafeInteger(enginePid) && enginePid > 0 && !candidates.includes(enginePid)) {
      candidates.push(enginePid);
    }
  } catch { /* No .engine.json file */ }
  for (const pid of candidates) {
    if (isRecordedPidAlive(pid)) return { pid, alive: true };
  }
  return { pid: candidates[0], alive: false };
}

export function driverProcessSnapshot(targetPid?: number): DriverProcess[] {
  if (targetPid !== undefined) {
    if (!isRecordedPidAlive(targetPid)) return [];
  }
  if (process.platform === 'win32') {
    const filterClause = targetPid !== undefined && Number.isSafeInteger(targetPid) && targetPid > 0
      ? ` -Filter "ProcessId = ${targetPid} OR ParentProcessId = ${targetPid}"`
      : '';
    const raw = execFileSync(
      windowsPowerShellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process${filterClause} | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`],
      {encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024}
    );
    if (!raw || !raw.trim()) return [];
    const rows = JSON.parse(raw);
    return (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(r => ({
      pid: r.ProcessId,
      parentPid: r.ParentProcessId,
      command: r.CommandLine || ''
    }));
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024})
    .split('\n')
    .flatMap(line => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return m ? [{pid: Number(m[1]), parentPid: Number(m[2]), command: m[3]}] : [];
    });
}
export function isDriverProcess(p:DriverProcess):boolean {
  // Only the exact Node/Electron service entry is eligible for termination.
  // A shell or editor mentioning its filename is not an engine process.
  if (/^(?:"[^"\r\n]*[\\/](?:node|electron|ProfilePilot)(?:\.exe)?"|(?:[^\s"\r\n]*[\\/])?(?:node|electron|ProfilePilot)(?:\.exe)?)\s+(?:"[^"\r\n]*[\\/]profilepilot-browser-engine\.cjs"|[^\s"\r\n]*[\\/]profilepilot-browser-engine\.cjs)\s+--engine-service(?:\s|$)/i.test(p.command)) return true;
  // Match the executable, not a command mentioning agent-browser in its arguments.
  return /^(?:"[^"\r\n]*[\\/])?agent-browser(?:-win32-(?:x64|arm64))?(?:\.exe)?(?:"|\s|$)/i.test(p.command) || /^(?:[^\s"\r\n]*[\\/])agent-browser(?:\s|$)/i.test(p.command);
}
export function temporaryBrowserChildren(rows:DriverProcess[], parentPid:number, tempDir=os.tmpdir()):DriverProcess[] {
  const parent=rows.find(p=>p.pid===parentPid);
  if(parent&&!isDriverProcess(parent))return [];
  return rows.filter(p=>{
    if(p.parentPid!==parentPid||!/(?:^|\s)--headless(?:=new)?(?:\s|$)/.test(p.command)||p.command.includes('--remote-debugging-pipe'))return false;
    const match=p.command.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/);
    if(!match)return false;
    const dir=match[1]||match[2];
    const paths=dir.includes('\\')?path.win32:path.posix;
    return paths.dirname(dir).toLowerCase()===tempDir.replace(/[\\/]$/,'').toLowerCase()&&/^agent-browser-chrome-[a-f0-9-]+$/i.test(paths.basename(dir))&&/chrome(?:\.exe)?"?\s/i.test(p.command);
  });
}
export function retiredPortOwner(port:number, recordedPid?: number):number|undefined {
  if (recordedPid !== undefined && !isRecordedPidAlive(recordedPid)) return undefined;
  if(process.platform!=='win32'||!Number.isInteger(port)||port<1||port>65535)return;
  const output=execFileSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',`Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`],{encoding:'utf8',windowsHide:true,timeout:8000});
  const owner=Number(output.trim());return Number.isInteger(owner)&&owner>0?owner:undefined;
}
