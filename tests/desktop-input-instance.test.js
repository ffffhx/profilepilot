const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

test('native and compatibility helpers arbitrate one lifetime across independent processes', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-input-instance-test-'));
  const root = path.resolve(__dirname, '..');
  const fixed = 'Local\\ProfilePilot.InputObserver';
  // An isolated kernel namespace exercises the same compiled admission code
  // without holding the production lease or affecting a running user's helper.
  const isolated = fixed + '.test-' + randomUUID();
  const native = fs.readFileSync(path.join(root, 'native/input-observer-win.cs'), 'utf8');
  const ps = fs.readFileSync(path.join(root, 'native/input-guard-win.ps1'), 'utf8');
  const legacy = ps.split("$source = @'\n")[1]?.split("\n'@")[0]
    || ps.replace(/\r\n/g, '\n').split("$source = @'\n")[1]?.split("\n'@")[0];
  assert.ok(legacy); assert.equal(native.split(fixed).length, 2); assert.equal(legacy.split(fixed).length, 2);
  const files = ['observer.cs', 'legacy.cs', 'entry.cs'].map(file => path.join(directory, file));
  fs.writeFileSync(files[0], native.replace(fixed, isolated));
  fs.writeFileSync(files[1], legacy.replace(fixed, isolated));
  fs.writeFileSync(files[2], `using System; using System.Reflection; using System.Threading;
public static class InstanceTests {
  public static int Main(string[] args) {
    EventWaitHandle collision = null;
    if (args[0] == "event") collision = new EventWaitHandle(false, EventResetMode.ManualReset, ProfilePilot.InputObservation.InputObserverInstanceGate.Name);
    int error = 0;
    bool acquired = args[0] == "legacy"
      ? (bool)typeof(ProfilePilotWindowsInputGuard).GetMethod("AcquireInstance", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null)
      : ProfilePilot.InputObservation.InputObserverInstanceGate.TryEnter(out error);
    Console.WriteLine(acquired ? "acquired" : "unavailable:" + error);
    if (!acquired) { if(collision != null) collision.Dispose(); return 2; }
    Console.ReadLine(); return 0;
  }
}`);
  const executable = path.join(directory, 'InstanceTests.exe');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/warnaserror+', '/main:InstanceTests', `/out:${executable}`, '/r:System.Web.Extensions.dll', ...files], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) {
      const closed = once(child, 'close'); child.stdin.end('\n'); await closed;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pp-input-instance-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function start(kind) {
    const child = spawn(executable, [kind], { stdio: 'pipe', windowsHide: true }); children.push(child);
    const exited = once(child, 'close');
    let output = '';
    const line = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.trim()); });
      child.on('error', reject); child.on('close', () => { if (!output.includes('\n')) reject(new Error('No gate receipt')); });
    });
    return { child, line, exited };
  }
  for (const [ownerKind, contenderKind] of [['native', 'native'], ['native', 'legacy'], ['legacy', 'native']]) {
    const owner = await start(ownerKind); assert.equal(owner.line, 'acquired');
    for (let attempt = 0; attempt < 2; attempt++) {
      const contender = await start(contenderKind);
      assert.match(contender.line, /^unavailable:/); assert.equal((await contender.exited)[0], 2);
      assert.equal(owner.child.exitCode, null, 'Failed contender must not affect the owner');
    }
    owner.child.stdin.end('\n'); assert.equal((await owner.exited)[0], 0);
    const successor = await start(contenderKind); assert.equal(successor.line, 'acquired');
    successor.child.stdin.end('\n'); assert.equal((await successor.exited)[0], 0);
  }
  const collision = await start('event');
  assert.equal(collision.line, 'unavailable:6'); assert.equal((await collision.exited)[0], 2);
  t.diagnostic('Real isolated kernel mutexes; same runner integrity only. No hook, window, input, production lease or cross-integrity proof.');
});
