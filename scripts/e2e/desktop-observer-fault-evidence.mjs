import assert from 'node:assert/strict';

// Pure receipt matching. These are the current production broker subscriptions
// that can report disconnected. A closed pipe is not process-exit proof: the
// separate final observer-exit receipt below remains mandatory.
const disconnectSources = new Set(['stdout:end', 'stdout:close', 'stdout:error', 'stderr:error']);
export function evaluateOwnedObserverExitEvidence(events, expected) {
  assert.ok(Array.isArray(events));
  const attempt = events.find(value => value.kind === 'fault-attempt' && value.childPid === expected.childPid
    && value.generation === expected.generation && value.epoch === expected.epoch);
  assert.ok(attempt, 'Missing exact owned termination attempt receipt');
  const pause = events.find(value => value.sequence > attempt.sequence && value.kind === 'service-state' && value.state === 'paused'
    && value.phase === 'paused' && value.generation === expected.generation && value.epoch === expected.epoch);
  assert.ok(pause && pause.certainty === 'unknown' && ['helper_exited', 'disconnected'].includes(pause.reason), 'Pause does not match the expected owned observer loss');
  const source = events.find(value => value.sequence > attempt.sequence && value.sequence < pause.sequence && value.childPid === expected.childPid
    && (pause.reason === 'helper_exited' ? ['observer-exit', 'observer-close'].includes(value.kind)
      : value.kind === 'observer-transport' && disconnectSources.has(value.source)));
  assert.ok(source, 'Pause lacks a preceding matching owned transport failure receipt');
  const exited = events.find(value => value.sequence > attempt.sequence && value.kind === 'observer-exit' && value.childPid === expected.childPid);
  assert.ok(exited, 'Owned observer process exit was not eventually confirmed');
  return { reason: pause.reason, certainty: pause.certainty, source: source.source || source.kind,
    sourceSequence: source.sequence, pauseSequence: pause.sequence, exitSequence: exited.sequence,
    order: exited.sequence < pause.sequence ? 'exit-before-pause' : 'transport-before-pause-before-exit' };
}
