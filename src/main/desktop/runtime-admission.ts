import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestBrowserGateway } from '../browser-gateway-client';
import { readBrowserServiceConnection, serviceRequest } from '../browser-service/connection';
import { defaultDataDir } from '../fs-util';
import type { GatewayProfileBinding } from '../browser-gateway-control';
import type { NativeBrowserState } from '../../shared/browser-connection';
import { createDesktopAdmission, type DesktopAdmissionReadContext, type AdmissionSnapshot, type DesktopAdmissionCatalog, type AdmissionLocalApp, type DesktopAdmissionGateway, type DesktopAdmissionApps } from './admission';
import type { DesktopAppControlConfig, DesktopAppsControlSnapshot } from './apps-discovery';
import { buildDesktopAppsControlFromSample } from './apps-discovery';
import { collectWindowsControlSample, type WindowsControlSample } from '../windows-platform';
import { readProfileProcessChangeError, type ProfileProcessChangeDiagnostic } from '../profile-process-change';
import type { WindowsSamplerReadContext } from '../windows-sampler';

const sessionId = z.string().min(1).max(1024).optional();
const gatewaySchema = z.object({
  state: z.object({ profiles: z.array(z.object({
    profileId: z.string().min(1), profileName: z.string(), publicPort: z.number().int().min(1).max(65535),
    chromePid: z.number().int().positive().optional(), ownerSessionId: sessionId,
    ownership: z.enum(['agent', 'user']), sessionStatus: z.enum(['active', 'stopped']),
    driverState: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'parked']),
    agentHealth: z.enum(['online', 'waiting', 'offline']), controlGeneration: z.number().int().nonnegative(), updatedAt: z.string()
  })).max(10000) }), ports: z.array(z.number().int().min(1).max(65535)).max(10000)
});
const nativeSchema = z.object({ states: z.array(z.object({
  profileId: z.string().min(1), connected: z.boolean(), ownerSessionId: sessionId,
  ownership: z.enum(['agent', 'user']), pausedByBrowser: z.boolean().optional(), controlGeneration: z.string().optional(),
  controlIssue: z.object({ code: z.string(), message: z.string() }).optional()
})).max(10000) });

interface LegacyDiscoveryOptions {
  discovery?: undefined;
  catalog: () => Promise<DesktopAdmissionCatalog>;
  apps: () => Promise<readonly (AdmissionLocalApp & DesktopAppControlConfig)[]>;
  // Optional Windows OS evidence for the exact rows returned by apps(). The
  // collector must use a forced read and preserve its original sampling time.
  // No daemon startup, configuration edit, attach or reconnect is permitted.
  appsControl?: (apps: readonly (AdmissionLocalApp & DesktopAppControlConfig)[]) => Promise<DesktopAppsControlSnapshot>;
}
export interface DesktopDiscoveryRound {
  catalog: Promise<DesktopAdmissionCatalog>;
  apps: Promise<DesktopAdmissionApps>;
}
export interface DesktopDiscoveryContext {
  readonly catalog?: DesktopAdmissionReadContext;
  readonly apps?: DesktopAdmissionReadContext;
}
export interface DesktopDiscoveryRetryEvidence {
  retryId: string;
  phase: 'started' | 'finished';
  attempts: 1 | 2;
  firstIssue: ProfileProcessChangeDiagnostic;
  secondSample?: { snapshotId: string; capturedAt: number };
  outcome?: 'round_published' | 'second_failed' | 'deadline' | 'not_retried';
  reason?: 'context_missing' | 'sample_mismatch' | 'apps_unavailable' | 'apps_control_missing' | 'apps_control_incomplete'
    | 'apps_sample_mismatch' | 'catalog_failed' | 'apps_failed' | 'round_identity_mismatch';
}
interface SharedDiscoveryOptions {
  discovery: (context?: DesktopDiscoveryContext) => DesktopDiscoveryRound;
  catalog?: never;
  apps?: never;
  appsControl?: never;
}
interface RuntimeDesktopAdmissionCommon {
  // Inject read-only transports for tests. None of these providers may start,
  // attach, reconnect, claim, or resume another service as a side effect.
  gateway?: () => Promise<unknown>;
  native?: () => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
  maxAgeMs?: number;
}
export type RuntimeDesktopAdmissionOptions = RuntimeDesktopAdmissionCommon & (LegacyDiscoveryOptions | SharedDiscoveryOptions);

export function createWindowsDesktopDiscovery(options: {
  catalog: (sample: Promise<WindowsControlSample>) => Promise<DesktopAdmissionCatalog>;
  apps: (sample: Promise<WindowsControlSample>) => Promise<readonly (AdmissionLocalApp & DesktopAppControlConfig)[]>;
  sample?: (context?: WindowsSamplerReadContext) => Promise<WindowsControlSample>;
  onRetry?: (evidence: DesktopDiscoveryRetryEvidence) => void;
}): (context?: DesktopDiscoveryContext) => DesktopDiscoveryRound {
  const readRound = (context?: WindowsSamplerReadContext) => {
    // Start in this synchronous turn after the caller's budget check. Deferring
    // the factory to another microtask could start sample 2 after an abort.
    let sample: Promise<WindowsControlSample>;
    try { sample = Promise.resolve((options.sample || collectWindowsControlSample)(context)); }
    catch (error) { sample = Promise.reject(error); }
    // A registry error or empty apps list can finish before the process query.
    // Observe rejection immediately without changing the original promise.
    void sample.catch(() => undefined);
    return {
      sample,
      catalog: Promise.resolve().then(() => options.catalog(sample)),
      apps: Promise.resolve().then(() => options.apps(sample)).then(async applications => {
        try { return { applications, control: buildDesktopAppsControlFromSample(applications, await sample) }; }
        // Failed optional route evidence must retain known worker/app PIDs.
        // Catalog strict collection independently rejects the failed sample.
        catch { return { applications }; }
      })
    };
  };
  type Results = [PromiseSettledResult<DesktopAdmissionCatalog>, PromiseSettledResult<DesktopAdmissionApps>, PromiseSettledResult<WindowsControlSample>];
  const settled = (round: ReturnType<typeof readRound>): Promise<Results> => Promise.allSettled([round.catalog, round.apps, round.sample]);
  const timeout = (values: Results): Results => [{ status: 'rejected', reason: new Error('provider_timeout') }, { status: 'rejected', reason: new Error('provider_timeout') }, values[2]];
  const sampleInfo = (value: PromiseSettledResult<WindowsControlSample>) => value.status === 'fulfilled'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.value?.snapshotId)
    && Number.isSafeInteger(value.value.capturedAt) && value.value.capturedAt >= 0
    ? { snapshotId: value.value.snapshotId, capturedAt: value.value.capturedAt } : undefined;
  const appIssue = (value: Results[1], sample: WindowsControlSample): DesktopDiscoveryRetryEvidence['reason'] | undefined => {
    if (value.status !== 'fulfilled') return 'apps_unavailable';
    const control = value.value.control;
    if (!control) return 'apps_control_missing';
    if (control.complete !== true || control.gaps?.length) return 'apps_control_incomplete';
    if (control.snapshotId !== sample.snapshotId || control.capturedAt !== sample.capturedAt) return 'apps_sample_mismatch';
  };
  const notify = (value: DesktopDiscoveryRetryEvidence) => {
    // Diagnostic failure/mutation cannot grant, deny, or change a later event.
    try { options.onRetry?.(structuredClone(value)); } catch { /* Best-effort bounded metadata only. */ }
  };
  return context => {
    const originalContexts = [context?.catalog, context?.apps].filter((value): value is DesktopAdmissionReadContext => !!value);
    const readContext: WindowsSamplerReadContext | undefined = originalContexts.length ? {
      deadlineAt: Math.min(...originalContexts.map(value => value.deadlineAt)),
      now: () => Math.max(...originalContexts.map(value => value.now())),
      signal: AbortSignal.any(originalContexts.map(value => value.signal))
    } : undefined;
    const first = readRound(readContext);
    // Existing direct collectors without the caller's real timeout keep their
    // single read. Never invent an additional deadline or retry budget here.
    if (!context) return first;
    const bound = () => !!context.catalog && !!context.apps;
    const expired = () => [context.catalog, context.apps].some(value => value &&
      (value.signal.aborted || !Number.isFinite(value.deadlineAt) || value.now() >= value.deadlineAt));
    const selected = settled(first).then(async (values): Promise<Results> => {
      const issue = values[0].status === 'rejected' ? readProfileProcessChangeError(values[0].reason) : undefined;
      const missingPid = issue?.stage === 'windows_rm_pid_join';
      const unpinnedRm = issue?.stage === 'windows_rm_birth_join' && issue.origin === 'restart_manager'
        && issue.reason === 'unavailable' && issue.identityReason === 'not_pinned';
      if (!issue || (!missingPid && !unpinnedRm)) return expired() ? timeout(values) : values;
      const history = { retryId: randomUUID(), firstIssue: issue };
      const finish = (attempts: 1 | 2, outcome: DesktopDiscoveryRetryEvidence['outcome'], reason?: DesktopDiscoveryRetryEvidence['reason'], second?: Results[2]) =>
        notify({ ...history, phase: 'finished', attempts, outcome, ...(reason ? { reason } : {}), ...(second && sampleInfo(second) ? { secondSample: sampleInfo(second) } : {}) });
      if (expired()) { finish(1, 'deadline'); return timeout(values); }
      let reason: DesktopDiscoveryRetryEvidence['reason'];
      const sampled = values[2];
      if (!bound()) reason = 'context_missing';
      else if (sampled.status !== 'fulfilled' || issue.snapshotId !== sampled.value.snapshotId || issue.capturedAt !== sampled.value.capturedAt
          || issue.processCount !== sampled.value.snapshot.processes.length) reason = 'sample_mismatch';
      else {
        const rows = sampled.value.snapshot.processes.filter(row => row.pid === issue.pid);
        // A CIM PID absent from the earlier pin map may have started during the
        // read. Only this exact evidence permits discarding the whole round;
        // it never supplies an identity or relaxes the subsequent strict join.
        const matches = missingPid ? rows.length === 0 : rows.length === 1
          && rows[0].identityStatus === 'unavailable' && rows[0].identityReason === 'not_pinned'
          && rows[0].creationFileTime === null && !Object.hasOwn(rows[0], 'identityWin32Error');
        reason = matches ? appIssue(values[1], sampled.value) : 'sample_mismatch';
      }
      if (reason) { finish(1, 'not_retried', reason); return values; }
      // Both original collect contexts remain attached even when another caller
      // joins pendingDiscovery. This check never starts a scan after timeout.
      if (expired()) { finish(1, 'deadline'); return timeout(values); }
      const second = readRound(readContext);
      notify({ ...history, phase: 'started', attempts: 2 });
      const retried = await settled(second);
      if (expired()) { finish(2, 'deadline', undefined, retried[2]); return timeout(retried); }
      if (retried[0].status === 'rejected' || retried[1].status === 'rejected') {
        finish(2, 'second_failed', retried[0].status === 'rejected' ? 'catalog_failed' : 'apps_failed', retried[2]); return retried;
      }
      const secondSample = retried[2], discovery = retried[0].value.discovery;
      if (secondSample.status !== 'fulfilled' || appIssue(retried[1], secondSample.value)
          || discovery.snapshotId !== secondSample.value.snapshotId || discovery.capturedAt !== secondSample.value.capturedAt || discovery.complete !== true) {
        finish(2, 'second_failed', 'round_identity_mismatch', secondSample);
        return [{ status: 'rejected', reason: new Error('PROFILE_DISCOVERY_ROUND_INVALID') }, retried[1], secondSample];
      }
      finish(2, 'round_published', undefined, secondSample);
      return retried;
    });
    // Neither first-round source publishes independently. Both results/errors
    // come from the same selected round; previous rows are never relabelled.
    return {
      catalog: selected.then(values => { if (values[0].status === 'rejected') throw values[0].reason; return values[0].value; }),
      apps: selected.then(values => { if (values[1].status === 'rejected') throw values[1].reason; return values[1].value; })
    };
  };
}

export function createRuntimeDesktopAdmission(options: RuntimeDesktopAdmissionOptions) {
  const now = options.now || Date.now;
  // A timed-out OS process scan cannot be synchronously cancelled. Share it
  // until it settles instead of stacking more scans on repeated requests.
  const sampled = <T>(read: () => Promise<T>) => {
    let pending: Promise<AdmissionSnapshot<T>> | undefined;
    return () => {
      if (pending) return pending;
      const capturedAt = now();
      const request = Promise.resolve().then(read).then(value => ({ state: 'ready' as const, value, capturedAt }));
      pending = request;
      void request.then(() => { if (pending === request) pending = undefined; }, () => { if (pending === request) pending = undefined; });
      return request;
    };
  };
  type PendingDiscovery = { catalog: Promise<AdmissionSnapshot<DesktopAdmissionCatalog>>; apps: Promise<AdmissionSnapshot<DesktopAdmissionApps>>;
    contexts: { catalog?: DesktopAdmissionReadContext; apps?: DesktopAdmissionReadContext } };
  let pendingDiscovery: PendingDiscovery | undefined;
  const discoveryRound = (source: 'catalog' | 'apps', context: DesktopAdmissionReadContext): PendingDiscovery => {
    if (pendingDiscovery) {
      // Bind each original sibling exactly once. Later admission calls share
      // pending work but cannot renew either deadline or replace an abort.
      pendingDiscovery.contexts[source] ||= context;
      return pendingDiscovery;
    }
    const capturedAt = now();
    const contexts: PendingDiscovery['contexts'] = { [source]: context };
    const reads = Promise.resolve().then(() => options.discovery!(contexts));
    const round: PendingDiscovery = {
      contexts,
      catalog: reads.then(value => value.catalog).then(value => ({ state: 'ready', value, capturedAt })),
      apps: reads.then(value => value.apps).then(value => ({ state: 'ready', value, capturedAt }))
    };
    pendingDiscovery = round;
    // A fast sibling must not start another OS scan while the other source is
    // still running or has timed out at the caller. Each source keeps its own
    // result/error; joining the round never refreshes either timestamp.
    void Promise.allSettled([round.catalog, round.apps]).then(() => {
      if (pendingDiscovery === round) pendingDiscovery = undefined;
    });
    return round;
  };
  return createDesktopAdmission({
    catalog: options.discovery ? context => discoveryRound('catalog', context).catalog : sampled(options.catalog),
    apps: options.discovery ? context => discoveryRound('apps', context).apps : sampled(async (): Promise<DesktopAdmissionApps> => {
      const applications = await options.apps!();
      if (!options.appsControl) return { applications };
      try { return { applications, control: await options.appsControl(applications) }; }
      // Optional evidence failing cannot erase already identified apps or turn
      // an unknown route into an idle one. Unknown PID rows remain fail-closed.
      catch { return { applications }; }
    }),
    gateway: sampled(async (): Promise<DesktopAdmissionGateway> => {
      const response = gatewaySchema.parse(await (options.gateway || (() => requestBrowserGateway({ action: 'status' }, { timeoutMs: 2000 })))());
      return { profiles: response.state.profiles as GatewayProfileBinding[], ports: response.ports };
    }),
    native: sampled(async (): Promise<readonly NativeBrowserState[]> => {
      const snapshot = await (options.native || (async () => {
        // Match the desktop browser adapter's root. Reading the discovery file
        // and snapshot is deliberately distinct from ensureBrowserService().
        const root = path.join(process.env.CPM_DATA_DIR || defaultDataDir(), 'browser-tasks');
        const connection = readBrowserServiceConnection(root);
        if (!connection) throw new Error('Browser service discovery unavailable');
        return (await serviceRequest(connection, 'snapshot', [], 2000)).result;
      }))();
      return nativeSchema.parse(snapshot).states;
    })
  }, { now, timeoutMs: options.timeoutMs ?? 5000, maxAgeMs: options.maxAgeMs ?? 6000, discoveryFirst: true, controlMaxAgeMs: 2500 });
}
