const rectangle = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key])) && value.width > 0 && value.height > 0;
const same = (left, right) => ['x', 'y', 'width', 'height'].every(key => left[key] === right[key]);

// Pure acceptance policy. A completed read is a valid sampling outcome, not a
// failed guard. Only observed production geometry rejection establishes this
// stress case; neither a fixture counter nor an error code alone is sufficient.
export function classifyExternalGeometryCapture(response, fixtureAfter) {
  if (response?.ok === true) return { status: 'not_observed', reason: 'capture_completed_without_geometry_rejection' };
  if (response?.ok !== false || response.code !== 'DESKTOP_WINDOW_CHANGED' || response.cause !== 'CAPTURE_WINDOW_CHANGED')
    return { status: 'unexpected_failure', reason: 'unexpected_capture_result' };
  const capture = response.diagnostics?.capture;
  const before = capture?.before, after = capture?.after;
  if (capture?.source !== 'window-state' || capture.status !== 'window_changed' ||
    !rectangle(before?.windowRect) || !rectangle(after?.windowRect) || !rectangle(before?.clientRect) || !rectangle(after?.clientRect))
    return { status: 'not_observed', reason: 'missing_real_geometry_diagnostics' };
  if (same(before.windowRect, after.windowRect) && same(before.clientRect, after.clientRect))
    return { status: 'not_observed', reason: 'rejection_without_geometry_difference' };
  const start = Date.parse(response.captureStartedAt), end = Date.parse(response.captureFinishedAt);
  const stress = fixtureAfter?.geometryStress;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || stress?.source !== 'owned-ui-timer' ||
    typeof stress.runId !== 'string' || !stress.runId || response.geometryStressRunId !== stress.runId ||
    stress.historyTruncated !== false || !Array.isArray(stress.events) || !stress.events.length)
    return { status: 'not_observed', reason: 'missing_external_mutation_evidence' };
  const event = stress.events.find(value => {
    const began = Date.parse(value.startedAt), finished = Date.parse(value.finishedAt);
    return Number.isFinite(began) && Number.isFinite(finished) && began <= finished && began >= start && finished <= end &&
      rectangle(value.before) && rectangle(value.after) && !same(value.before, value.after);
  });
  if (!event) return { status: 'not_observed', reason: 'no_confirmed_geometry_mutation_during_capture' };
  return { status: 'observed', reason: 'production_guard_rejected_changed_geometry', before, after, mutation: event, runId: stress.runId };
}
