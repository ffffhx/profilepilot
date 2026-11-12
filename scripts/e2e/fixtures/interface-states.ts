// Visual review uses real renderers with labelled, disposable sample data.
import './button-layout';
import { store } from '../../../src/renderer/state';
import { render } from '../../../src/renderer/render/render-root';

const scenarios = ['browser-empty','browser-one','browser-four','browser-many','browser-long',
  'browser-loading','browser-error','browser-refresh','tools-ready','tools-loading','tools-error',
  'new-profile','rename-profile','clone-pool','sync-progress','onboarding',
  'onboarding-macos-denied','onboarding-macos-requesting','onboarding-macos-ready'];

function show(name: string, platform: string) {
  if (name.startsWith('onboarding-macos-')) platform = 'darwin';
  (window as any).buttonLayout.scenario('browser-refresh', false, platform);
  Object.assign(store.agentIntegrationDiagnostic!.inputGuard, {
    platform: platform as NodeJS.Platform,
    supported: platform === 'darwin',
    granted: platform !== 'darwin' || name === 'onboarding-macos-ready'
  });
  const sample = structuredClone(store.state!.profiles[0]);
  const count = name === 'browser-empty' ? 0 : name === 'browser-one' ? 1 : name === 'browser-many' ? 24 : 4;
  store.state!.profiles = Array.from({ length: count }, (_, index) => ({ ...structuredClone(sample),
    id: `sample-${index}`, name: name === 'browser-long' ? `设计审查示例 · 很长的中文与 English 工作环境名称 ${index + 1}` : ['工作浏览器（示例）','个人浏览器（示例）','测试环境（示例）','临时环境（示例）'][index % 4],
    source: 'isolated' as const, fixedCdpPort: 9223 + index
  }));
  store.selectedId = store.state!.profiles[0]?.id || null;
  store.accountSyncSourceId = store.state!.profiles[0]?.id || null;
  store.accountSyncTargetId = store.state!.profiles[1]?.id || null;
  if (name === 'browser-loading' || name === 'browser-error') {
    store.state = null;
    store.profileLoadError = name === 'browser-error' ? '无法读取浏览器列表，请重新检测。' : null;
  }
  if (name === 'browser-refresh') { store.busy = true; store.busyState = {key:'refresh',message:'正在刷新浏览器列表…'}; }
  if (name.startsWith('tools-')) {
    store.workspace = 'tools';
    if (name === 'tools-loading') { store.agentIntegrationLoading = true; store.agentIntegrationDiagnostic = null; store.nativeExtensionLoading = true; }
    if (name === 'tools-error') { store.nativeExtensionError = '浏览器连接暂不可用，请重试检测。'; store.nativeExtensionBrowsers = []; }
  }
  if (name === 'new-profile') store.modal = {kind:'new'};
  if (name === 'rename-profile') store.modal = {kind:'rename',profileId:store.selectedId!};
  if (name === 'clone-pool') { store.modal = {kind:'clone-pool'}; store.clonePoolSourceId = store.selectedId; }
  if (name === 'sync-progress') { store.busy = true; store.busyState = {key:'account-sync',message:'正在复制选定的浏览器数据…',stepIndex:2,stepCount:4}; }
  if (name.startsWith('onboarding')) store.modal = {kind:'onboarding'};
  if (name === 'onboarding-macos-requesting') store.inputGuardPermissionLoading = true;
  render();
}
Object.assign(window, { interfaceReview: {scenarios,show} });
