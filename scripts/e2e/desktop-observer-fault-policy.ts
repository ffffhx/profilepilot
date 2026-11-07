import assert from 'node:assert/strict';

// Test-only policy. No process lookup, input, hooks, or product API is exposed.
export function validateFaultEnvelope(request: any, nonce: string, now = Date.now()) {
  assert.ok(request && typeof request === 'object' && !Array.isArray(request));
  assert.match(nonce, /^[a-f0-9]{32}$/); assert.equal(request.nonce, nonce);
  assert.match(request.id, /^[a-f0-9-]{36}$/);
  assert.ok(['inspect', 'fault', 'close'].includes(request.action));
  assert.ok(Number.isSafeInteger(request.expiresAt) && request.expiresAt > now && request.expiresAt - now <= 10000, 'Expired fault-fixture request');
  const fields = ['id', 'action', 'nonce', 'expiresAt', ...(request.action === 'fault' ? ['session', 'epoch', 'generation', 'childPid', 'childStartedUtcTicks'] : [])];
  assert.deepEqual(Object.keys(request).sort(), fields.sort(), 'Unknown private request fields');
}

export function validateOwnedObserverFault(request: any, evidence: any, nonce: string, now = Date.now()) {
  validateFaultEnvelope(request, nonce, now); assert.equal(request.action, 'fault');
  assert.equal(evidence.browserFactoryCalls, 0, 'Isolated fixture must never create a browser subscriber');
  assert.equal(evidence.ownedReferenceCurrent, true, 'Only the exact child returned by this fixture spawn may be stopped');
  assert.equal(evidence.spawnCount, 1, 'Unexpected observer replacement');
  const state = evidence.status, runtime = evidence.runtime, child = evidence.child, original = evidence.originalChild;
  assert.equal(state.session?.name, request.session); assert.equal(request.session, evidence.session);
  assert.equal(state.session?.window.pid, evidence.targetPid); assert.equal(state.session?.window.nativeHandle, evidence.targetHwnd);
  assert.equal(state.session.state, 'active'); assert.equal(state.inputObservation?.phase, 'ready');
  assert.equal(state.inputObservation?.unobservedTestDriver, undefined);
  assert.equal(runtime.connected, true); assert.equal(runtime.transport?.state, 'ready');
  assert.deepEqual(runtime.browserPids, []); assert.deepEqual(runtime.browserProtection?.activePids, []);
  assert.equal(runtime.browserProtection?.verified, true); assert.equal(runtime.browserProtection?.pendingConfigurations, 0);
  assert.equal(runtime.pendingGeneration, null); assert.equal(runtime.desktop?.phase, 'ready');
  for (const observed of [state.inputObservation, runtime.desktop]) {
    assert.equal(observed.epoch, request.epoch); assert.equal(observed.generation, request.generation);
  }
  assert.equal(runtime.epoch, request.epoch); assert.equal(runtime.transport.epoch, request.epoch);
  for (const value of [child, original]) {
    assert.equal(value.pid, request.childPid); assert.equal(value.parentPid, evidence.mainPid);
    assert.equal(value.startedUtcTicks, request.childStartedUtcTicks);
    assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false);
    assert.equal(value.sha256, evidence.expectedHash); assert.equal(value.executable.toLowerCase(), evidence.expectedPath.toLowerCase());
  }
  assert.equal(evidence.exited, false); assert.match(evidence.expectedHash, /^[a-f0-9]{64}$/);
  assert.match(request.childStartedUtcTicks, /^[1-9][0-9]{15,18}$/);
}

export class OwnedObserverFaultOnce {
  attempted = false;
  run(request: any, evidence: any, nonce: string, killExactChild: () => boolean, now = Date.now()) {
    assert.equal(this.attempted, false, 'Observer fault must never be retried');
    validateOwnedObserverFault(request, evidence, nonce, now);
    this.attempted = true; // Even a throw/false result leaves this latched.
    assert.equal(killExactChild(), true, 'Observer termination request was not accepted; outcome unknown, no retry');
    return { requested: true, exitConfirmed: false, generation: request.generation, epoch: request.epoch, childPid: request.childPid };
  }
}
