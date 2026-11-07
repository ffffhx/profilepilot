import type { DesktopWindow } from '../../shared/desktop';
import type { ExternalChromeInstance, PublicProfile } from '../../shared/types';
import type { LocalAppView } from '../../shared/local-apps';
import type { NativeBrowserState } from '../../shared/browser-connection';
import type { GatewayProfileBinding } from '../browser-gateway-control';
import type { ControlDiscovery } from '../process-scan';
import type { DesktopAppControlConfig, DesktopAppsControlSnapshot } from './apps-discovery';
import { appProcessPaths } from '../local-apps/service-runtime';
import { PROFILE_FILE_PROCESS_CHANGED, copyProfileProcessChange, readProfileProcessChangeError, type ProfileProcessChangeDiagnostic } from '../profile-process-change';

export type AdmissionSnapshot<T> =
  | { state: 'ready'; value: T; capturedAt: number; complete?: boolean; gaps?: readonly string[] }
  | { state: 'unavailable'; reason: string; lastKnown?: T; processIssue?: ProfileProcessChangeDiagnostic };
export type AdmissionProfile = Pick<PublicProfile, 'id' | 'source' | 'pids' | 'browserPids' | 'cdpPort' | 'fixedCdpPort' | 'gatewayControl' | 'agentBrowserOccupancy' | 'cdpClients'>;
export type AdmissionExternal = Pick<ExternalChromeInstance, 'pid' | 'cdpPort' | 'cdpClients'>;
export type AdmissionLocalApp = Pick<LocalAppView, 'id' | 'agentPort' | 'runtime' | 'agent'> & Partial<DesktopAppControlConfig>;
export interface DesktopAdmissionApps {
  applications: readonly AdmissionLocalApp[];
  control?: DesktopAppsControlSnapshot;
}
export interface DesktopAdmissionCatalog {
  profiles: readonly AdmissionProfile[];
  externalInstances: readonly AdmissionExternal[];
  discovery: ControlDiscovery;
}
export interface DesktopAdmissionGateway { profiles: readonly GatewayProfileBinding[]; ports: readonly number[] }
export interface DesktopAdmissionSnapshots {
  catalog: AdmissionSnapshot<DesktopAdmissionCatalog>;
  gateway: AdmissionSnapshot<DesktopAdmissionGateway>;
  native: AdmissionSnapshot<readonly NativeBrowserState[]>;
  apps: AdmissionSnapshot<readonly AdmissionLocalApp[] | DesktopAdmissionApps>;
}
export interface DesktopAdmissionReadContext {
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly signal: AbortSignal;
}
export type DesktopAdmissionProviders = { [K in keyof DesktopAdmissionSnapshots]: (context: DesktopAdmissionReadContext) => DesktopAdmissionSnapshots[K] | Promise<DesktopAdmissionSnapshots[K]> };
export interface DesktopAdmissionMatch {
  profileId: string;
  source: 'gateway' | 'native' | 'legacy' | 'local-app' | 'external';
  state: 'available' | 'occupied' | 'unknown';
  reason: string;
  ownerSessionId?: string;
  ownership?: 'agent' | 'user';
  generation?: number | string;
}
export interface DesktopAdmissionDecision {
  // unmanaged is intentionally not an automatic permission. Main chooses the
  // policy for a target with no known association after complete discovery.
  status: 'available' | 'occupied' | 'unknown' | 'unmanaged';
  reason: string;
  code?: 'DESKTOP_TARGET_OCCUPIED' | 'DESKTOP_ADMISSION_UNKNOWN';
  matches: DesktopAdmissionMatch[];
  gaps: string[];
  // Bounded reason codes for doctor/claim diagnostics. No application names,
  // commands, paths, environment values or arbitrary provider errors.
  appIssues?: { appId: string; reasons: string[] }[];
  appIssuesTruncated?: boolean;
  // Current failed sample only; never derived from the last-known catalog.
  providerIssues?: (ProfileProcessChangeDiagnostic & { source: keyof DesktopAdmissionSnapshots })[];
}
type Source = keyof DesktopAdmissionSnapshots;
type Read<T> = { value?: T; fresh: boolean; gap?: string };
type Relation = { id: string; profiles: AdmissionProfile[]; apps: AdmissionLocalApp[]; external: AdmissionExternal[]; gateway: GatewayProfileBinding[] };
const sources: Source[] = ['catalog', 'gateway', 'native', 'apps'];
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const port = (value: unknown): value is number => positive(value) && value <= 65535;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const owner = (value: unknown): value is 'agent' | 'user' => value === 'agent' || value === 'user';
const issue = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : 'unavailable';
const processPids = (profile: AdmissionProfile): number[] => [...(Array.isArray(profile.pids) ? profile.pids : []), ...(Array.isArray(profile.browserPids) ? profile.browserPids : [])];
const validPids = (value: unknown): value is number[] => Array.isArray(value) && value.every(positive) && new Set(value).size === value.length;
function snapshotProcessIssue(snapshot: unknown): ProfileProcessChangeDiagnostic | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, 'processIssue');
    return copyProfileProcessChange(descriptor && 'value' in descriptor ? descriptor.value : undefined);
  } catch { return undefined; }
}

function read<T>(name: Source, snapshot: AdmissionSnapshot<T> | undefined, now: number, maxAge: number): Read<T> {
  if (!snapshot) return { fresh: false, gap: `${name}:missing_provider` };
  if (snapshot.state === 'unavailable') return { value: snapshot.lastKnown, fresh: false, gap: `${name}:${issue(snapshot.reason)}` };
  if (snapshot.state !== 'ready') return { fresh: false, gap: `${name}:invalid_snapshot` };
  if (!Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt > now || now - snapshot.capturedAt > maxAge)
    return { value: snapshot.value, fresh: false, gap: `${name}:stale_snapshot` };
  if (snapshot.complete === false || snapshot.gaps?.length)
    return { value: snapshot.value, fresh: false, gap: `${name}:incomplete_snapshot` };
  return { value: snapshot.value, fresh: true };
}

/** Pure, point-in-time checks only. No title/class/executable-name inference,
 * session-name bypass, service startup, input or ownership mutation occurs here.
 * Providers must report scan failures/incomplete PID discovery explicitly; an
 * empty array cannot stand for an unavailable service. This check is not an
 * atomic reservation against a later browser/Electron claim. */
export function evaluateDesktopAdmission(
  target: Pick<DesktopWindow, 'pid'>,
  snapshots: DesktopAdmissionSnapshots,
  options: { now?: number; maxAgeMs?: number; controlMaxAgeMs?: number } = {}
): DesktopAdmissionDecision {
  const matches: DesktopAdmissionMatch[] = [], gaps = new Set<string>();
  const appIssues: NonNullable<DesktopAdmissionDecision['appIssues']> = [];
  let appIssuesTruncated = false;
  const providerIssues: NonNullable<DesktopAdmissionDecision['providerIssues']> = [];
  for (const source of sources) try {
    const snapshot = snapshots?.[source];
    if (snapshot?.state !== 'unavailable' || snapshot.reason !== PROFILE_FILE_PROCESS_CHANGED) continue;
    const diagnostic = snapshotProcessIssue(snapshot);
    if (diagnostic) providerIssues.push({ source, ...diagnostic });
  } catch { /* Optional diagnostic metadata never changes the admission result. */ }
  let discoveryUncertain = false;
  const discoveryGap = (reason: string) => { gaps.add(reason); discoveryUncertain = true; };
  const finish = (status: DesktopAdmissionDecision['status'], reason: string): DesktopAdmissionDecision => ({
    status, reason, ...(status === 'occupied' ? { code: 'DESKTOP_TARGET_OCCUPIED' as const } : status === 'unknown' ? { code: 'DESKTOP_ADMISSION_UNKNOWN' as const } : {}),
    matches, gaps: [...gaps].sort(), ...(appIssues.length ? { appIssues } : {}), ...(appIssuesTruncated ? { appIssuesTruncated: true } : {}),
    ...(providerIssues.length ? { providerIssues } : {})
  });
  const now = options.now ?? Date.now(), maxAge = options.maxAgeMs ?? 5000, controlMaxAge = options.controlMaxAgeMs ?? maxAge;
  if (!positive(target?.pid) || !Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(controlMaxAge) || controlMaxAge < 0)
    return finish('unknown', 'invalid_check_input');
  const catalog = read('catalog', snapshots?.catalog, now, maxAge);
  const gateway = read('gateway', snapshots?.gateway, now, controlMaxAge);
  const native = read('native', snapshots?.native, now, controlMaxAge);
  const apps = read('apps', snapshots?.apps, now, maxAge);
  // These three sources establish PID associations. The extension source has
  // no OS PID and is consulted only after joining a native Profile identity.
  for (const source of [catalog, gateway, apps]) if (source.gap) gaps.add(source.gap);
  const profiles = Array.isArray(catalog.value?.profiles) ? catalog.value.profiles : [];
  const external = Array.isArray(catalog.value?.externalInstances) ? catalog.value.externalInstances : [];
  const bindings = Array.isArray(gateway.value?.profiles) ? gateway.value.profiles : [];
  const ports = Array.isArray(gateway.value?.ports) ? gateway.value.ports : [];
  const appsValue = apps.value as DesktopAdmissionApps | undefined;
  const applications: readonly AdmissionLocalApp[] = Array.isArray(apps.value) ? apps.value : Array.isArray(appsValue?.applications) ? appsValue.applications : [];
  const states = Array.isArray(native.value) ? native.value : [];
  if ((catalog.fresh || catalog.value !== undefined) && (!Array.isArray(catalog.value?.profiles) || !Array.isArray(catalog.value?.externalInstances))) gaps.add('catalog:invalid_rows');
  const discovery = catalog.value?.discovery;
  let processUniverse: Set<number> | undefined;
  if (catalog.fresh || catalog.value !== undefined) {
    if (!discovery || !text(discovery.snapshotId) || discovery.complete !== true ||
      !validPids(discovery.processPids) || !discovery.processPids.length || !Array.isArray(discovery.scopedGaps)) {
      discoveryGap('catalog:invalid_discovery');
    } else {
      // Checking both timestamps preserves the earliest sampling boundary.
      // A provider must not make a reused catalog fresh by wrapping it again.
      if (!Number.isFinite(discovery.capturedAt) || discovery.capturedAt > now || now - discovery.capturedAt > maxAge)
        discoveryGap('catalog:stale_discovery');
      const universe = new Set(discovery.processPids);
      if (catalog.fresh && Number.isFinite(discovery.capturedAt) && discovery.capturedAt <= now && now - discovery.capturedAt <= maxAge)
        processUniverse = universe;
      if (!universe.has(target.pid)) discoveryGap('catalog:target_process_not_observed');
      for (const gap of discovery.scopedGaps) {
        if (!gap || gap.code !== 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE' || !validPids(gap.processPids) ||
          !gap.processPids.length || gap.processPids.some(pid => !universe.has(pid))) {
          discoveryGap('catalog:invalid_scoped_gap'); continue;
        }
        if (gap.processPids.includes(target.pid)) discoveryGap(`catalog:${gap.code}`);
      }
    }
  }
  if ((gateway.fresh || gateway.value !== undefined) && (!Array.isArray(gateway.value?.profiles) || !Array.isArray(gateway.value?.ports))) gaps.add('gateway:invalid_rows');
  if ((apps.fresh || apps.value !== undefined) && !Array.isArray(apps.value) && !Array.isArray(appsValue?.applications)) gaps.add('apps:invalid_rows');
  const control = appsValue?.control;
  const appUnique = (app: AdmissionLocalApp) => applications.filter(row => row?.id === app.id ||
    (port(app.agentPort) && row?.agentPort === app.agentPort)).length === 1;
  // A fresh, unambiguous existing Gateway identity can locate a runtime-unknown
  // app without declaring its runtime healthy. Targets at that PID still join
  // the app's unknown row below and remain denied.
  const gatewayAppPid = (app: AdmissionLocalApp, reasons: string[]): number | undefined => {
    const fail = (reason: string): undefined => { reasons.push(reason); return; };
    if (!apps.fresh) return fail('apps_snapshot_unavailable');
    if (!gateway.fresh) return fail('gateway_snapshot_unavailable');
    if (!processUniverse || discoveryUncertain) return fail('catalog_discovery_unavailable');
    if (!port(app.agentPort)) return fail('gateway_app_port_missing');
    if (!appUnique(app)) return fail('app_identity_ambiguous');
    const id = `local-app:${app.id}`;
    const related = bindings.filter(row => row && (row.profileId === id || row.publicPort === app.agentPort));
    if (related.length !== 1) return fail(related.length ? 'gateway_binding_ambiguous' : 'gateway_binding_missing');
    const row = related[0];
    if (row.profileId !== id || row.publicPort !== app.agentPort) return fail('gateway_app_identity_mismatch');
    if (!positive(row.chromePid)) return fail('gateway_app_pid_missing');
    if (!processUniverse.has(row.chromePid)) return fail('gateway_app_pid_not_observed');
    if (bindings.filter(other => other?.chromePid === row.chromePid).length !== 1) return fail('gateway_app_pid_ambiguous');
    return row.chromePid;
  };
  const appRouteUnoccupied = (app: AdmissionLocalApp, reasons: string[]): boolean => {
    const fail = (reason: string): false => { reasons.push(reason); return false; };
    if (!apps.fresh) return fail('apps_snapshot_unavailable');
    if (!gateway.fresh) return fail('gateway_snapshot_unavailable');
    if (!processUniverse || discoveryUncertain) return fail('catalog_discovery_unavailable');
    if (!appUnique(app)) return fail('app_identity_ambiguous');
    if (!control) return fail('control_snapshot_missing');
    if (control.complete !== true || control.gaps?.length) {
      const known = new Set(['invalid_timestamp', 'processes_unavailable', 'processes_incomplete', 'tcp_unavailable', 'tcp_incomplete',
        'invalid_process_rows', 'invalid_tcp_rows', 'invalid_tcp_row', 'listener_process_unresolved', 'invalid_app_config', 'invalid_app_ports']);
      for (const gap of Array.isArray(control.gaps) ? control.gaps : []) if (known.has(gap)) reasons.push(`control_${gap}`);
      return fail('control_snapshot_incomplete');
    }
    if (!Number.isFinite(control.capturedAt) || control.capturedAt > now || now - control.capturedAt > maxAge) return fail('control_snapshot_stale');
    if (!validPids(control.processPids) || !control.processPids.length || !Array.isArray(control.applications)) return fail('control_snapshot_invalid');
    if (!control.processPids.includes(target.pid)) return fail('control_target_pid_not_observed');
    const related = control.applications.filter(row => row?.id === app.id);
    if (related.length !== 1) return fail(related.length ? 'control_app_ambiguous' : 'control_app_missing');
    const row = related[0];
    // Attach registrations may retain descriptive/non-path command text.
    // Recompute identity using the collector's pure parser so such text is not
    // mistaken for a process identity, and changed actual paths still deny.
    if (app.mode !== 'attach' || typeof app.command !== 'string' || typeof app.cwd !== 'string' || row.mode !== 'attach' || row.identity !== 'none')
      return fail('control_route_not_unidentified_attach');
    if (appProcessPaths({ id: app.id, mode: app.mode, command: app.command, cwd: app.cwd,
      cdpPort: app.cdpPort ?? null, inspectPort: app.inspectPort ?? null, name: '', environment: '', createdAt: '' }, 'win32').length)
      return fail('control_route_not_unidentified_attach');
    if (row.agentPort !== (app.agentPort ?? null)) return fail('control_agent_port_changed');
    if (!Array.isArray(row.routePorts) || !row.routePorts.length || !row.routePorts.every(port) || new Set(row.routePorts).size !== row.routePorts.length ||
      !Array.isArray(row.listeners) || !validPids(row.candidatePids)) return fail('control_app_evidence_invalid');
    if (row.listeners.length || row.candidatePids.length) return fail('control_route_listener_present');
    const configuredPorts = [app.cdpPort, app.inspectPort];
    if (configuredPorts.some(value => value != null && !port(value)) ||
      [...new Set(configuredPorts.filter(port))].sort((a, b) => a - b).join(',') !== [...row.routePorts].sort((a, b) => a - b).join(',')) return fail('control_backend_ports_changed');
    // Cached affirmative state is a conflict, not an authoritative idle proof.
    if (app.agent && app.agent.connected !== false) return fail('app_agent_connection_unknown_or_active');
    if (app.agent && (app.agent.sessionId !== undefined || app.agent.connectionActive === true || app.agent.ownership === 'agent')) return fail('app_agent_owner_conflict');
    const associatedPorts = [...row.routePorts, ...(port(app.agentPort) ? [app.agentPort] : [])];
    if (bindings.some(binding => binding?.profileId === `local-app:${app.id}` || associatedPorts.includes(binding?.publicPort))) return fail('control_gateway_binding_present');
    if (ports.some(value => associatedPorts.includes(value))) return fail('control_gateway_route_present');
    return true;
  };
  const relations = new Map<string, Relation>();
  const relation = (id: string): Relation => {
    let value = relations.get(id);
    if (!value) { value = { id, profiles: [], apps: [], external: [], gateway: [] }; relations.set(id, value); }
    return value;
  };
  for (const binding of bindings) {
    if (!binding || !text(binding.profileId) || !port(binding.publicPort) || (binding.chromePid !== undefined && !positive(binding.chromePid))) {
      gaps.add('gateway:invalid_binding'); continue;
    }
    if (binding.chromePid === target.pid) relation(binding.profileId).gateway.push(binding);
  }
  for (const profile of profiles) {
    if (!profile || !text(profile.id) || !Array.isArray(profile.pids) || (profile.browserPids !== undefined && !Array.isArray(profile.browserPids)) || processPids(profile).some(pid => !positive(pid))) {
      gaps.add('catalog:invalid_profile'); continue;
    }
    if (processPids(profile).includes(target.pid)) relation(profile.id).profiles.push(profile);
  }
  for (const app of applications) {
    if (!app || !text(app.id) || !app.runtime || (app.runtime.pid !== null && !positive(app.runtime.pid))) { gaps.add('apps:invalid_runtime'); continue; }
    if (app.runtime.pid === target.pid) relation(`local-app:${app.id}`).apps.push(app);
    else if (app.runtime.pid === null && !['stopped', 'failed'].includes(app.runtime.status)) {
      const reasons: string[] = [];
      const gatewayPid = gatewayAppPid(app, reasons);
      if (gatewayPid === target.pid) relation(`local-app:${app.id}`).apps.push(app);
      else if (gatewayPid === undefined && !appRouteUnoccupied(app, reasons)) {
        gaps.add('apps:unresolved_process');
        if (appIssues.length < 100) appIssues.push({ appId: /^[a-zA-Z0-9_.:-]{1,128}$/.test(app.id) ? app.id : 'invalid-app-id', reasons: [...new Set(reasons)] });
        else appIssuesTruncated = true;
      }
    }
  }
  for (const item of external) {
    if (!item || !positive(item.pid)) { gaps.add('catalog:invalid_external_process'); continue; }
    if (item.pid !== target.pid) continue;
    const linked = bindings.filter(binding => binding && port(item.cdpPort) && binding.publicPort === item.cdpPort);
    const id = linked.length === 1 ? linked[0].profileId : `external-pid:${item.pid}`;
    if (!text(id)) { gaps.add('catalog:invalid_external_binding'); continue; }
    relation(id).external.push(item);
  }
  for (const binding of bindings) if (binding && text(binding.profileId) && !positive(binding.chromePid)) {
    const mapped = profiles.some(profile => profile?.id === binding.profileId && processPids(profile).some(positive)) ||
      applications.some(app => app && `local-app:${app.id}` === binding.profileId && positive(app.runtime?.pid)) ||
      external.some(item => item && port(item.cdpPort) && item.cdpPort === binding.publicPort && positive(item.pid));
    if (!mapped) gaps.add('gateway:unresolved_process');
  }
  for (const profile of profiles) if (profile && !processPids(profile).some(positive) &&
    (profile.agentBrowserOccupancy || profile.gatewayControl?.ownerSessionId)) {
    const mapped = bindings.some(binding => binding?.profileId === profile.id && positive(binding.chromePid));
    if (!mapped) gaps.add('catalog:owner_pid_unresolved');
  }
  // A known extension owner whose Profile PID discovery failed must not become
  // "unmanaged" merely because the collector swallowed a process-scan error.
  for (const state of states) if (state && text(state.ownerSessionId)) {
    const mapped = profiles.filter(profile => profile?.id === state.profileId);
    if (!mapped.length || !mapped.some(profile => Array.isArray(profile.pids) && processPids(profile).some(positive))) gaps.add('native:owner_pid_unresolved');
  }
  const add = (r: Relation, source: DesktopAdmissionMatch['source'], state: DesktopAdmissionMatch['state'], reason: string, detail: Partial<DesktopAdmissionMatch> = {}) =>
    matches.push({ profileId: r.id, source, state, reason, ...detail });
  for (const r of relations.values()) {
    // Correlate an already identified process with authoritative owner state.
    const selectedPorts = new Set<number>();
    for (const profile of r.profiles) { if (port(profile.cdpPort)) selectedPorts.add(profile.cdpPort); else if (port(profile.fixedCdpPort)) selectedPorts.add(profile.fixedCdpPort); }
    for (const app of r.apps) if (port(app.agentPort)) selectedPorts.add(app.agentPort);
    for (const item of r.external) if (port(item.cdpPort)) selectedPorts.add(item.cdpPort);
    const related = bindings.filter(binding => binding && (binding.profileId === r.id || selectedPorts.has(binding.publicPort)));
    r.gateway = [...new Set([...r.gateway, ...related])];
    if (r.profiles.length > 1 || r.apps.length > 1 || r.external.length > 1 || selectedPorts.size > 1 || r.gateway.length > 1 || r.gateway.some(binding => binding.profileId !== r.id)) {
      add(r, 'gateway', 'unknown', 'ambiguous_binding'); continue;
    }
    const binding = r.gateway[0];
    if (binding) {
      const detail: Partial<DesktopAdmissionMatch> = {
        ...(text(binding.ownerSessionId) ? { ownerSessionId: binding.ownerSessionId } : {}),
        ...(owner(binding.ownership) ? { ownership: binding.ownership } : {}),
        ...(positive(binding.controlGeneration) ? { generation: binding.controlGeneration } : {})
      };
      if (!gateway.fresh) add(r, 'gateway', 'unknown', 'gateway_unavailable', detail);
      else if (binding.chromePid !== undefined && binding.chromePid !== target.pid) add(r, 'gateway', 'unknown', 'target_pid_changed', detail);
      else if (!ports.includes(binding.publicPort)) add(r, 'gateway', 'unknown', 'gateway_route_disconnected', detail);
      else if (!owner(binding.ownership) || !['active', 'stopped'].includes(binding.sessionStatus) || !positive(binding.controlGeneration)) add(r, 'gateway', 'unknown', 'invalid_gateway_control', detail);
      else if (binding.sessionStatus === 'active' && text(binding.ownerSessionId)) add(r, 'gateway', 'occupied', binding.ownership === 'user' ? 'gateway_user_control' : 'gateway_owner_active', detail);
      else if (binding.sessionStatus === 'active' || text(binding.ownerSessionId)) add(r, 'gateway', 'unknown', 'inconsistent_gateway_owner', detail);
      else add(r, 'gateway', 'available', 'gateway_has_no_owner', detail);
    }
    for (const profile of r.profiles) {
      if (!catalog.fresh) { add(r, 'legacy', 'unknown', 'profile_discovery_unavailable'); continue; }
      const nativeStates = states.filter(state => state?.profileId === profile.id);
      if (profile.source === 'native' || nativeStates.length) {
        if (!native.fresh || !Array.isArray(native.value)) { if (native.gap) gaps.add(native.gap); add(r, 'native', 'unknown', 'native_state_unavailable'); }
        else if (nativeStates.length !== 1) add(r, 'native', 'unknown', nativeStates.length ? 'ambiguous_native_state' : 'native_state_missing');
        else {
          const state = nativeStates[0], detail: Partial<DesktopAdmissionMatch> = {
            ...(text(state.ownerSessionId) ? { ownerSessionId: state.ownerSessionId } : {}),
            ...(owner(state.ownership) ? { ownership: state.ownership } : {}),
            ...(text(state.controlGeneration) ? { generation: state.controlGeneration } : {})
          };
          if (state.connected !== true || state.controlIssue) add(r, 'native', 'unknown', 'native_disconnected_or_interrupted', detail);
          else if (!owner(state.ownership)) add(r, 'native', 'unknown', 'invalid_native_control', detail);
          else if (text(state.ownerSessionId)) add(r, 'native', 'occupied', state.ownership === 'user' || state.pausedByBrowser ? 'native_user_control' : 'native_owner_active', detail);
          else if (state.ownership === 'agent' || state.pausedByBrowser) add(r, 'native', 'unknown', 'inconsistent_native_owner', detail);
          else add(r, 'native', 'available', 'native_has_no_owner', detail);
        }
      }
      // Gateway state is authoritative for its managed port; a stale legacy
      // lease cannot override an explicit current stopped/no-owner binding.
      if (binding) continue;
      if (profile.gatewayControl) { add(r, 'gateway', 'unknown', 'gateway_binding_missing'); continue; }
      if (profile.agentBrowserOccupancy) {
        const lease = profile.agentBrowserOccupancy;
        if (!text(lease.session) || !owner(lease.ownership)) add(r, 'legacy', 'unknown', 'invalid_legacy_lease');
        else add(r, 'legacy', 'occupied', lease.ownership === 'user' ? 'legacy_user_control' : 'legacy_owner_active', { ownerSessionId: lease.session, ownership: lease.ownership });
      } else if (!Array.isArray(profile.cdpClients) || profile.cdpClients.length) add(r, 'legacy', 'unknown', 'legacy_clients_without_owner');
      else if (profile.source !== 'native') add(r, 'legacy', 'available', 'legacy_has_no_owner');
    }
    for (const app of r.apps) {
      if (!apps.fresh || app.runtime.status !== 'running') { add(r, 'local-app', 'unknown', 'app_runtime_unavailable'); continue; }
      if (binding) continue;
      if (port(app.agentPort) || app.agent?.sessionId || app.agent?.connected) add(r, 'local-app', 'unknown', 'app_gateway_binding_missing');
      else add(r, 'local-app', 'available', 'app_has_no_agent_route');
    }
    for (const item of r.external) {
      if (!catalog.fresh) add(r, 'external', 'unknown', 'external_discovery_unavailable');
      else if (!binding) add(r, 'external', 'unknown', 'external_control_state_unresolved');
    }
  }
  if (relations.size > 1) return finish('unknown', 'ambiguous_target_mapping');
  if (matches.some(match => match.state === 'unknown')) return finish('unknown', 'associated_control_unknown');
  if (discoveryUncertain) return finish('unknown', 'mapping_incomplete');
  if (matches.some(match => match.state === 'occupied')) return finish('occupied', 'associated_control_occupied');
  if (gaps.size) return finish('unknown', 'mapping_incomplete');
  if (!relations.size) return finish('unmanaged', 'no_known_process_association');
  return matches.length ? finish('available', 'associated_controls_idle') : finish('unknown', 'associated_control_missing');
}

/** Inject only read-only providers. No retry, service construction or startup.
 * A timed-out provider cannot update lastKnown later. Old data identifies a
 * possible association but never becomes a new successful/free observation. */
export function createDesktopAdmission(
  providers: DesktopAdmissionProviders,
  options: { now?: () => number; maxAgeMs?: number; timeoutMs?: number; discoveryFirst?: boolean; controlMaxAgeMs?: number } = {}
): (target: Pick<DesktopWindow, 'pid'>) => Promise<DesktopAdmissionDecision> {
  const lastKnown = new Map<Source, unknown>(), now = options.now ?? Date.now;
  const timeout = options.timeoutMs ?? 2500;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30000) throw new Error('Invalid desktop admission timeout.');
  async function collect<K extends Source>(name: K): Promise<DesktopAdmissionSnapshots[K]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: DesktopAdmissionSnapshots[K];
    const controller = new AbortController();
    const context: DesktopAdmissionReadContext = Object.freeze({ deadlineAt: now() + timeout, now, signal: controller.signal });
    try {
      snapshot = await Promise.race([
        Promise.resolve().then(() => providers[name](context)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('provider_timeout')); }, timeout); })
      ]) as DesktopAdmissionSnapshots[K];
      if (controller.signal.aborted) throw new Error('provider_timeout');
      if (!snapshot || !['ready', 'unavailable'].includes(snapshot.state)) throw new Error('invalid_provider_snapshot');
      if (snapshot.state === 'ready') lastKnown.set(name, structuredClone(snapshot.value));
      else {
        const processIssue = snapshot.reason === PROFILE_FILE_PROCESS_CHANGED ? snapshotProcessIssue(snapshot) : undefined;
        // Do not spread an optional diagnostic getter when adding lastKnown.
        snapshot = { state: 'unavailable', reason: snapshot.reason,
          ...(snapshot.lastKnown === undefined ? {} : { lastKnown: snapshot.lastKnown }), ...(processIssue ? { processIssue } : {}) } as DesktopAdmissionSnapshots[K];
      }
    } catch (error) {
      let message = '';
      try { message = error instanceof Error && typeof error.message === 'string' ? error.message : ''; } catch { /* Unreadable provider error is still unavailable. */ }
      // Strict discovery emits bounded internal reason codes. Preserve those
      // for diagnosis, but never forward arbitrary provider text or file paths.
      const processIssue = readProfileProcessChangeError(error);
      snapshot = { state: 'unavailable', reason: message === 'provider_timeout' ? message : /^PROFILE_[A-Z0-9_]{1,64}$/.test(message) ? message : 'provider_failed',
        ...(processIssue ? { processIssue } : {}) };
    } finally { if (timer) clearTimeout(timer); }
    if (snapshot.state === 'unavailable' && snapshot.lastKnown === undefined && lastKnown.has(name))
      return { ...snapshot, lastKnown: structuredClone(lastKnown.get(name)) } as DesktopAdmissionSnapshots[K];
    return snapshot;
  }
  return async target => {
    let snapshots: DesktopAdmissionSnapshots;
    if (options.discoveryFirst) {
      // Process discovery can take seconds. Sample ownership after it completes
      // so an early idle result is not carried through that delay. This narrows
      // the observation window; it still does not reserve either control route.
      const [catalog, apps] = await Promise.all([collect('catalog'), collect('apps')]);
      const [gateway, native] = await Promise.all([collect('gateway'), collect('native')]);
      snapshots = { catalog, gateway, native, apps };
    } else {
      const [catalog, gateway, native, apps] = await Promise.all(sources.map(name => collect(name)));
      snapshots = { catalog, gateway, native, apps } as DesktopAdmissionSnapshots;
    }
    return evaluateDesktopAdmission(target, snapshots, { now: now(), maxAgeMs: options.maxAgeMs, controlMaxAgeMs: options.controlMaxAgeMs });
  };
}
