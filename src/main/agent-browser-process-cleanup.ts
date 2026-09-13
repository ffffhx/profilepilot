import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {windowsPowerShellExecutable} from './windows-platform';
export interface DriverProcess {pid:number; parentPid:number; command:string}
export function driverProcessSnapshot(): DriverProcess[] {
  if(process.platform==='win32') {
    const raw=execFileSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:8*1024*1024});
    const rows=JSON.parse(raw);return (Array.isArray(rows)?rows:[rows]).map(r=>({pid:r.ProcessId,parentPid:r.ParentProcessId,command:r.CommandLine||''}));
  }
  return execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024}).split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return m?[{pid:Number(m[1]),parentPid:Number(m[2]),command:m[3]}]:[]});
}
export function isDriverProcess(p:DriverProcess):boolean {
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
export function retiredPortOwner(port:number):number|undefined {
  if(process.platform!=='win32'||!Number.isInteger(port)||port<1||port>65535)return;
  const output=execFileSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',`Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`],{encoding:'utf8',windowsHide:true,timeout:8000});
  const owner=Number(output.trim());return Number.isInteger(owner)&&owner>0?owner:undefined;
}
