const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../dist/main/tasks/store');
const { captureTaskSkill, taskSkillCatalog, canReadTaskSkill } = require('../dist/main/tasks/skills');
const { taskModelContext } = require('../dist/main/tasks/model-context');
const { authorizeTaskRead, registerTaskOutputs } = require('../dist/main/tasks/files');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-skill-'));
  const source = path.join(root, 'skills', 'job-search');
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: job-search\ndescription: Find jobs\n---\nRead references only when needed.');
  fs.writeFileSync(path.join(source, 'scripts', 'report.py'), 'print("version one")');
  const definition = { schemaVersion: 1, id: 'job-search', version: '1.0.0', title: '找工作', description: '查找岗位', goal: 'Find jobs', inputs: [{ key: 'role', label: '岗位', type: 'text', required: true }] };
  fs.writeFileSync(path.join(source, 'agents', 'profilepilot.json'), JSON.stringify(definition));
  const oldRoots = process.env.PROFILEPILOT_SKILL_ROOTS;
  process.env.PROFILEPILOT_SKILL_ROOTS = path.join(root, 'skills');
  t.after(() => { if (oldRoots === undefined) delete process.env.PROFILEPILOT_SKILL_ROOTS; else process.env.PROFILEPILOT_SKILL_ROOTS = oldRoots; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, definition, store: new TaskStore(path.join(root, 'store')) };
}

test('selected skill is validated, snapshotted and available after source changes', t => {
  const f = fixture(t);
  const task = f.store.create({ profileId: 'test', prompt: 'Find roles', skill: { id: 'job-search', parameters: { role: '前端' } } }, 'Test');
  assert.equal(task.skill.version, '1.0.0');
  assert.equal(task.skill.parameters.role, '前端');
  assert.equal(taskModelContext(task).selectedSkill.digest, task.skill.digest);
  const captured = path.join(task.skill.root, 'scripts', 'report.py');
  fs.writeFileSync(path.join(f.source, 'scripts', 'report.py'), 'print("changed")');
  assert.match(fs.readFileSync(captured, 'utf8'), /version one/);
  assert.equal(authorizeTaskRead(task, captured).allowed, true);
  assert.equal(authorizeTaskRead(task, path.join(f.source, 'scripts', 'report.py')).allowed, false);
  assert.equal(canReadTaskSkill(task.skill, f.store.file), false);
  const reopened = new TaskStore(f.store.root);
  assert.equal(reopened.get(task.id).skill.digest, task.skill.digest);
  assert.equal(reopened.snapshot().skills[0].id, 'job-search');
});

test('missing fields and unknown skills fail without enqueueing a task', t => {
  const f = fixture(t);
  assert.throws(() => f.store.create({ profileId: 'test', prompt: 'Find jobs', skill: { id: 'job-search', parameters: {} } }, 'Test'), /岗位/);
  assert.throws(() => captureTaskSkill({ id: 'job-search', parameters: { role: 'test', injected: 'x' } }, f.store.root), /未知/);
  assert.throws(() => captureTaskSkill({ id: 'absent', parameters: {} }, f.store.root), /不可用/);
  assert.equal(f.store.data.tasks.length, 0);
});

test('bad manifests are isolated and linked aliases are deduplicated', t => {
  const f = fixture(t);
  const otherRoot = path.join(f.root, 'alias'); fs.mkdirSync(otherRoot);
  fs.symlinkSync(f.source, path.join(otherRoot, 'job-search'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(taskSkillCatalog([path.dirname(f.source), otherRoot]).skills.length, 1);
  fs.writeFileSync(path.join(f.source, 'agents', 'profilepilot.json'), JSON.stringify({ ...f.definition, inputs: [...f.definition.inputs, ...f.definition.inputs] }));
  const result = taskSkillCatalog(); assert.equal(result.skills.length, 0); assert.equal(result.issues.length, 1);
});

test('skill resource links cannot escape the selected package', t => {
  const f = fixture(t);
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'private.txt'), 'outside');
  fs.symlinkSync(external, path.join(f.source, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureTaskSkill({ id: 'job-search', parameters: { role: 'test' } }, f.store.root), /目录之外/);
});

test('registering generated artifacts preserves sibling links and rejects outside files', t => {
  const f = fixture(t), workspace = path.join(f.root, 'workspace'); fs.mkdirSync(workspace);
  const task = f.store.create({ profileId: 'test', prompt: 'report' }, 'Test');
  fs.writeFileSync(path.join(workspace, 'report.html'), '<a href="data.csv">data</a>');
  fs.writeFileSync(path.join(workspace, 'data.csv'), 'date,price\n2025-01-01,100');
  const outputs = registerTaskOutputs(task, workspace, f.store.root, { paths: ['report.html', 'data.csv'] });
  assert.equal(path.dirname(outputs[0].path), path.dirname(outputs[1].path));
  assert.equal(authorizeTaskRead(task, outputs[0].path).allowed, true);
  assert.throws(() => registerTaskOutputs(task, workspace, f.store.root, { paths: [f.store.file] }), /当前任务/);
  assert.equal(task.outputs.length, 2);
  fs.writeFileSync(path.join(workspace, 'report.html'), 'changed');
  assert.match(fs.readFileSync(outputs[0].path, 'utf8'), /data.csv/);
});
