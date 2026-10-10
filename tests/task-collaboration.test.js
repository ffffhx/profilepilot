const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskCollaboration, taskAgents } = require('../dist/main/tasks/collaboration');
const { renderAgentProgress } = require('../dist/renderer/task-progress');

test('delegation, parallel work and scoped peer messages share a task lifecycle', () => {
  const state = new TaskCollaboration();
  for (const name of ['alpha', 'beta']) {
    const args = { name, subagent_type: 'researcher', description: `Analyze ${name}` };
    assert.equal(state.denial('Agent', args), undefined);
    state.before('Agent', args, `call-${name}`);
    assert.match(state.denial('mcp__profilepilot__finish', {}), /仍在执行/);
    state.activity({ subtype: 'task_started', task_id: `id-${name}`, tool_use_id: `call-${name}`, task_type: 'local_agent' });
    state.after(`call-${name}`);
  }
  assert.equal(state.denial('SendMessage', { to: 'beta', message: 'Review this' }, 'id-alpha'), undefined);
  assert.equal(state.denial('SendMessage', { to: 'main', message: 'Finding' }, 'id-beta'), undefined);
  assert.ok(state.denial('SendMessage', { to: 'external-session', message: 'No' }, 'id-alpha'));
  assert.ok(state.denial('SendMessage', { to: 'beta', message: { type: 'plan_approval_response' } }, 'id-alpha'));
  state.activity({ subtype: 'task_notification', task_id: 'id-alpha', status: 'completed', summary: 'Alpha result' });
  assert.equal(state.running, true);
  assert.equal(state.denial('TaskStop', { task_id: 'beta' }), undefined);
  state.activity({ subtype: 'task_notification', task_id: 'id-beta', status: 'stopped' });
  assert.equal(state.running, false);
  assert.equal(state.denial('mcp__profilepilot__finish', {}), undefined);
  assert.equal(state.activities.get('id-alpha').name, 'alpha');
  assert.equal(state.activities.get('id-alpha').summary, 'Alpha result');
});

test('child tools cannot finish, mutate memory, operate browser, shell, or spawn grandchildren', () => {
  const state = new TaskCollaboration();
  for (const tool of ['Write', 'Edit', 'Bash', 'Agent', 'Task', 'TaskStop', 'mcp__profilepilot__finish', 'mcp__profilepilot__browser_action', 'mcp__profilepilot__terminal_run', 'mcp__profilepilot__ask_user']) {
    assert.ok(state.denial(tool, {}, 'child'), tool);
  }
  for (const input of [{ subagent_type: 'fork' }, { isolation: 'remote' }, { mode: 'bypassPermissions' }, { model: 'opus' }, { name: 'main' }]) assert.ok(state.denial('Agent', input));
  const definitions = taskAgents('configured-model');
  for (const definition of Object.values(definitions)) {
    assert.equal(definition.model, 'configured-model');
    assert.ok(definition.tools.includes('Read'));
    assert.ok(definition.tools.includes('SendMessage'));
    assert.equal(definition.tools.includes('mcp__profilepilot__finish'), false);
  }
});

test('failed spawn releases pending state; resume keeps addresses but resets running state', () => {
  const state = new TaskCollaboration();
  state.before('Agent', { name: 'lost' }, 'failed-call'); state.after('failed-call');
  assert.equal(state.running, false);
  assert.ok(state.denial('SendMessage', { to: 'lost', message: 'No' }));
  const resumed = new TaskCollaboration([{ id: 'saved', name: 'old', status: 'running', description: 'old work', updatedAt: '' }]);
  assert.equal(resumed.running, false);
  assert.equal(resumed.denial('SendMessage', { to: 'old', message: 'Continue' }), undefined);
  assert.equal(resumed.activity({ subtype: 'task_started', task_id: 'saved' }).status, 'running');
  assert.equal(resumed.activity({ subtype: 'task_started', task_id: 'shell', task_type: 'local_bash' }), undefined);
});

test('activity view escapes model content and retains failed/interrupted results', () => {
  const html = renderAgentProgress({ agentActivities: [{ id: 'a', name: '<script>', description: '<img>', status: 'failed', summary: '<iframe>' }] });
  assert.ok(html.includes('失败')); assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(html.includes('<iframe>'), false);
});
