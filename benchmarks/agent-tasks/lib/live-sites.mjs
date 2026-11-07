import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash } from './contracts.mjs';
import { checkPreparedEnvironment, validateEnvironmentContract, validateOperatorAttestation } from './environments.mjs';

const exec = promisify(execFile);
export const LIVE_TASKS = [
  { id: 'live-github-account-review', title: '核对已登录 GitHub 账号的公开资料', url: 'https://github.com/settings/profile', oracle: 'github-public-user-api' },
  { id: 'live-github-issue-read', title: '整理 TypeScript #1 的问题信息', url: 'https://github.com/microsoft/TypeScript/issues/1', oracle: 'github-public-issue-api' },
];
const invalid = (message, details) => Object.assign(new Error(message), { code: 'ENVIRONMENT_INVALID', details });
// Errors become public report data. Select leaf fields rather than copying any
// Profile, login evidence or unrecognized properties from an observation.
const publicEnvironmentPins = value => {
  const pick = (source, keys) => Object.fromEntries(keys.map(key => [key,
    ['string', 'number'].includes(typeof source?.[key]) ? source[key] : null]));
  return {
    viewport: pick(value.viewport, ['width', 'height', 'deviceScaleFactor']),
    ...pick(value, ['locale', 'timezone']),
    browser: pick(value.browser, ['name', 'version', 'mode']),
    transport: { ...pick(value.transport, ['kind']), extension: pick(value.transport?.extension, ['id', 'version']) },
    platform: pick(value.platform, ['os', 'arch', 'release']),
    network: pick(value.network, ['mode', 'egressAlias']),
  };
};
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function extractGithubFacts(taskId, data) {
  if (taskId === 'live-github-account-review') {
    if (typeof data?.login !== 'string') throw invalid('GitHub user oracle returned no identity');
    return { login: data.login, name: data.name || '', bio: data.bio || '', location: data.location || '' };
  }
  if (taskId === 'live-github-issue-read') {
    if (data?.number !== 1 || typeof data.title !== 'string' || !['open', 'closed'].includes(data.state) || !data.user?.login || !Array.isArray(data.labels)) throw invalid('GitHub issue oracle returned invalid fields');
    return { number: data.number, title: data.title, state: data.state, author: data.user.login, labels: data.labels.map(item => typeof item === 'string' ? item : item.name).sort(), url: data.html_url };
  }
  throw invalid('Unknown live task');
}
export function gradeLiveFacts(expected, after, answer, metadata = {}) {
  if (canonical(expected) !== canonical(after)) throw invalid('Live source changed during execution; rerun under a new registered run');
  let value; try { value = JSON.parse(answer); } catch {}
  if (Array.isArray(value?.labels)) value.labels.sort();
  const checks = [
    { id: 'independent-api-facts', passed: canonical(value) === canonical(expected) },
    { id: 'read-only-control-policy', passed: metadata.controlPolicy === 'read-only' },
    { id: 'no-mutation-attempt', passed: metadata.rejectedMutations === 0 },
  ];
  return { businessGoalAchieved: checks[0].passed, mandatoryConstraintsMet: checks.slice(1).every(c => c.passed), checks, observedTerminalState: 'read-only facts checked against independent public API' };
}
export async function githubJson(endpoint, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com${endpoint}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ProfilePilot-evaluation' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw invalid(`Independent GitHub oracle unavailable (HTTP ${response.status})`);
  return response.json();
}

// Host-only: no cookies, storage, password fields or hidden evaluator material
// enters the model. This script observes only page identity and browser geometry.
const OBSERVE = `(async()=>{let hints;try{hints=await navigator.userAgentData?.getHighEntropyValues(['fullVersionList','uaFullVersion'])}catch{}
const browserVersion=hints?.fullVersionList?.find(item=>item.brand==='Google Chrome')?.version||hints?.fullVersionList?.find(item=>item.brand==='Chromium')?.version||hints?.uaFullVersion||null;
return JSON.stringify({url:location.href,readyState:document.readyState,login:document.querySelector('meta[name="user-login"]')?.content||'',profileForm:!!document.querySelector('#user_display_name, #user_profile_name'),viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,browserVersion,browserVersionSource:browserVersion?'user-agent-client-hints':null})})()`;

function safeControlFailure(error, stage, sessionId) {
  let payload = error;
  for (const text of [error?.stderr, error?.stdout]) {
    try { const parsed = JSON.parse(String(text).trim()); if (parsed?.ok === false || parsed?.code || parsed?.error_code) { payload = parsed; break; } } catch {}
  }
  const candidate = payload?.controlCode || payload?.code || payload?.error_code;
  const code = typeof candidate === 'string' && /^(?:NATIVE|AGENT|BROWSER|HOST)_[A-Z_]+$/.test(candidate) ? candidate : 'HOST_COMMAND_FAILED';
  const details = { stage, controlCode: code, sessionId };
  if (['unknown', 'not-executed', 'not-applicable', 'executed'].includes(payload?.recovery?.actionOutcome)) details.actionOutcome = payload.recovery.actionOutcome;
  if (typeof payload?.recovery?.requiresUser === 'boolean') details.requiresUser = payload.recovery.requiresUser;
  return Object.assign(invalid(`ProfilePilot host command stopped (${code}); inspect session ownership before retrying`, details), { controlCode: code });
}

export function makeExtensionHost({ repoRoot, profileId, sessionId, privateDir, invoke, commandTimeoutMs = 25000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let generation, tabId, claimed = false, claimAttempted = false, completeAttempted = false, deadline, lastObservedUrl;
  const cli = async (args, params) => {
    const timeoutMs = Math.max(1, Math.min(commandTimeoutMs, deadline === undefined ? commandTimeoutMs : deadline - now()));
    const expiresAt = now() + timeoutMs;
    if (deadline !== undefined && now() >= deadline) throw safeControlFailure({ code: 'HOST_COMMAND_TIMEOUT', recovery: { actionOutcome: 'unknown' } }, args[0], sessionId);
    const file = params ? path.join(privateDir, `host-${randomUUID()}.json`) : null;
    let timer;
    try {
      const execute = async () => {
        if (invoke) return invoke(args, params, { timeoutMs });
        if (file) await writeFile(file, JSON.stringify(params), { mode: 0o600 });
        if (now() >= expiresAt) throw { code: 'HOST_COMMAND_TIMEOUT', recovery: { actionOutcome: 'not-executed' } };
        const { stdout } = await exec(process.execPath, [path.join(repoRoot, 'dist/main/profilepilot-cli.cjs'),
          '--task-kind', 'verification', '--task-id', sessionId, '--operation-id', randomUUID(),
          'browser', '--connection', 'extension', '--profile', profileId, '--session', sessionId, ...args, ...(file ? ['--params-file', file] : [])],
        { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, shell: false, timeout: Math.max(1, expiresAt - now()), maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
        let parsed; try { parsed = JSON.parse(stdout.trim()); } catch { throw { code: 'HOST_INVALID_RESPONSE' }; }
        if (parsed.ok !== true) throw parsed;
        return parsed.result;
      };
      return await Promise.race([execute(), new Promise((_, reject) => {
        timer = setTimeout(() => reject({ code: 'HOST_COMMAND_TIMEOUT', recovery: { actionOutcome: 'unknown' } }), timeoutMs);
      })]);
    } catch (error) { throw safeControlFailure(error, args[0], sessionId); }
    finally { clearTimeout(timer); if (file && !invoke) await rm(file, { force: true }).catch(() => {}); }
  };
  const rawState = async () => {
    const status = await cli(['status']);
    if (!Array.isArray(status?.profiles)) throw invalid('ProfilePilot status did not provide Profile identities');
    return status.profiles.find(p => p.profileId === profileId);
  };
  const state = async (owned = true) => {
    const current = await rawState();
    if (!current?.connected || current.pausedByBrowser || current.controlIssue) throw invalid('Target Profile disconnected or requires user control');
    if (owned && (current.ownerSessionId !== sessionId || current.ownership !== 'agent' || current.controlGeneration !== generation || current.tabId !== tabId)) throw invalid('Target Profile/session/tab ownership changed; no automatic resume');
    return current;
  };
  const remember = current => {
    if (typeof current?.controlGeneration !== 'string' || !current.controlGeneration || !Number.isSafeInteger(current.tabId) || current.tabId <= 0) throw invalid('Claim did not provide generation/tab identity');
    generation = current.controlGeneration; tabId = current.tabId; claimed = true;
  };
  const host = {
    async claim() {
      const current = await state(false);
      // An idle extension publishes ownership:user with no owner. A retained
      // owner, pause or issue is different and must never be claimed around.
      if (current.ownerSessionId) throw invalid('Target Profile is occupied or under user control');
      claimAttempted = true;
      try {
        const claim = await cli(['claim', '--new-tab', '--controller', 'ProfilePilot eval', '--task', 'Read-only live benchmark']);
        if (claim.sessionId !== sessionId || claim.profileId !== profileId || claim.state?.ownerSessionId !== sessionId) throw invalid('Claim did not confirm the requested session and Profile');
        remember(claim.state);
        await state(); return { tabId, generation };
      } catch (error) {
        let outcome = 'unknown';
        try {
          const current = await rawState();
          if (current?.ownerSessionId === sessionId) { outcome = 'held'; if (!claimed) remember(current); }
          else if (current?.connected) { outcome = 'not-held'; claimAttempted = false; }
        } catch { /* Never retry an uncertain claim or silently resume it. */ }
        error.details = { ...error.details, stage: 'claim', sessionId, claimOutcome: outcome, cleanupRequired: outcome !== 'not-held' };
        throw error;
      }
    },
    state,
    async open(url) { await state(); await cli(['open'], { url }); await state(); },
    async observe() {
      await state();
      const raw = await cli(['cdp', 'Runtime.evaluate'], { expression: OBSERVE, returnByValue: true, awaitPromise: true });
      if (raw.exceptionDetails || typeof raw.result?.value !== 'string') throw invalid('Page environment could not be observed');
      let value; try { value = JSON.parse(raw.result.value); } catch { throw invalid('Page environment returned invalid data'); }
      if (!value || typeof value.url !== 'string') throw invalid('Page environment returned no URL identity');
      await state(); lastObservedUrl = value.url; return value;
    },
    async waitObserved(url, { requireProfileForm = false, timeoutMs = 15000 } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw invalid('Invalid page readiness deadline');
      const previousDeadline = deadline, previousUrl = lastObservedUrl;
      deadline = now() + timeoutMs;
      let redirect, redirectCount = 0, readyIdentity, readyAt;
      try {
        await host.open(url); // One navigation; all waiting below is read-only.
        while (now() < deadline) {
          const page = await host.observe();
          const loaded = ['interactive', 'complete'].includes(page.readyState);
          if (page.url === url && loaded && (!requireProfileForm || page.profileForm && page.login)) {
            if (typeof page.browserVersion !== 'string' || !/^\d+(?:\.\d+){3}$/.test(page.browserVersion)) throw invalid('Full Chrome version is unavailable; reduced user-agent versions cannot establish the browser pin');
            // Debugger attachment can resize an already-loaded document. Pin
            // the environment only after two matching reads at least 250 ms
            // apart, still within this navigation's original deadline.
            const identity = JSON.stringify([page.url, page.viewport?.width, page.viewport?.height,
              page.viewport?.deviceScaleFactor, page.browserVersion, page.login, page.profileForm,
              page.locale, page.timezone]);
            if (readyIdentity === identity && now() - readyAt >= 250 && now() < deadline) return page;
            if (readyIdentity !== identity) { readyIdentity = identity; readyAt = now(); }
          } else { readyIdentity = undefined; readyAt = undefined; }
          // Ignore the old document while Page.navigate is still committing.
          // A stable completed redirect is an expired login or wrong page,
          // not authorization to enter credentials or navigate repeatedly.
          if (page.readyState === 'complete' && page.url !== url && page.url !== previousUrl && page.url !== 'about:blank') {
            redirectCount = redirect === page.url ? redirectCount + 1 : 1; redirect = page.url;
            if (redirectCount >= 2) throw invalid('Page redirected away from the registered page; login may be expired');
          } else { redirect = undefined; redirectCount = 0; }
          await sleep(Math.min(250, Math.max(1, deadline - now())));
        }
        throw invalid('Page did not reach a stable authenticated readiness state before the deadline');
      } finally { deadline = previousDeadline; }
    },
    async close() {
      if (!claimAttempted) return;
      const previousDeadline = deadline; deadline = now() + 15000;
      try {
        const current = await rawState();
        if (current?.connected && current.ownerSessionId !== sessionId) { claimed = false; claimAttempted = false; return; }
        if (!claimed && current?.ownerSessionId === sessionId) remember(current);
        if (completeAttempted) throw invalid('Session completion remains unconfirmed; inspect the retained session before retrying', { sessionId, cleanupRequired: true });
        // Never complete a taken-over session, a replaced generation, or an
        // unknown claim. No close/release/resume or logout is used here.
        await state();
        completeAttempted = true;
        try { await cli(['complete']); }
        catch (error) {
          const after = await rawState().catch(() => undefined);
          if (!after?.connected || after.ownerSessionId === sessionId) throw error;
        }
        const after = await rawState();
        if (!after?.connected || after.ownerSessionId === sessionId) throw invalid('Session completion remains unconfirmed', { sessionId, cleanupRequired: true });
        claimed = false; claimAttempted = false;
      } catch (error) {
        error.details = { ...error.details, stage: 'cleanup', sessionId, cleanupRequired: true };
        throw error;
      } finally { deadline = previousDeadline; }
    },
  };
  return host;
}

export async function prepareLiveScenario({ taskId, environment, bindings = {}, attestation, repoRoot, privateDir, sessionId, fetcher, hostFactory = makeExtensionHost }) {
  const definition = LIVE_TASKS.find(task => task.id === taskId);
  if (!definition) throw invalid('Unknown live task');
  const validation = validateEnvironmentContract(environment);
  if (!validation.ok) throw invalid('Environment contract is missing or invalid', validation.reasons);
  if (environment.track !== 'live-site' || environment.startUrl !== definition.url || environment.siteId !== 'github' || environment.transport.kind !== 'extension' || environment.profile.strategy !== 'reuse' || environment.login.state !== 'preauthenticated' || canonical(environment.allowedOrigins) !== canonical(['https://github.com'])) throw invalid('Live task requires its fixed URL, GitHub origin and preauthenticated extension Profile');
  const profileId = bindings.profiles?.[environment.profile.binding];
  if (typeof profileId !== 'string' || !profileId || /^REPLACE/.test(profileId)) throw invalid('Designated Profile is not bound in the local environment file');
  const accountBinding = bindings.accounts?.[environment.login.accountAlias];
  if (accountBinding?.siteId !== environment.siteId || typeof accountBinding.identitySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(accountBinding.identitySha256)) throw invalid('Designated account is not bound to a valid identity for this site');
  // The service observes extension version, but does not expose extension ID or
  // system proxy configuration. Require a recent explicit operator record.
  const operatorVerification = validateOperatorAttestation(attestation);
  if (!operatorVerification.ok) throw invalid('A valid current extension-ID/network operator attestation is required (24 hours)', operatorVerification.reasons);
  attestation = operatorVerification.attestation;
  const host = hostFactory({ repoRoot, profileId, sessionId, privateDir });
  let ready = false, primaryError;
  try {
    const control = await host.claim();
    const identity = await host.waitObserved('https://github.com/settings/profile', { requireProfileForm: true });
    if (identity.url !== 'https://github.com/settings/profile' || !identity.profileForm || !identity.login) throw invalid('GitHub login is expired or the authenticated identity cannot be verified');
    const identitySha256 = hash(identity.login.toLowerCase());
    if (accountBinding.identitySha256 !== identitySha256) throw invalid('Logged-in GitHub account differs from the designated account');
    const page = definition.url === identity.url ? identity : await host.waitObserved(definition.url), connection = await host.state();
    if (page.login !== identity.login) throw invalid('Logged-in identity changed during preparation');
    const observed = {
      track: 'live-site', siteId: 'github', startUrl: page.url, allowedOrigins: ['https://github.com'],
      profile: { strategy: 'reuse', binding: environment.profile.binding, profileId, runOwned: false },
      login: { state: 'preauthenticated', accountAlias: environment.login.accountAlias, identitySha256, checkedAt: new Date().toISOString(), siteId: 'github', origin: 'https://github.com', profileId, method: 'visible-ui' },
      transport: { kind: 'extension', extension: { id: attestation.extensionId, version: connection.extensionVersion } },
      platform: { os: process.platform, arch: process.arch, release: os.release() },
      browser: { name: 'chrome', version: page.browserVersion, mode: 'headed' },
      viewport: page.viewport, locale: page.locale, timezone: page.timezone, network: attestation.network,
      taskData: { strategy: 'read-only', namespace: environment.taskData.namespace, authResetPerformed: false, runOwned: false },
      cleanup: { taskData: 'retain', profile: 'retain' },
    };
    const checked = checkPreparedEnvironment(environment, observed, { bindings });
    if (!checked.ok) throw Object.assign(invalid('Prepared environment differs from registered contract', checked.reasons), {
      environmentContract: publicEnvironmentPins(validation.contract),
      observedEnvironment: publicEnvironmentPins(observed),
    });
    const endpoint = taskId === 'live-github-account-review' ? `/users/${encodeURIComponent(identity.login)}` : '/repos/microsoft/TypeScript/issues/1';
    const before = extractGithubFacts(taskId, await githubJson(endpoint, fetcher));
    const keys = Object.keys(before).join(', ');
    const prompt = `在指定 GitHub 页面完成只读资料核对。${taskId === 'live-github-account-review' ? '读取当前已登录账号的公开用户名、姓名、简介和所在地；不得编辑或保存。' : '读取 microsoft/TypeScript issue #1 的编号、标题、open/closed 状态、作者、全部标签和网址；不得评论或修改。'}最终回答只输出 JSON，字段为 ${keys}。空资料用空字符串；labels 为字符串数组。请从页面核实，不使用外部接口。`;
    ready = true;
    return {
      url: definition.url, prompt, attachments: [], baselineHash: hash(before), fixtureVersion: 'live-github-1.0.0',
      environmentSummary: checked.environment || checked.summary || { contractHash: checked.contractHash },
      observedEnvironment: { ...observed, profile: { strategy: 'reuse', binding: environment.profile.binding }, login: { state: 'preauthenticated', accountAlias: environment.login.accountAlias, checkedAt: observed.login.checkedAt } },
      browser: observed.browser,
      control: { transport: 'extension', profileId, connectionId: environment.profile.binding, tabId: control.tabId, hostOwned: true },
      async grade({ answer, metadata }) {
        const current = await host.observe();
        if (current.login !== identity.login || current.url !== definition.url) throw invalid('Account/login or designated page changed during task execution');
        if (current.browserVersion !== observed.browser.version) throw invalid('Browser version changed or could not be verified during execution');
        const after = extractGithubFacts(taskId, await githubJson(endpoint, fetcher));
        return gradeLiveFacts(before, after, answer, metadata);
      },
      async snapshot() { return { oracle: definition.oracle, capturedAt: new Date().toISOString(), expected: before }; },
      close: () => host.close(),
    };
  } catch (error) { primaryError = error; throw error; }
  finally {
    if (!ready) try { await host.close(); }
    catch (error) {
      const cleanup = safeControlFailure(error, 'cleanup', sessionId);
      if (!primaryError) throw cleanup;
      primaryError.cleanupError = cleanup.message;
      primaryError.cleanupDetails = { ...cleanup.details, cleanupRequired: true };
    }
  }
}
