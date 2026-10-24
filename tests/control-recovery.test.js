const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { controlRecovery, parseControlRecovery } = loadCli('src/shared/control-recovery.ts');
const { NativeControlError, nativeFailurePayload } = loadCli('src/main/native-control/errors.ts');

test('recovery preserves uncertain execution and never automatically replays an interrupted input', () => {
  for (const code of ['NATIVE_TIMEOUT_UNCERTAIN', 'NATIVE_DISCONNECTED', 'NATIVE_DEBUGGER_DETACHED', 'NATIVE_DEBUGGER_RECOVERED', 'PHONE_REJECTED']) {
    const result = controlRecovery(code);
    assert.equal(result.actionOutcome, 'unknown'); assert.equal(result.automaticReplay, false);
  }
  assert.equal(controlRecovery('NATIVE_USER_IN_CONTROL').requiresUser, true);
  assert.equal(controlRecovery('NATIVE_EXTENSION_FRAME_CONFLICT').requiresUser, false);
  assert.equal(controlRecovery('NATIVE_OBSERVATION_STALE').actionOutcome, 'not-executed');
  assert.equal(controlRecovery('NATIVE_DEBUGGER_RECOVERED').requiresUser, false);
  assert.equal(controlRecovery('NATIVE_DEBUGGER_RECOVERED').nextStep, 'reobserve');
});

test('validated recovery survives JSON transport with request correlation', () => {
  const error = new NativeControlError('NATIVE_RENDER_UNAVAILABLE', 'paint timeout', controlRecovery('NATIVE_RENDER_UNAVAILABLE', { actionOutcome: 'completed' }));
  error.requestId = 'scroll-1'; error.sessionId = 'owner';
  const payload = JSON.parse(JSON.stringify(nativeFailurePayload(error)));
  assert.equal(payload.requestId, 'scroll-1'); assert.equal(payload.sessionId, 'owner');
  assert.equal(parseControlRecovery(payload.recovery).actionOutcome, 'completed');
  assert.equal(parseControlRecovery({ ...payload.recovery, automaticReplay: true }), undefined);
});
