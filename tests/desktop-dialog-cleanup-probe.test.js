const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const harness = import('../scripts/verify-desktop-dialog-cleanup.mjs');
const nonce = 'a'.repeat(32), clientGuid = '121dfac2-3b7b-cd9c-745a-4c9e181e2aee';
const identity = { ok: true, pid: 42, parentPid: 41, startedUtcTicks: '639289103638373285', executable: 'C:\\owned\\Probe.exe', sha256: 'b'.repeat(64), integrityRid: 8192, elevated: false, uiAccess: false };
const expected = { nonce, executable: identity.executable, sha256: identity.sha256 };
const receipt = { nonce, pid: identity.pid, startedUtcTicks: identity.startedUtcTicks, clientGuid };
const ready = { ...receipt, protocol: 'profilepilot.dialog-cleanup-probe', apartment: 'STA', comAttempted: false };
function raw(hresult = -2147467259) {
  return { ...receipt, result: { clientGuid, initializeHresult: 0, createHresult: 0, setClientGuidHresult: 0, clearClientDataHresult: hresult,
    rcwFinalReleaseCount: 0, disposeAttempted: true, disposeReturned: true, rawInterfaceAcquired: true, rawInterfaceReleased: true,
    rcwAcquired: true, rcwReleased: true, comUninitialized: true, showCalled: false, adviseCalled: false, historyAbsenceAsserted: false, failures: [] } };
}
function fake() {
  const calls = []; let alive = false, authorized = false;
  const io = {
    gate: async () => { calls.push('gate'); },
    launch: async () => { calls.push('launch'); alive = true; return { pid: identity.pid }; },
    ready: async () => { calls.push('ready'); return { ...ready }; },
    inspect: async pid => { calls.push('inspect'); assert.equal(pid, identity.pid); return { ...identity }; },
    go: async () => { calls.push('go'); authorized = true; },
    result: async () => { calls.push('result'); assert.equal(authorized, true); return raw(); },
    requestClose: async () => { calls.push('close'); alive = false; },
    closed: async () => { calls.push('closed'); return { ...receipt, reason: 'requested', normalReleaseConfirmed: true, comAttempted: authorized, comFinished: authorized }; },
    wait: async (value, timeout) => { calls.push('wait'); assert.deepEqual(value, identity); assert.equal(timeout, 10000); return { ok: true, originalExited: !alive }; },
    force: async value => { calls.push('force'); assert.deepEqual(value, identity); alive = false; return { ok: true, originalExited: true }; },
    failure: async () => null
  };
  return { io, calls, get alive() { return alive; } };
}

test('no-Show options default to compile only and prohibit arbitrary GUID/report or retries', async () => {
  const { cleanupProbeOptions } = await harness;
  assert.deepEqual(cleanupProbeOptions([]), { run: false }); assert.deepEqual(cleanupProbeOptions(['--check']), { run: false });
  assert.deepEqual(cleanupProbeOptions(['--run']), { run: true });
  for (const args of [['--run', '--run'], ['--check', '--run'], ['--guid', clientGuid], ['--report', 'other'], ['--retry'], ['--show']]) assert.throws(() => cleanupProbeOptions(args));
});
test('source authorization rejects unknown bytes without relying on retained local evidence', async () => {
  const { validateOwnedDialogSource } = await harness;
  for (const bytes of [Buffer.alloc(0), Buffer.from('{}'), Buffer.from('{"ok":true}'), Buffer.from('unrecognized local evidence')]) {
    assert.throws(() => validateOwnedDialogSource(bytes), /report changed/);
  }
});
test('optional retained local evidence pins the exact owned failed report bytes and GUID', async t => {
  const { validateOwnedDialogSource, ownedDialogSource } = await harness;
  let bytes;
  try { bytes = await fs.readFile(path.resolve(__dirname, '..', ownedDialogSource.report)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('The retained local acceptance report is not distributed in a clean checkout');
    return;
  }
  const source = validateOwnedDialogSource(bytes);
  assert.equal(source.clientGuid, clientGuid); assert.equal(source.originalAcceptanceStillFailed, true); assert.equal(source.priorNormalFixtureExit, true);
  for (const edit of [r => { r.ok = true; }, r => { r.stages[0].receipt.clientGuid = '00000000-0000-0000-0000-000000000000'; },
    r => { r.stages[0].receipt.freshCleanup.clearHresult = 0; }, r => { r.cleanup.fixtureExit.originalExited = false; }]) {
    const value = JSON.parse(bytes); edit(value); assert.throws(() => validateOwnedDialogSource(Buffer.from(JSON.stringify(value))), /report changed/);
  }
  assert.throws(() => validateOwnedDialogSource(Buffer.concat([bytes, Buffer.from('\n')])), /report changed/);
});
test('raw E_FAIL is diagnostic evidence and never converted to cleared/history-absent acceptance', async () => {
  const { validateRawCleanupResult } = await harness;
  for (const code of [-2147467259, 0, 1, -2147024891]) {
    const comparison = validateRawCleanupResult(raw(code), expected, identity);
    assert.equal(comparison.rawHresult, code); assert.equal(comparison.clearReturnedSOk, code === 0);
    assert.equal(comparison.sameAsPriorExceptionHresult, code === -2147467259);
    assert.equal(comparison.historyAbsenceAsserted, false); assert.equal(comparison.originalAcceptanceStillFailed, true);
  }
});
test('result requires exact identity raw signed HRESULTs scoped S_OK and normal release', async () => {
  const { validateRawCleanupResult } = await harness;
  for (const edit of [r => { r.nonce = 'f'.repeat(32); }, r => { r.pid++; }, r => { r.startedUtcTicks = '639289103638373286'; },
    r => { r.result.setClientGuidHresult = 1; }, r => { r.result.clearClientDataHresult = null; }, r => { r.result.clearClientDataHresult = 2147483648; },
    r => { r.result.clearClientDataHresult = -2147483649; }, r => { r.result.rawInterfaceReleased = false; }, r => { r.result.rcwFinalReleaseCount = 1; },
    r => { r.result.comUninitialized = false; }, r => { r.result.showCalled = true; }, r => { r.result.adviseCalled = true; },
    r => { r.result.failures = [{ stage: 'Dispose' }]; }, r => { r.result.historyAbsenceAsserted = true; }]) {
    const result = raw(); edit(result); assert.throws(() => validateRawCleanupResult(result, expected, identity));
  }
});
test('gate refusal launches nothing and sends no COM go token', async () => {
  const { runNoShowDiagnostic } = await harness; const f = fake();
  f.io.gate = async () => { f.calls.push('gate'); throw new Error('deferred'); };
  const result = await runNoShowDiagnostic(expected, f.io);
  assert.equal(result.ok, false); assert.equal(result.comAuthorized, false); assert.equal(result.cleanup.attempted, false); assert.deepEqual(f.calls, ['gate']);
});
test('full pin precedes COM go and raw E_FAIL leaves prior acceptance failed with clean owned exit', async () => {
  const { runNoShowDiagnostic } = await harness; const f = fake();
  const result = await runNoShowDiagnostic(expected, f.io);
  assert.equal(result.ok, true); assert.equal(result.diagnosticCompleted, true); assert.equal(result.comparison.clearReturnedSOk, false);
  assert.equal(result.comparison.originalAcceptanceStillFailed, true); assert.equal(result.cleanup.exit.originalExited, true);
  assert.equal(f.alive, false); assert.deepEqual(f.calls, ['gate', 'launch', 'ready', 'inspect', 'go', 'result', 'close', 'closed', 'wait']);
});
test('launch side effect then handshake throw still recovers full identity and closes without COM', async () => {
  const { runNoShowDiagnostic } = await harness; const f = fake(), launch = f.io.launch;
  f.io.launch = async () => { await launch(); throw new Error('launcher finally failed after launch'); };
  const result = await runNoShowDiagnostic(expected, f.io);
  assert.equal(result.ok, false); assert.match(result.error.message, /after launch/); assert.equal(result.comAuthorized, false);
  assert.equal(result.cleanup.identityRecovered, true); assert.equal(result.cleanup.ok, true); assert.equal(f.alive, false);
  assert.deepEqual(f.calls, ['gate', 'launch', 'ready', 'inspect', 'close', 'closed', 'wait']);
});
test('unknown ready identity still gets nonce close but never PID wait/force/COM', async () => {
  const { runNoShowDiagnostic } = await harness;
  for (const change of [io => { io.ready = async () => { throw new Error('no receipt'); }; },
    io => { io.ready = async () => ({ ...ready, clientGuid: '00000000-0000-0000-0000-000000000000' }); },
    io => { io.inspect = async () => ({ ...identity, sha256: 'f'.repeat(64) }); },
    io => { io.inspect = async () => ({ ...identity, executable: 'C:\\other\\Probe.exe' }); },
    io => { io.inspect = async () => ({ ...identity, startedUtcTicks: '639289103638373286' }); },
    io => { io.inspect = async () => ({ ...identity, parentPid: 0 }); },
    io => { io.inspect = async () => ({ ...identity, integrityRid: 12288, elevated: true }); }]) {
    const f = fake(); change(f.io); const result = await runNoShowDiagnostic(expected, f.io);
    assert.equal(result.ok, false); assert.equal(result.cleanup.ok, false); assert.equal(result.cleanup.closeRequested, true);
    assert.equal(f.alive, false); assert.equal(f.calls.includes('go'), false); assert.equal(f.calls.includes('wait'), false); assert.equal(f.calls.includes('force'), false);
  }
});
test('result transport failure still closes exact child and is not retried', async () => {
  const { runNoShowDiagnostic } = await harness; const f = fake();
  f.io.result = async () => { f.calls.push('result'); throw new Error('result lost'); };
  const result = await runNoShowDiagnostic(expected, f.io);
  assert.equal(result.ok, false); assert.equal(result.cleanup.ok, true); assert.equal(f.calls.filter(call => call === 'launch').length, 1);
  assert.equal(f.calls.filter(call => call === 'go').length, 1); assert.equal(f.calls.filter(call => call === 'result').length, 1); assert.equal(f.alive, false);
});
test('exit wait failure retains error and tries only fully pinned forced cleanup; force never passes', async () => {
  const { runNoShowDiagnostic } = await harness; const f = fake(); let waits = 0;
  const wait = f.io.wait;
  f.io.wait = async (...args) => { if (++waits === 1) { f.calls.push('wait-failed'); throw new Error('native wait failed'); } return wait(...args); };
  const result = await runNoShowDiagnostic(expected, f.io);
  assert.equal(result.ok, false); assert.equal(result.cleanup.ok, false); assert.equal(result.cleanup.exit.originalExited, true);
  assert.equal(result.cleanup.exit.forcedAttempts.length, 1); assert.deepEqual(result.cleanup.exit.forcedAttempts[0].identity, identity);
  assert.match(result.cleanup.exit.errors[0].message, /native wait failed/); assert.equal(f.calls.includes('force'), true);
});
test('a timed-out normal exit forces only exact original and remains diagnostic failure', async () => {
  const { runNoShowDiagnostic } = await harness; const f = fake(); let waits = 0;
  f.io.wait = async () => ({ ok: true, originalExited: ++waits > 1 });
  const result = await runNoShowDiagnostic(expected, f.io);
  assert.equal(result.ok, false); assert.equal(result.cleanup.exit.forcedAttempts.length, 1); assert.equal(result.cleanup.exit.originalExited, true);
});
test('watchdog failure and missing normal COM release cannot become passing diagnostics', async () => {
  const { runNoShowDiagnostic } = await harness;
  for (const change of [io => { io.failure = async () => ({ code: 'COM_CALL_DEADLINE', forced: true }); },
    io => { io.closed = async () => ({ ...receipt, reason: 'heartbeat_or_ttl', normalReleaseConfirmed: true, comAttempted: true, comFinished: true }); },
    io => { io.closed = async () => ({ ...receipt, reason: 'requested', normalReleaseConfirmed: false, comAttempted: true, comFinished: true }); }]) {
    const f = fake(); change(f.io); const result = await runNoShowDiagnostic(expected, f.io); assert.equal(result.ok, false); assert.equal(f.alive, false);
  }
});

test('pure C# seam preserves HRESULTs single-call order release and SDK COM slots without COM execution', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-dialog-cleanup-pure-'));
  const source = path.join(directory, 'PureTests.cs'), executable = path.join(directory, 'PureTests.exe');
  await fs.writeFile(source, `using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
public static class DialogCleanupPureTests {
  static int checks;static void Check(bool value){checks++;if(!value)throw new Exception("check "+checks);}
  sealed class Fake:DesktopDialogCleanupProbe.IRawDialog {
    public readonly List<string> log;public int set,clear;public string throws;
    public Fake(List<string> log){this.log=log;}
    public int SetClientGuid(Guid value){Check(value.ToString()==DesktopDialogCleanupProbe.AllowedClient);log.Add("set");if(throws=="set")throw new InvalidOperationException();return set;}
    public int ClearClientData(){log.Add("clear");if(throws=="clear")throw new InvalidOperationException();return clear;}
    public void Dispose(){log.Add("dispose");if(throws=="dispose")throw new InvalidOperationException();}
  }
  public static int Main(){
    foreach(int code in new[]{0,1,unchecked((int)0x80004005),unchecked((int)0x80070005)}){
      var log=new List<string>();var fake=new Fake(log){clear=code};
      var result=DesktopDialogCleanupProbe.Run(DesktopDialogCleanupProbe.AllowedClient,r=>{log.Add("create");return fake;});
      Check(String.Join(",",log)=="create,set,clear,dispose");Check(result.setClientGuidHresult==0);Check(result.clearClientDataHresult==code);
      Check(result.failures.Count==0&&result.disposeAttempted&&result.disposeReturned);Check(!result.showCalled&&!result.adviseCalled&&!result.historyAbsenceAsserted);
    }
    foreach(int code in new[]{1,unchecked((int)0x80004005)}){
      var log=new List<string>();var result=DesktopDialogCleanupProbe.Run(DesktopDialogCleanupProbe.AllowedClient,r=>new Fake(log){set=code});
      Check(String.Join(",",log)=="set,dispose");Check(result.setClientGuidHresult==code&&result.clearClientDataHresult==null);Check(result.disposeReturned);
    }
    foreach(string fault in new[]{"set","clear","dispose"}){
      var log=new List<string>();var result=DesktopDialogCleanupProbe.Run(DesktopDialogCleanupProbe.AllowedClient,r=>new Fake(log){throws=fault,clear=unchecked((int)0x80004005)});
      Check(log.FindAll(x=>x=="dispose").Count==1);Check(result.failures.Count==1);Check(result.disposeAttempted);
      if(fault=="dispose"){Check(result.clearClientDataHresult==unchecked((int)0x80004005));Check(!result.disposeReturned);Check(result.failures[0].stage=="Dispose");}
      else Check(result.disposeReturned);
    }
    bool called=false;try{DesktopDialogCleanupProbe.Run(Guid.Empty.ToString(),r=>{called=true;return null;});throw new Exception("accepted");}catch(ArgumentException){}Check(!called);
    var failure=DesktopDialogCleanupProbe.Run(DesktopDialogCleanupProbe.AllowedClient,r=>{throw new InvalidOperationException();});Check(failure.failures.Count==1&&failure.failures[0].stage=="create");Check(!failure.disposeAttempted);
    var methods=typeof(DesktopDialogCleanupProbe.IFileDialog).GetMethods();Array.Sort(methods,(a,b)=>a.MetadataToken.CompareTo(b.MetadataToken));
    string names="Show,SetFileTypes,SetFileTypeIndex,GetFileTypeIndex,Advise,Unadvise,SetOptions,GetOptions,SetDefaultFolder,SetFolder,GetFolder,GetCurrentSelection,SetFileName,GetFileName,SetTitle,SetOkButtonLabel,SetFileNameLabel,GetResult,AddPlace,SetDefaultExtension,Close,SetClientGuid,ClearClientData,SetFilter";
    Check(methods.Length==24);Check(String.Join(",",Array.ConvertAll(methods,m=>m.Name))==names);
    foreach(var method in methods){Check(method.ReturnType==typeof(int));Check((method.GetMethodImplementationFlags()&MethodImplAttributes.PreserveSig)!=0);}
    Check(methods[21].Name=="SetClientGuid"&&methods[21].GetParameters()[0].ParameterType==typeof(Guid).MakeByRefType());
    Check(methods[22].Name=="ClearClientData"&&methods[22].GetParameters().Length==0);Check(typeof(DesktopDialogCleanupProbe.IFileDialog).IsImport);
    Check(typeof(DesktopDialogCleanupProbe.IFileDialog).GUID.ToString()=="42f85136-db7e-439c-85f1-e4075d135fc8");
    Console.WriteLine("{\\"ok\\":true,\\"checks\\":"+checks+",\\"comExecuted\\":false}");return 0;
  }
}`);
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/main:DialogCleanupPureTests', '/r:System.Web.Extensions.dll', '/out:' + executable,
    path.resolve(__dirname, '../scripts/e2e/desktop-dialog-cleanup-probe.cs'), source], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 10000, encoding: 'utf8' }));
  assert.equal(result.ok, true); assert.equal(result.comExecuted, false); assert.ok(result.checks >= 100);
});
