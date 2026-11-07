export const PROFILE_FILE_PROCESS_CHANGED = 'PROFILE_FILE_PROCESS_CHANGED';
export type ProfileProcessChangeStage = 'windows_rm_pid_join' | 'posix_lsof_pid_join' | 'profile_runtime_pid_join'
  | 'windows_rm_birth_join' | 'windows_parent_identity' | 'profile_runtime_birth_join';
export interface ProfileProcessChangeDetails {
  origin: 'profile_command' | 'restart_manager' | 'parent_chain' | 'runtime_profile' | 'restart_manager_batch';
  reason: 'unavailable' | 'invalid_birth' | 'birth_mismatch' | 'parent_newer' | 'batch_conflict';
  identityReason?: 'not_pinned' | 'open_failed' | 'birth_failed' | 'exited' | 'wait_failed';
}
export interface ProfileProcessChangeDiagnostic extends Partial<ProfileProcessChangeDetails> {
  code: typeof PROFILE_FILE_PROCESS_CHANGED;
  stage: ProfileProcessChangeStage;
  pid: number;
  processCount: number;
  snapshotId?: string;
  capturedAt?: number;
}
const stages = new Set<ProfileProcessChangeStage>(['windows_rm_pid_join', 'posix_lsof_pid_join', 'profile_runtime_pid_join',
  'windows_rm_birth_join', 'windows_parent_identity', 'profile_runtime_birth_join']);
const keys = new Set(['code', 'stage', 'pid', 'processCount', 'snapshotId', 'capturedAt', 'origin', 'reason', 'identityReason']);
const detailKeys = new Set(['origin', 'reason', 'identityReason']);
const identityReasons = new Set(['not_pinned', 'open_failed', 'birth_failed', 'exited', 'wait_failed']);
const detailRules = {
  profile_command: { stage: 'windows_rm_birth_join', reasons: ['unavailable', 'invalid_birth'] },
  restart_manager: { stage: 'windows_rm_birth_join', reasons: ['unavailable', 'invalid_birth', 'birth_mismatch'] },
  parent_chain: { stage: 'windows_parent_identity', reasons: ['unavailable', 'invalid_birth', 'parent_newer'] },
  runtime_profile: { stage: 'profile_runtime_birth_join', reasons: ['unavailable', 'invalid_birth', 'birth_mismatch'] },
  restart_manager_batch: { stage: 'windows_rm_birth_join', reasons: ['batch_conflict'] }
} as const;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

// Inspect data properties without evaluating provider-controlled getters.
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function copyDetails(value: unknown, stage: unknown): ProfileProcessChangeDetails | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const properties = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if (properties.some(key => typeof key !== 'string' || !detailKeys.has(key) || !('value' in descriptors[key]))) return;
    const origin = own(value, 'origin'), reason = own(value, 'reason'), identityReason = own(value, 'identityReason');
    if (typeof origin !== 'string' || !Object.hasOwn(detailRules, origin)) return;
    const rule = detailRules[origin as keyof typeof detailRules];
    if (rule.stage !== stage || !(rule.reasons as readonly unknown[]).includes(reason)) return;
    if (properties.includes('identityReason') && (reason !== 'unavailable' || !identityReasons.has(identityReason as string))) return;
    return { origin: origin as ProfileProcessChangeDetails['origin'], reason: reason as ProfileProcessChangeDetails['reason'],
      ...(identityReason === undefined ? {} : { identityReason: identityReason as ProfileProcessChangeDetails['identityReason'] }) };
  } catch { return; }
}
export function copyProfileProcessChange(value: unknown): ProfileProcessChangeDiagnostic | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const properties = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if (properties.some(key => typeof key !== 'string' || !keys.has(key) || !('value' in descriptors[key]))) return;
    const code = own(value, 'code'), stage = own(value, 'stage'), pid = own(value, 'pid'), processCount = own(value, 'processCount');
    const snapshotId = own(value, 'snapshotId'), capturedAt = own(value, 'capturedAt');
    if (code !== PROFILE_FILE_PROCESS_CHANGED || !stages.has(stage as ProfileProcessChangeStage) ||
        !Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 0xffffffff ||
        !Number.isSafeInteger(processCount) || Number(processCount) < 0 || Number(processCount) > 1_000_000 ||
        properties.includes('snapshotId') && !uuid(snapshotId) || properties.includes('capturedAt') && !timestamp(capturedAt)) return;
    const hasDetails = properties.some(key => typeof key === 'string' && detailKeys.has(key));
    const details = hasDetails ? copyDetails(Object.fromEntries([...detailKeys].filter(key => properties.includes(key)).map(key => [key, own(value, key)])), stage) : undefined;
    if (hasDetails && !details) return;
    return { code, stage: stage as ProfileProcessChangeStage, pid: pid as number, processCount: processCount as number, ...details,
      ...(snapshotId === undefined ? {} : { snapshotId: snapshotId as string }), ...(capturedAt === undefined ? {} : { capturedAt: capturedAt as number }) };
  } catch { return undefined; }
}
export function readProfileProcessChangeError(error: unknown): ProfileProcessChangeDiagnostic | undefined {
  if (own(error, 'message') !== PROFILE_FILE_PROCESS_CHANGED || own(error, 'code') !== PROFILE_FILE_PROCESS_CHANGED) return;
  return copyProfileProcessChange(own(error, 'profileProcessChange'));
}
export function profileFileProcessChanged(stage: ProfileProcessChangeStage, pid: number, processCount: number,
  discovery?: { snapshotId?: unknown; capturedAt?: unknown }, details?: ProfileProcessChangeDetails): Error & { code: string; profileProcessChange?: ProfileProcessChangeDiagnostic } {
  const error = Object.assign(new Error(PROFILE_FILE_PROCESS_CHANGED), { code: PROFILE_FILE_PROCESS_CHANGED });
  const snapshotId = own(discovery, 'snapshotId'), capturedAt = own(discovery, 'capturedAt');
  const diagnostic = copyProfileProcessChange({ code: PROFILE_FILE_PROCESS_CHANGED, stage, pid, processCount,
    ...(uuid(snapshotId) ? { snapshotId } : {}), ...(timestamp(capturedAt) ? { capturedAt } : {}), ...copyDetails(details, stage) });
  // Metadata is optional. Never read the clock or turn a malformed diagnostic
  // into a different failure of the original strict PID-membership check.
  return diagnostic ? Object.assign(error, { profileProcessChange: Object.freeze(diagnostic) }) : error;
}
