const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TaskRecords } = require('../dist/main/tasks/records.js');
const { TaskStore } = require('../dist/main/tasks/store.js');

function root(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-records-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

for (const version of [1,2]) test(`v${version} migration preserves exact backup and can reopen all task data`, t => {
  const folder = root(t), seed = new TaskStore(path.join(folder,'seed'));
  const task = seed.create({ profileId:'fixture', prompt:'保留原始消息' }, 'Browser');
  task.status = 'paused'; task.receipts = [{id:'r',at:task.updatedAt,status:'verified',action:{kind:'click',effect:'read',summary:'read'}}];
  const bytes = JSON.stringify({ ...seed.snapshot(), version }, null, 2);
  const file = path.join(folder,'tasks.json'); fs.writeFileSync(file,bytes);
  const store = new TaskStore(folder);
  assert.equal(fs.readFileSync(`${file}.before-records.v${version}.bak`,'utf8'), bytes);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,3);
  const reopened = new TaskStore(folder);
  assert.deepEqual(reopened.get(task.id), store.get(task.id));
  assert.equal(reopened.get(task.id).events[0].text, '保留原始消息');
  assert.equal(reopened.get(task.id).receipts[0].status,'verified');
});

test('saving one task never reads or serializes another task history; metadata saves touch no histories', t => {
  const store = new TaskStore(root(t));
  const first = store.create({profileId:'fixture',prompt:'first'},'Browser');
  const untouched = store.create({profileId:'fixture',prompt:'untouched'},'Browser');
  const original = new Map(JSON.parse(fs.readFileSync(store.file,'utf8')).tasks.map(ref=>[ref.id,ref.record]));
  const history = store.sdkHistory(untouched.id);
  t.mock.method(history, 'refresh', () => assert.fail('Unchanged SDK transcript scanned'));
  Object.defineProperty(untouched,'events',{ get: () => assert.fail('Unchanged history serialized'), configurable:true });
  store.event(first,'assistant','changed'); store.save([first]);
  const next = new Map(JSON.parse(fs.readFileSync(store.file,'utf8')).tasks.map(ref=>[ref.id,ref.record]));
  assert.equal(next.get(untouched.id), original.get(untouched.id));
  assert.notEqual(next.get(first.id), original.get(first.id));
  t.mock.method(store.sdkHistory(first.id), 'refresh', () => assert.fail('Metadata change scanned a transcript'));
  store.data.settings.notifications = !store.data.settings.notifications;
  store.save([]);
  const writes = t.mock.method(fs,'writeFileSync', () => assert.fail('Unchanged save wrote to disk'));
  store.save([]); store.close();
  assert.equal(writes.mock.callCount(),0);
});

test('a manifest failure after record writes keeps the old committed task usable and can retry', t => {
  const folder = root(t), store = new TaskStore(folder);
  const task = store.create({profileId:'fixture',prompt:'before'},'Browser');
  const before = fs.readFileSync(store.file,'utf8');
  const rename = fs.renameSync;
  const failure = t.mock.method(fs,'renameSync',(from,to)=>{
    if(to===store.file) throw new Error('simulated Windows sharing violation');
    return rename(from,to);
  });
  store.event(task,'assistant','after');
  assert.throws(()=>store.save([task]),/sharing violation/);
  assert.equal(fs.readFileSync(store.file,'utf8'),before);
  assert.equal(new TaskRecords(folder).read().tasks[0].events.length,1);
  failure.mock.restore(); store.flush();
  assert.equal(new TaskRecords(folder).read().tasks[0].events.at(-1).text,'after');
});

test('missing or tampered task records stop startup without modifying the committed index', t => {
  const folder = root(t), store = new TaskStore(folder);
  store.create({profileId:'fixture',prompt:'preserve'},'Browser');
  const index = fs.readFileSync(store.file,'utf8');
  const reference = JSON.parse(index).tasks[0];
  const record = path.join(folder,'task-records',reference.record), original = fs.readFileSync(record);
  fs.writeFileSync(record,'{}'); assert.throws(()=>new TaskStore(folder),/校验失败/);
  assert.equal(fs.readFileSync(store.file,'utf8'),index);
  fs.unlinkSync(record); assert.throws(()=>new TaskStore(folder),/ENOENT/);
  fs.writeFileSync(record,original);
  assert.equal(new TaskStore(folder).data.tasks[0].prompt,'preserve');
});

test('pricing backups retain their referenced record bodies after updates and restarts', t => {
  const folder = root(t), store = new TaskStore(folder);
  const task = store.create({profileId:'fixture',prompt:'original'},'Browser');
  const reference = JSON.parse(fs.readFileSync(store.file,'utf8')).tasks[0];
  const oldFile = path.join(folder,'task-records',reference.record);
  const original = fs.readFileSync(oldFile,'utf8');
  store.records.backup('.before-pricing-1.bak');
  store.event(task,'assistant','update'); store.save([task]);
  const reopened = new TaskStore(folder), current = reopened.get(task.id);
  reopened.event(current,'assistant','next update'); reopened.save([current]);
  assert.equal(fs.readFileSync(oldFile,'utf8'),original);
  assert.equal(JSON.parse(fs.readFileSync(`${store.file}.before-pricing-1.bak`,'utf8')).tasks[0].record,reference.record);
});
