import assert from 'node:assert/strict';
import path from 'node:path';

// Acceptance-only lifecycle. All I/O is supplied by the cycle harness; importing
// this module never launches, inspects, or terminates a process.
export function sessionCycleFixtureLifecycle(expectedValue, io) {
  const expected = Object.freeze({ ...expectedValue });
  assert.match(expected.nonce, /^[a-f0-9]{32}$/);
  assert.ok(path.win32.isAbsolute(expected.executable));
  assert.match(expected.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(expected.lifetimeMinutes) && expected.lifetimeMinutes >= 1 && expected.lifetimeMinutes <= 120);
  let attempted = false, launched, pinned, readiness, cleanupPromise;
  async function confirm() {
    assert.equal(attempted, true);
    if (pinned) return { identity: pinned, ready: readiness };
    const ready = await io.ready();
    assert.equal(ready.nonce, expected.nonce);
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
    assert.match(ready.startedUtcTicks, /^[1-9]\d{15,18}$/);
    assert.match(ready.hwnd, /^[1-9]\d*$/);
    assert.equal(ready.lifetimeMinutes, expected.lifetimeMinutes);
    assert.equal(ready.administrator, false); assert.equal(ready.inputInjected, false); assert.equal(ready.hooksInstalled, false);
    if (launched) assert.equal(ready.pid, launched.pid);
    const value = await io.inspect(ready.pid);
    assert.equal(value.ok, true); assert.equal(value.pid, ready.pid);
    assert.ok(Number.isSafeInteger(value.parentPid) && value.parentPid > 0);
    assert.equal(value.startedUtcTicks, ready.startedUtcTicks);
    assert.ok(path.win32.isAbsolute(value.executable));
    assert.equal(path.win32.resolve(value.executable).toLowerCase(), path.win32.resolve(expected.executable).toLowerCase());
    assert.equal(value.sha256, expected.sha256);
    assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false);
    // Publish only after every identity field and the private receipt agree.
    readiness = Object.freeze({ ...ready }); pinned = Object.freeze({ ...value });
    return { identity: pinned, ready: readiness };
  }
  async function cleanup() {
    const result = { attempted, errors: [], closeRequested: false, identityRecovered: false, ok: !attempted };
    if (!attempted) return result;
    const failed = (stage, error) => result.errors.push({ stage, message: error.message });
    // The process must still be alive for the full identity inspection. Recovery
    // is bounded by the caller's ready/inspect deadlines, then nonce-close runs
    // even if the launcher supplied no PID or the receipt cannot be trusted.
    try { if (!pinned) { await confirm(); result.identityRecovered = true; } }
    catch (error) { failed('identity', error); }
    try { await io.requestClose(); result.closeRequested = true; }
    catch (error) { failed('request-close', error); }
    try {
      const receipt = result.receipt = await io.closed();
      assert.equal(receipt.nonce, expected.nonce);
      assert.ok(pinned, 'No verified fixture identity; cannot confirm cleanup');
      assert.equal(receipt.pid, pinned.pid); assert.equal(receipt.startedUtcTicks, pinned.startedUtcTicks);
      assert.equal(receipt.hwnd, readiness.hwnd); assert.equal(receipt.closeReason, 'nonce_close');
    } catch (error) { failed('close-receipt', error); }
    if (pinned) {
      result.identity = pinned; result.ready = readiness;
      const exit = result.exit = { ok: false, originalExited: false, forcedAttempts: [] };
      try {
        exit.wait = await io.wait(pinned, 5000);
        assert.equal(exit.wait.ok, true); assert.equal(typeof exit.wait.originalExited, 'boolean');
        exit.originalExited = exit.wait.originalExited;
      } catch (error) { failed('wait', error); }
      if (!exit.originalExited) {
        const attempt = { identity: pinned }; exit.forcedAttempts.push(attempt);
        try { attempt.result = await io.force(pinned); }
        catch (error) { attempt.error = error.message; failed('force', error); }
        // A kill request or returned cleanup frame is not proof of process exit.
        try {
          exit.afterForce = await io.wait(pinned, 5000);
          assert.equal(exit.afterForce.ok, true); assert.equal(exit.afterForce.originalExited, true);
          exit.originalExited = true;
        } catch (error) { failed('after-force-wait', error); }
      }
      exit.ok = exit.originalExited && exit.forcedAttempts.length === 0 && !result.errors.some(error => ['wait', 'force', 'after-force-wait'].includes(error.stage));
    }
    // Unknown identity never permits even a PID-only wait/kill. A force fallback
    // always fails acceptance, including when the original exit is confirmed.
    result.ok = !result.errors.length && result.closeRequested && result.exit?.ok === true;
    return result;
  }
  return {
    get attempted() { return attempted; },
    get identity() { return pinned; },
    async launch() {
      assert.equal(attempted, false); attempted = true;
      launched = await io.launch(); return launched;
    },
    confirm,
    cleanup() { return cleanupPromise ||= cleanup(); }
  };
}
