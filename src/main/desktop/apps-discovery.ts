import type { LocalAppConfig } from '../../shared/local-apps';
import type { WindowsSystemEvidence, WindowsControlSample } from '../windows-platform';
import { appProcessPaths } from '../local-apps/service-runtime';

/** Configuration is used only during collection. Paths, command lines and
 * environment values must never be copied into admission evidence. */
export type DesktopAppControlConfig = Pick<LocalAppConfig,
  'id' | 'mode' | 'cwd' | 'command' | 'cdpPort' | 'inspectPort' | 'agentPort' | 'servicePort' | 'serviceProcess'>;
export interface DesktopAppControlRoute {
  id: string;
  mode: LocalAppConfig['mode'];
  agentPort: number | null;
  identity: 'none' | 'configured';
  routePorts: number[];
  listeners: { port: number; pid: number }[];
  candidatePids: number[];
}
export interface DesktopAppsControlSnapshot {
  snapshotId?: string;
  capturedAt: number;
  complete: boolean;
  gaps?: readonly string[];
  processPids: number[];
  applications: DesktopAppControlRoute[];
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const port = (value: unknown): value is number => positive(value) && value <= 65535;
const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/** Pure Windows-only route evidence. Callers must record capturedAt BEFORE a
 * forced OS scan, not after a cached/slow read. This describes registered
 * control endpoints, never whether an unidentified application is stopped.
 * PID candidates are listener owners, not inferred executable identities. */
export function buildDesktopAppsControlSnapshot(
  apps: readonly DesktopAppControlConfig[], snapshot: WindowsSystemEvidence, capturedAt: number
): DesktopAppsControlSnapshot {
  const gaps = new Set<string>();
  if (!Number.isFinite(capturedAt)) gaps.add('invalid_timestamp');
  if (snapshot?.processesAvailable !== true) gaps.add('processes_unavailable');
  if (snapshot?.processesComplete !== true) gaps.add('processes_incomplete');
  if (snapshot?.tcpAvailable !== true) gaps.add('tcp_unavailable');
  if (snapshot?.tcpComplete !== true) gaps.add('tcp_incomplete');
  if (!Array.isArray(snapshot?.processes)) gaps.add('invalid_process_rows');
  if (!Array.isArray(snapshot?.tcp)) gaps.add('invalid_tcp_rows');
  const processes = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
  const tcp = Array.isArray(snapshot?.tcp) ? snapshot.tcp : [];
  const processPids = unique(processes.map(row => row?.pid).filter(positive));
  if (!processPids.length || processPids.length !== processes.length) gaps.add('invalid_process_rows');
  const universe = new Set(processPids);
  const listening: { port: number; pid: number }[] = [];
  for (const row of tcp) {
    if (!row || typeof row.state !== 'string' || !['listen', 'established'].includes(row.state.toLowerCase()) ||
      !port(row.localPort) || !Number.isSafeInteger(row.pid) || row.pid < 0) {
      gaps.add('invalid_tcp_row'); continue;
    }
    if (row.state.toLowerCase() !== 'listen') continue;
    if (!positive(row.pid) || !universe.has(row.pid)) gaps.add('listener_process_unresolved');
    listening.push({ port: row.localPort, pid: row.pid });
  }
  const applications: DesktopAppControlRoute[] = [];
  const ids = new Set<string>();
  for (const app of apps) {
    if (!app || typeof app.id !== 'string' || !app.id.trim() || ids.has(app.id) ||
      !['launch', 'attach', 'service'].includes(app.mode) || typeof app.cwd !== 'string' || typeof app.command !== 'string' ||
      (app.agentPort != null && !port(app.agentPort))) { gaps.add('invalid_app_config'); continue; }
    ids.add(app.id);
    const configured = app.mode === 'service' ? [app.servicePort] : [app.cdpPort, app.inspectPort];
    if (configured.some(value => value != null && !port(value))) { gaps.add('invalid_app_ports'); continue; }
    const routePorts = unique(configured.filter(port));
    // A listener on the public Agent endpoint also prevents an empty-route
    // proof, even when the fresh Gateway status has no matching route.
    const associatedPorts = [...routePorts, ...(port(app.agentPort) ? [app.agentPort] : [])];
    const listeners = listening.filter(row => associatedPorts.includes(row.port));
    applications.push({ id: app.id, mode: app.mode, agentPort: app.agentPort ?? null,
      identity: appProcessPaths(app as LocalAppConfig, 'win32').length ? 'configured' : 'none',
      routePorts, listeners, candidatePids: unique(listeners.map(row => row.pid)) });
  }
  return { capturedAt, complete: gaps.size === 0, gaps: [...gaps].sort(), processPids, applications };
}

export function buildDesktopAppsControlFromSample(
  apps: readonly DesktopAppControlConfig[], sample: WindowsControlSample
): DesktopAppsControlSnapshot {
  if (typeof sample?.snapshotId !== 'string' || !sample.snapshotId.trim()) throw new Error('PROFILE_WINDOWS_SAMPLE_INVALID');
  return { ...buildDesktopAppsControlSnapshot(apps, sample.snapshot, sample.capturedAt), snapshotId: sample.snapshotId };
}
