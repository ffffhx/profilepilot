const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');

async function fixture(saved = {}) {
  const storage = saved.storage || {}, groups = saved.groups || new Map();
  const tabs = saved.tabs || new Map([7, 8, 9].map(id => [id, { id, windowId: 1, groupId: -1, url: `https://fixture.test/${id}`, active: id === 8, status: 'complete' }]));
  const calls = []; let nextGroup = Math.max(99, ...groups.keys()) + 1, nextTab = 20;
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const area = { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, structuredClone(value)), remove: async keys => { for (const key of [].concat(keys)) delete storage[key]; } };
  const chrome = {
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('closed'); return { ...tabs.get(id) }; },
      query: async (q = {}) => [...tabs.values()].filter(t => (q.groupId === undefined || t.groupId === q.groupId) && (q.active === undefined || t.active === q.active)),
      group: async p => {
        const groupId = p.groupId ?? nextGroup++;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: p.createProperties.windowId, color: 'grey', title: '', collapsed: false });
        for (const id of [].concat(p.tabIds)) {
          const tab = tabs.get(id); assert.equal(tab.windowId, groups.get(groupId).windowId); assert.ok(!tab.pinned);
          const previous = tab.groupId;
          tab.groupId = groupId;
          if (previous >= 0 && previous !== groupId && ![...tabs.values()].some(t => t.groupId === previous)) {
            const removed = groups.get(previous); groups.delete(previous);
            if (removed) chrome.tabGroups.onRemoved.emit(removed);
          }
        }
        calls.push({ kind: 'group', groupId, ...p }); return groupId;
      },
      create: async p => { assert.equal(p.active, false); const tab = { id: nextTab++, windowId: 1, groupId: -1, status: 'complete', ...p }; tabs.set(tab.id, tab); return tab; },
      update: async () => assert.fail('Grouping must not activate or unpin a tab'),
      onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event()
    },
    tabGroups: { get: async id => { if (!groups.has(id)) throw Error('missing'); return { ...groups.get(id) }; },
      update: async (id, p) => { calls.push({ kind: 'visual', id, ...p }); Object.assign(groups.get(id), p); return { ...groups.get(id) }; }, onRemoved: event() },
    windows: { update: async () => assert.fail('Grouping must not focus windows') },
    scripting: { executeScript: async () => assert.fail('New tasks must preserve website icons and titles') },
    runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, getManifest: () => ({ version: '0.2.8' }), onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: area, session: area, onChanged: event() }, alarms: { create: async () => {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: event(), onDetach: event() }
  };
  const context = vm.createContext({ chrome, URL, crypto: webcrypto, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync('extensions/profilepilot/background.js', 'utf8') + `
    globalThis.api = { handle, state, flush: () => syncTaskGroups(), disconnect,
      configure: () => { config = { profileId: 'native:fixture' }; },
      dropConnection: () => { ownership = 'user'; controlEpoch++; groupState('failed'); return publish(); } };`, context);
  await new Promise(resolve => setImmediate(resolve));
  context.api.configure();
  const ui = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, { id: 'fixture', url: 'chrome-extension://fixture/popup.html' }, resolve));
  const resume = async id => context.api.handle('control', { sessionId: id, action: 'resume', controlGeneration: (await context.api.state()).controlGeneration });
  return { ...context.api, chrome, tabs, groups, storage, calls, ui, resume };
}

test('one group survives running, waiting, takeover, resume and completion; unrelated tabs stay put', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', taskTitle: '校招申请', tabId: 7 }); await f.flush();
  const id = f.tabs.get(7).groupId, group = () => f.groups.get(id);
  assert.equal(group().color, 'blue'); assert.equal(group().title, 'ProfilePilot · 执行中 1');
  assert.equal(f.tabs.get(8).groupId, -1);
  await f.handle('newTab', { sessionId: 'one', url: 'https://fixture.test/new' }); await f.flush();
  assert.equal(f.tabs.get(20).groupId, id);
  await f.handle('control', { sessionId: 'one', action: 'handoff' }); await f.flush(); assert.equal(group().color, 'purple');
  await f.ui({ method: 'takeover' }); await f.flush(); assert.equal(group().color, 'orange');
  await f.resume('one'); await f.flush(); assert.equal(group().color, 'blue');
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  assert.equal(group().color, 'green'); assert.equal(f.groups.size, 1); assert.equal(f.tabs.get(8).active, true);
  assert.equal(f.calls.filter(c => c.kind === 'group' && c.createProperties).length, 1);
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  assert.equal(f.tabs.get(7).groupId, id); assert.equal(group().color, 'blue'); assert.equal(f.groups.size, 1);
});

test('task questions are purple without taking control; stale status cannot undo takeover', async () => {
  const f = await fixture(); await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  const generation = (await f.state()).controlGeneration, id = f.tabs.get(7).groupId;
  await f.handle('taskState', { sessionId: 'one', controlGeneration: generation, status: 'waiting_user' });
  assert.equal(f.groups.get(id).color, 'purple'); assert.equal((await f.state()).ownership, 'agent');
  await f.ui({ method: 'takeover' });
  assert.equal((await f.handle('taskState', { sessionId: 'one', controlGeneration: generation, status: 'running' })).applied, false);
  await f.handle('taskState', { sessionId: 'one', controlGeneration: (await f.state()).controlGeneration, status: 'waiting_user' });
  await f.flush(); assert.equal(f.groups.get(id).color, 'orange'); assert.equal((await f.state()).ownership, 'user');
});

test('failure and disconnection turn the existing group red; cancellation never claims success', async () => {
  const f = await fixture(); await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  const id = f.tabs.get(7).groupId;
  await f.dropConnection(); await f.flush(); assert.equal(f.groups.get(id).color, 'red');
  await f.resume('one'); await f.flush(); assert.equal(f.groups.get(id).color, 'blue');
  await f.handle('control', { sessionId: 'one', action: 'complete', groupPhase: 'failed' }); await f.flush();
  assert.equal(f.groups.get(id).color, 'red');
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  await f.handle('control', { sessionId: 'one', action: 'release' }); await f.flush();
  assert.equal(f.groups.get(id).color, 'orange'); assert.match(f.groups.get(id).title, /已取消/); assert.equal(f.groups.size, 1);
});

test('worker restore reuses group IDs, preserves completed states and never restores running control', async () => {
  const f = await fixture(); await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  f.storage.connection = { profileId: 'native:fixture' };
  const id = f.tabs.get(7).groupId, restored = await fixture(f); await restored.flush();
  assert.equal(restored.tabs.get(7).groupId, id); assert.equal(restored.groups.get(id).color, 'orange');
  assert.equal((await restored.state()).ownership, 'user'); assert.equal(restored.groups.size, 1);
  await restored.handle('control', { sessionId: 'one', action: 'complete' }); await restored.flush();
  const completed = await fixture(restored); await completed.flush(); assert.equal(completed.groups.get(id).color, 'green');
});

test('child/replaced tabs keep membership; pinned tabs and tabs in other windows never move', async () => {
  const f = await fixture(); f.tabs.get(9).pinned = true;
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush(); const id = f.tabs.get(7).groupId;
  f.tabs.set(10, { id: 10, windowId: 1, groupId: -1, url: 'https://fixture.test/child', openerTabId: 7 });
  f.chrome.tabs.onCreated.emit(f.tabs.get(10)); await f.flush(); assert.equal(f.tabs.get(10).groupId, id);
  f.tabs.set(11, { ...f.tabs.get(10), id: 11 }); f.tabs.delete(10); f.chrome.tabs.onReplaced.emit(11, 10); await f.flush();
  assert.equal(f.tabs.get(11).groupId, id);
  await f.handle('switch', { sessionId: 'one', tabId: 9 }); await f.flush(); assert.equal(f.tabs.get(9).groupId, -1); assert.equal(f.tabs.get(9).pinned, true);
  f.tabs.get(8).windowId = 2; await f.handle('switch', { sessionId: 'one', tabId: 8 }); await f.flush();
  assert.equal(f.tabs.get(8).windowId, 2); assert.notEqual(f.tabs.get(8).groupId, id); assert.equal(f.tabs.get(7).windowId, 1);
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  assert.ok([...f.groups.values()].every(g => g.color === 'green'));
});

test('group updates respect manual removal and a later task does not recolor the earlier group', async () => {
  const f = await fixture(); await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  const old = f.tabs.get(7).groupId;
  f.tabs.get(7).groupId = -1;
  await f.handle('control', { sessionId: 'one', action: 'handoff' }); await f.flush(); assert.equal(f.tabs.get(7).groupId, -1);
  await f.handle('control', { sessionId: 'one', action: 'complete' });
  await f.handle('claim', { sessionId: 'two', tabId: 7 }); await f.flush(); const newer = f.tabs.get(7).groupId;
  assert.notEqual(newer, old); assert.equal(f.groups.get(newer).color, 'blue');
  await f.handle('control', { sessionId: 'two', action: 'complete' }); await f.flush(); assert.equal(f.groups.get(newer).color, 'green');
});

test('takeover while grouping is pending cannot leave a stale blue group', async () => {
  const f = await fixture(); let release;
  const create = f.chrome.tabs.group;
  f.chrome.tabs.group = async params => { await new Promise(resolve => { release = resolve; }); return create(params); };
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.ui({ method: 'takeover' }); release(); await f.flush();
  assert.equal(f.groups.get(f.tabs.get(7).groupId).color, 'orange'); assert.equal((await f.state()).ownership, 'user');
});

test('different tasks share one window group with independent tab states and control scopes', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  const id = f.tabs.get(7).groupId, group = () => f.groups.get(id);
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  await f.handle('claim', { sessionId: 'two', tabId: 8 }); await f.flush();
  assert.equal(f.tabs.get(8).groupId, id);
  assert.equal(group().title, 'ProfilePilot · 执行中 1 · 已完成 1');
  assert.equal(group().color, 'blue');
  await assert.rejects(f.handle('closeTab', { sessionId: 'two', tabId: 7 }), /未授权/);
  await f.handle('control', { sessionId: 'two', action: 'complete', groupPhase: 'failed' }); await f.flush();
  assert.equal(group().color, 'red'); assert.equal(group().title, 'ProfilePilot · 执行异常 1 · 已完成 1');
  await f.handle('claim', { sessionId: 'three', tabId: 9 }); await f.flush();
  assert.equal(f.tabs.get(9).groupId, id);
  assert.equal(group().color, 'blue'); assert.equal(group().title, 'ProfilePilot · 执行中 1 · 执行异常 1 · 已完成 1');
  await f.handle('control', { sessionId: 'three', action: 'handoff' }); await f.flush();
  assert.equal(group().color, 'purple'); assert.match(group().title, /^ProfilePilot · 等待你处理 1/);
  await f.handle('control', { sessionId: 'three', action: 'complete' }); await f.flush();
  assert.equal(group().color, 'red'); assert.equal(group().title, 'ProfilePilot · 执行异常 1 · 已完成 2');
  assert.equal(f.groups.size, 1);
  // Reusing a page assigns its state to the new task; history cannot double-count it.
  await f.handle('claim', { sessionId: 'four', tabId: 8 }); await f.flush();
  assert.equal(group().title, 'ProfilePilot · 执行中 1 · 已完成 2');
  await f.handle('control', { sessionId: 'four', action: 'complete' }); await f.flush();
  assert.equal(group().color, 'green'); assert.equal(group().title, 'ProfilePilot · 已完成 3');
});

test('restored per-task groups merge only tracked members and preserve collapsed state', async () => {
  const tabs = new Map([7, 8, 9, 10, 11].map(id => [id, {
    id, windowId: 1, groupId: id === 7 ? 100 : id === 8 || id === 10 ? 101 : id === 11 ? 102 : -1,
    url: `https://fixture.test/${id}`, active: id === 9, status: 'complete'
  }]));
  const groups = new Map([100, 101, 102].map(id => [id, { id, windowId: 1, color: 'green', title: 'ProfilePilot · old', collapsed: true }]));
  const storage = { connection: { profileId: 'native:fixture' }, taskGroups: { profileId: 'native:fixture', tasks: [
    ['one', { phase: 'completed', groups: { 1: 100 }, enrolled: [7, 9] }],
    ['two', { phase: 'completed', groups: { 1: 101 }, enrolled: [8] }]
  ] } };
  const f = await fixture({ tabs, groups, storage }); await f.flush();
  assert.equal(tabs.get(8).groupId, 100); assert.equal(groups.get(100).title, 'ProfilePilot · 已完成 2');
  assert.equal(groups.get(100).collapsed, true);
  assert.equal(tabs.get(9).groupId, -1); assert.equal(tabs.get(10).groupId, 101);
  assert.equal(tabs.get(11).groupId, 102); assert.equal(groups.get(102).title, 'ProfilePilot · old');
  const restored = await fixture(f); await restored.flush();
  assert.equal(restored.tabs.get(8).groupId, 100);
  assert.equal(restored.calls.some(call => call.kind === 'group'), false);
});

test('migration handles Chrome removing an emptied old group and excludes shared groups', async () => {
  const f = await fixture();
  f.storage.connection = { profileId: 'native:fixture' };
  f.storage.taskGroups = { profileId: 'native:fixture', tasks: [] };
  for (const [index, tab] of [...f.tabs.values()].entries()) {
    const id = 200 + index; tab.groupId = id;
    f.groups.set(id, { id, windowId: 1, color: 'green', title: 'old', shared: index === 2 });
    f.storage.taskGroups.tasks.push([`task-${index}`, { phase: 'completed', groups: { 1: id }, enrolled: [tab.id] }]);
  }
  const restored = await fixture(f); await restored.flush();
  assert.equal(restored.tabs.get(8).groupId, 200); assert.equal(restored.groups.has(201), false);
  assert.equal(restored.tabs.get(9).groupId, 202); assert.equal(restored.groups.get(202).title, 'old');
  assert.equal(restored.groups.get(200).title, 'ProfilePilot · 已完成 2');
});

test('state counts update on manual removal and tab closure without pulling tabs back', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  await f.handle('newTab', { sessionId: 'one', url: 'https://fixture.test/new' }); await f.flush();
  const id = f.tabs.get(7).groupId;
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  f.tabs.get(7).groupId = -1; f.chrome.tabs.onUpdated.emit(7, { groupId: -1 }); await f.flush();
  assert.equal(f.tabs.get(7).groupId, -1); assert.equal(f.groups.get(id).title, 'ProfilePilot · 已完成 1');
  await f.handle('claim', { sessionId: 'two', tabId: 8 }); await f.flush();
  f.tabs.delete(20); f.chrome.tabs.onRemoved.emit(20); await f.flush();
  assert.equal(f.groups.get(id).title, 'ProfilePilot · 执行中 1');
});

test('current task colors only windows with its own tabs and never merges across windows', async () => {
  const f = await fixture(); f.tabs.get(8).windowId = 2;
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  const first = f.tabs.get(7).groupId;
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  await f.handle('claim', { sessionId: 'two', tabId: 8 }); await f.flush();
  const second = f.tabs.get(8).groupId;
  assert.notEqual(first, second); assert.equal(f.groups.get(first).color, 'green'); assert.equal(f.groups.get(second).color, 'blue');
  assert.equal(f.tabs.get(7).windowId, 1); assert.equal(f.tabs.get(8).windowId, 2);
});
