const test = require('node:test');
const assert = require('node:assert/strict');
const harness = import('../scripts/verify-desktop-dialogs.mjs');
const nonce = 'a'.repeat(32);
const identity = { nonce, pid: 123, startedUtcTicks: '639289058809776183' };
const file = 'C:\\owned\\' + nonce + '.txt';
const element = patch => ({ reference: 'e1', role: 'Button', name: '', automationId: '', actions: ['invoke'], password: false, enabled: true, offscreen: false, parent: -1, ...patch });

test('native dialog acceptance defaults to compile-only and rejects mixed run flags', async () => {
  const { parseOptions } = await harness;
  assert.deepEqual(parseOptions([]), { run: false, caseName: 'both' }); assert.deepEqual(parseOptions(['--check']), { run: false, caseName: 'both' });
  assert.deepEqual(parseOptions(['--run']), { run: true, caseName: 'both' });
  for (const caseName of ['cancel', 'open', 'both']) {
    assert.deepEqual(parseOptions(['--run', '--case', caseName]), { run: true, caseName });
    assert.deepEqual(parseOptions(['--case', caseName, '--check']), { run: false, caseName });
    assert.deepEqual(parseOptions(['--case', caseName]), { run: false, caseName });
  }
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--run', '--retry'], ['--unknown'], ['--case'],
    ['--case', ''], ['--case', '--run'], ['--case', 'unknown'], ['--case', 'open', '--case', 'cancel']]) assert.throws(() => parseOptions(args));
});

test('independent dialog cases start at sequence one while default both keeps Cancel before Open', async () => {
  const { dialogPlan } = await harness;
  assert.deepEqual(dialogPlan('open'), [{ mode: 'open', sequence: 1 }]);
  assert.deepEqual(dialogPlan('cancel'), [{ mode: 'cancel', sequence: 1 }]);
  assert.deepEqual(dialogPlan('both'), [{ mode: 'cancel', sequence: 1 }, { mode: 'open', sequence: 2 }]);
  assert.throws(() => dialogPlan('invalid'));
});

test('fresh-instance cleanup diagnostics require explicit one-case opt-in and preserve original failure', async () => {
  const { parseOptions, assertDialogResult } = await harness;
  for (const caseName of ['open', 'cancel']) assert.deepEqual(parseOptions(['--case', caseName, '--cleanup-after-release']),
    { run: false, caseName, cleanupAfterRelease: true });
  for (const args of [['--cleanup-after-release'], ['--case', 'both', '--cleanup-after-release'],
    ['--case', 'open', '--cleanup-after-release', '--cleanup-after-release']]) assert.throws(() => parseOptions(args));
  const failure = { ...identity, mode: 'open', sequence: 1, result: 0, ok: false, clientCleared: false,
    failures: [{ operation: 'IFileDialog.ClearClientData', hresult: -2147467259 }], originalRcwReleased: true,
    freshCleanup: { attempted: true, clientScoped: true, cleared: true, released: true, clearHresult: 0, failures: [] } };
  assert.throws(() => assertDialogResult(failure, { identity, mode: 'open', sequence: 1, file }), /IFileDialog.ClearClientData/);
});

test('dialog window selection requires exact PID HWND title and rejects ambiguity', async () => {
  const { exactWindow } = await harness;
  const receipt = { pid: 123, hwnd: '987', title: 'owned ' + nonce, className: '#32770' };
  const target = { pid: 123, nativeHandle: '987', title: receipt.title, className: '#32770', id: '1'.repeat(32) };
  assert.equal(exactWindow([{ ...target, pid: 999 }, { ...target, nativeHandle: '888' }, target], receipt), target);
  for (const entries of [[], [target, { ...target }], [{ ...target, title: 'unowned' }], [{ ...target, className: 'Button' }]]) assert.throws(() => exactWindow(entries, receipt));
});

test('file dialog controls use observed roles capabilities and owned labels without localized button guesses', async () => {
  const { dialogControl, dialogLabels } = await harness;
  const scope = { windowId: 'owned-window', title: 'ProfilePilot native dialog ' + nonce + ' 1' };
  const root = element({ reference: 'e0', role: 'Window', name: scope.title, actions: [] });
  const combo = element({ reference: 'e1', name: dialogLabels.file, role: 'ComboBox', actions: [], parent: 0 });
  const input = element({ reference: 'e2', role: 'Edit', actions: ['set_value', 'text'], parent: 1 });
  const address = element({ reference: 'address', role: 'Edit', name: 'Address', actions: ['set_value'], parent: 0 });
  const cancel = element({ reference: 'e3', name: '\u53d6\u6d88', automationId: '2', parent: 0 });
  const open = element({ reference: 'e4', name: dialogLabels.open, automationId: '1', parent: 0 });
  const observation = { windowId: scope.windowId, elements: [root, combo, input, address, cancel, open] };
  const observed = elements => ({ windowId: scope.windowId, elements: [root, ...elements] });
  assert.equal(dialogControl(observation, 'file', scope), input); assert.equal(dialogControl(observation, 'cancel', scope), cancel);
  assert.equal(dialogControl(observation, 'open', scope), open);
  assert.throws(() => dialogControl(observed([address]), 'file', scope));
  assert.throws(() => dialogControl(observed([cancel, { ...cancel }]), 'cancel', scope));
  for (const patch of [{ password: true }, { enabled: false }, { offscreen: true }, { actions: [] }])
    assert.throws(() => dialogControl(observed([{ ...cancel, ...patch }]), 'cancel', scope));
  assert.throws(() => dialogControl(observed([element({ role: 'Edit', actions: ['set_value'], parent: 1 })]), 'file', scope));
  assert.throws(() => dialogControl({ ...observation, windowId: 'another-window' }, 'file', scope));
  assert.throws(() => dialogControl({ ...observation, elements: [{ ...root, name: 'another dialog' }, ...observation.elements.slice(1)] }, 'file', scope));
  const labelledEdit = element({ role: 'Edit', name: dialogLabels.file + ':', actions: ['set_value'], parent: 0 });
  assert.equal(dialogControl(observed([labelledEdit]), 'file', scope), labelledEdit);
  for (const automationId of ['SearchEditBox', 'System.ItemNameDisplay', 'System.DateModified', 'System.Size'])
    assert.throws(() => dialogControl(observed([{ ...labelledEdit, automationId }]), 'file', scope));
  assert.throws(() => dialogControl(observed([element({ role: 'ListItem', name: nonce + '.txt', parent: 0 }), { ...labelledEdit, parent: 1 }]), 'file', scope));
});

test('unconfirmed modal Invoke is never replayed or followed by dialog interaction', async () => {
  const { invokeOwnedDialog } = await harness;
  for (const response of [{ ok: false, code: 'DESKTOP_OUTCOME_UNKNOWN' }, { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }, { ok: true, result: {} }]) {
    let invokes = 0, reads = 0;
    await assert.rejects(invokeOwnedDialog(async () => { invokes++; return response; }, async () => { reads++; }), /stop without replay/);
    assert.equal(invokes, 1); assert.equal(reads, 0);
  }
  let later = false;
  await assert.rejects(invokeOwnedDialog(async () => { throw new Error('timeout'); }, async () => { later = true; }), /timeout/);
  assert.equal(later, false);
  assert.deepEqual(await invokeOwnedDialog(async () => ({ ok: true, result: { executed: true } }), async () => ({ hwnd: '42' })),
    { response: { ok: true, result: { executed: true } }, dialog: { hwnd: '42' } });
});

test('Open and Cancel receipts require exact file identity unchanged parent and scoped client cleanup', async () => {
  const { assertDialogResult, dialogOptions } = await harness;
  assert.equal(dialogOptions & 0x02000000, 0x02000000); assert.equal(dialogOptions & 0x200, 0);
  const value = { ...identity, sequence: 2, mode: 'open', result: 0, ok: true, selectedPath: file, clientCleared: true,
    clientScoped: true, clientCleanupAttempted: true, clientGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', showInvoked: true, showReturned: true, failures: [],
    workingDirectoryRestored: true, parentEnabled: true, closing: false, sentinels: 0, reentrant: 0, fileOkCalls: 1, acceptedFiles: 1 };
  const options = { identity, mode: 'open', sequence: 2, file };
  assert.doesNotThrow(() => assertDialogResult(value, options));
  for (const patch of [{ nonce: 'b'.repeat(32) }, { pid: 124 }, { startedUtcTicks: '123' }, { selectedPath: 'C:\\users\\other.txt' },
    { selectedPath: '..\\other.txt' }, { clientCleared: false }, { clientScoped: false }, { clientCleanupAttempted: false }, { clientGuid: '00000000-0000-0000-0000-000000000000' },
    { showInvoked: false }, { showReturned: false }, { failures: [{ operation: 'IFileDialog.ClearClientData' }] }, { closing: true }, { parentEnabled: false }, { sentinels: 1 }, { fileOkCalls: 0 }])
    assert.throws(() => assertDialogResult({ ...value, ...patch }, options));
  const cancel = { ...value, mode: 'cancel', sequence: 1, result: -2147023673, selectedPath: null, acceptedFiles: 0 };
  assert.doesNotThrow(() => assertDialogResult(cancel, { ...options, mode: 'cancel', sequence: 1 }));
  assert.throws(() => assertDialogResult({ ...cancel, selectedPath: file }, { ...options, mode: 'cancel', sequence: 1 }));
});

test('dialog result exposes every failed operation and HRESULT without masking the valid cancellation result', async () => {
  const { assertDialogResult } = await harness;
  const failures = [
    { operation: 'IFileDialog.Unadvise', type: 'System.Runtime.InteropServices.COMException', hresult: -2147467259, hresultHex: '0x80004005', message: 'first failure' },
    { operation: 'IFileDialog.ClearClientData', type: 'System.Runtime.InteropServices.COMException', hresult: -2147418113, hresultHex: '0x8000FFFF', message: 'second failure' }
  ];
  const value = { ...identity, mode: 'cancel', sequence: 1, result: -2147023673, resultHex: '0x800704C7', ok: false, error: 'first failure', failures };
  assert.throws(() => assertDialogResult(value, { identity, mode: 'cancel', sequence: 1, file }), error =>
    /IFileDialog.Unadvise/.test(error.message) && /IFileDialog.ClearClientData/.test(error.message) && /0x80004005/.test(error.message) && /0x8000FFFF/.test(error.message));
  assert.equal(value.result, -2147023673); assert.equal(value.failures.length, 2);
});

test('native fixture failure formatting preserves the original HRESULT without creating a COM object or window', { skip: process.platform !== 'win32' }, () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dialog-pure-'));
  const source = path.join(home, 'FixtureDiagnosticTest.cs'), executable = path.join(home, 'FixtureDiagnosticTest.exe');
  fs.writeFileSync(source, `using System; using System.Runtime.InteropServices; using System.Web.Script.Serialization;
public static class FixtureDiagnosticTest {
  public static void Main() {
    var failure = new COMException("owned fixture failure", unchecked((int)0x8000FFFF));
    var first = DesktopDialogFixture.DescribeFailure("IFileDialog.ClearClientData", failure);
    var second = DesktopDialogFixture.DescribeFailure("IFileDialog.Unadvise", new COMException("other failure", unchecked((int)0x80004005)));
    Console.WriteLine(new JavaScriptSerializer().Serialize(new { first, second, originalHresult = failure.HResult }));
  }
}`);
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/platform:x64', '/warnaserror+', '/target:exe', '/main:FixtureDiagnosticTest', '/out:' + executable,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', source, path.resolve(__dirname, '../scripts/e2e/desktop-dialog-fixture.cs')], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 5000 }));
  assert.deepEqual(result.first, { operation: 'IFileDialog.ClearClientData', type: 'System.Runtime.InteropServices.COMException',
    hresult: -2147418113, hresultHex: '0x8000FFFF', message: 'owned fixture failure' });
  assert.equal(result.originalHresult, result.first.hresult); assert.equal(result.second.hresultHex, '0x80004005');
  assert.equal(result.second.operation, 'IFileDialog.Unadvise');
});

test('management cleanup failure still retires the owned fixture and cannot report success', async () => {
  const { cleanupDialogAcceptance } = await harness;
  const steps = [];
  const executable = 'C:\\owned\\fixture.exe', fixtureSha256 = 'b'.repeat(64);
  const original = { ok: true, pid: 123, parentPid: 234, startedUtcTicks: identity.startedUtcTicks, executable, sha256: fixtureSha256, integrityRid: 8192, elevated: false, uiAccess: false };
  const result = await cleanupDialogAcceptance({ session: 'own', fixture: { pid: 123 }, fixtureIdentity: original, executable, nonce, fixtureSha256 }, {
    desktop: async () => { steps.push('status'); throw new Error('service unavailable'); },
    writeClose: async () => { steps.push('close'); }, readClosed: async () => ({ ...identity, reason: 'requested', modal: false }),
    inspect: args => { steps.push(args[0]); return { ok: true, originalExited: true }; }
  });
  assert.equal(result.ok, false); assert.equal(result.cleanup.sessionError, 'service unavailable');
  assert.deepEqual(steps, ['status', 'close', '--wait-owned-exit']); assert.equal(result.cleanup.fixtureExit.originalExited, true);
});

test('forced cleanup is pinned to original fixture identity and always fails acceptance', async () => {
  const { cleanupDialogAcceptance } = await harness;
  const calls = [];
  const original = { ok: true, pid: 123, startedUtcTicks: identity.startedUtcTicks, sha256: 'a'.repeat(64), parentPid: 111,
    executable: 'C:\\owned\\fixture.exe', integrityRid: 8192, elevated: false, uiAccess: false };
  const result = await cleanupDialogAcceptance({ session: 'own', fixture: { pid: 123 }, fixtureIdentity: original, executable: original.executable, nonce, fixtureSha256: original.sha256 }, {
    desktop: async () => ({ ok: true, result: { session: { name: 'someone-else' } } }), writeClose: async () => {},
    readClosed: async () => { throw new Error('receipt missing'); },
    inspect: args => { calls.push(args); return args[0] === '--wait-owned-exit' ? { ok: true, originalExited: false } : { ok: true }; }
  });
  assert.equal(result.ok, false); assert.match(result.cleanup.fixtureError, /Forced/);
  assert.deepEqual(calls[1], ['--cleanup-owned', '123', identity.startedUtcTicks, 'C:\\owned\\fixture.exe', original.sha256, '111']);
  assert.equal(result.cleanup.forcedAttempts.length, 1); assert.equal(result.cleanup.forcedAttempts[0].attempted, true);
  assert.equal(result.cleanup.session.name, 'someone-else');
});

test('unknown or mismatched launch recovery identity still nonce-closes but never waits or kills a bare PID', async () => {
  const { cleanupDialogAcceptance } = await harness;
  for (const defect of ['missing-ready', 'nonce', 'birth', 'hash', 'path', 'parent', 'elevation', 'pid']) {
    const executable = 'C:\\owned\\fixture.exe', fixtureSha256 = 'b'.repeat(64), calls = [];
    const ready = { ...identity, hwnd: '456', administrator: false, dialogApi: 'IFileOpenDialog', addToRecent: false };
    const original = { ok: true, pid: identity.pid, parentPid: 234, startedUtcTicks: identity.startedUtcTicks,
      executable, sha256: fixtureSha256, integrityRid: 8192, elevated: false, uiAccess: false };
    if (defect === 'nonce') ready.nonce = 'c'.repeat(32);
    if (defect === 'birth') original.startedUtcTicks = '639289105934553000';
    if (defect === 'hash') original.sha256 = 'c'.repeat(64);
    if (defect === 'path') original.executable = 'C:\\unowned\\fixture.exe';
    if (defect === 'parent') original.parentPid = 0;
    if (defect === 'elevation') original.elevated = true;
    if (defect === 'pid') original.pid++;
    const result = await cleanupDialogAcceptance({ session: 'own', fixtureAttempted: true, nonce, executable, fixtureSha256 }, {
      desktop: async () => ({ ok: true, result: { session: null } }),
      readReady: async () => { if (defect === 'missing-ready') throw new Error('ready unavailable'); return ready; },
      writeClose: async () => { calls.push('nonce-close'); }, readClosed: async () => ({ ...identity, reason: 'requested', modal: false }),
      inspect: async args => { calls.push(args[0]); assert.equal(args[0], '--inspect', 'Unverified identity must not be waited on or killed'); return original; }
    });
    assert.equal(result.ok, false, defect); assert.ok(result.cleanup.identityError, defect); assert.equal(result.cleanup.closeRequested, true, defect);
    assert.ok(calls.includes('nonce-close'), defect); assert.equal(result.cleanup.fixtureIdentity, undefined); assert.equal(result.cleanup.fixtureExit, undefined);
  }
});

test('verified cleanup wait error preserves failure, attempts exact force and independently confirms exit', async () => {
  const { cleanupDialogAcceptance } = await harness;
  const executable = 'C:\\owned\\fixture.exe', fixtureSha256 = 'b'.repeat(64), calls = [];
  const original = { ok: true, pid: identity.pid, parentPid: 234, startedUtcTicks: identity.startedUtcTicks,
    executable, sha256: fixtureSha256, integrityRid: 8192, elevated: false, uiAccess: false };
  let waits = 0;
  const result = await cleanupDialogAcceptance({ session: 'own', fixtureAttempted: true, fixtureIdentity: original, nonce, executable, fixtureSha256 }, {
    desktop: async () => ({ ok: true, result: { session: null } }), writeClose: async () => {},
    readClosed: async () => ({ ...identity, reason: 'requested', modal: false }),
    inspect: async args => {
      calls.push(args); if (args[0] === '--wait-owned-exit') { if (++waits === 1) throw new Error('wait access failure'); return { ok: true, originalExited: true }; }
      assert.deepEqual(args, ['--cleanup-owned', '123', identity.startedUtcTicks, executable, fixtureSha256, '234']); return { ok: true, originalExited: true, forced: true };
    }
  });
  assert.equal(result.ok, false); assert.equal(result.cleanup.fixtureExit.originalExited, true);
  assert.equal(result.cleanup.fixtureRetirement.errors[0].stage, 'wait'); assert.match(result.cleanup.fixtureRetirement.errors[0].message, /access failure/);
  assert.equal(result.cleanup.forcedAttempts.length, 1); assert.equal(result.cleanup.forcedAttempts[0].attempted, true);
  assert.deepEqual(calls.map(value => value[0]), ['--wait-owned-exit', '--cleanup-owned', '--wait-owned-exit']);
});

test('dialog runner records attempted launch before awaiting and describes cleanup as attempted', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../scripts/verify-desktop-dialogs.mjs'), 'utf8');
  assert.ok(source.indexOf('fixtureAttempted = report.fixtureLaunchAttempted = true') < source.indexOf('fixture = await launchWindowsUserProcess('));
  assert.match(source, /cleanupDialogAcceptance\(\{ session, fixture, fixtureAttempted, fixtureIdentity, executable, nonce, fixtureSha256:/);
  assert.match(source, /attempts to clear only its nonce-derived/); assert.doesNotMatch(source, /The fixture clears only/);
});

test('launch side effect then throw plus unavailable status still nonce-closes and confirms the exact recovered original process', async () => {
  const { cleanupDialogAcceptance } = await harness;
  const executable = 'C:\\owned\\fixture.exe', sha256 = 'b'.repeat(64), calls = [];
  const original = { ok: true, pid: identity.pid, parentPid: 234, startedUtcTicks: identity.startedUtcTicks,
    executable, sha256, integrityRid: 8192, elevated: false, uiAccess: false };
  let fixture, fixtureAttempted = false, alive = false, failure;
  const launch = async () => { calls.push('launch'); alive = true; throw new Error('launcher finally failed after process creation'); };
  try { fixtureAttempted = true; fixture = await launch(); } catch (error) { failure = error; }
  const result = await cleanupDialogAcceptance({ session: 'own', fixture, fixtureAttempted, nonce, executable, fixtureSha256: sha256 }, {
    desktop: async () => { calls.push('status'); throw new Error('status unavailable'); },
    readReady: async () => { calls.push('ready'); return { ...identity, hwnd: '456', administrator: false, dialogApi: 'IFileOpenDialog', addToRecent: false }; },
    writeClose: async () => { calls.push('nonce-close'); alive = false; },
    readClosed: async () => ({ ...identity, reason: 'requested', modal: false }),
    inspect: args => { calls.push(args[0]); if (args[0] === '--inspect') { assert.equal(alive, true); return original; }
      assert.deepEqual(args, ['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, '10000']); return { ok: true, originalExited: !alive }; }
  });
  assert.equal(fixture, undefined); assert.match(failure.message, /after process creation/);
  assert.equal(result.ok, false); assert.equal(result.cleanup.sessionError, 'status unavailable');
  assert.equal(alive, false, 'Launcher created the process, so status failure must not skip nonce close');
  assert.equal(result.cleanup.identityRecovered, true); assert.deepEqual(result.cleanup.fixtureIdentity, original);
  assert.equal(result.cleanup.fixtureExit.originalExited, true); assert.equal(alive, false);
  assert.deepEqual(calls, ['launch', 'status', 'ready', '--inspect', 'nonce-close', '--wait-owned-exit']);
});
