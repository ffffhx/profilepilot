// Isolated task authority for Android instrumentation. No real browser/model calls.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadTsModule } = require('../tests/helpers/load-ts-module');
const { MobileService } = loadTsModule('src/main/mobile/service.ts');
const { TaskStore } = loadTsModule('src/main/tasks/store.ts');
const { TaskService } = loadTsModule('src/main/tasks/service.ts');
const root = path.resolve(process.argv[2] || 'artifacts/mobile-workspace-20261005/android-fixture');
fs.mkdirSync(root, { recursive: true });
const store = new TaskStore(path.join(root, 'tasks'));
const tasks = new TaskService(store, { browser: { control: async () => {}, tabs: async () => [] }, apiKey: () => '', prepareProfile: async () => ({ name: 'Android test Profile', port: 9223 }), profileName: async () => 'Android test Profile', changed: () => {}, notify: () => {}, listModels: async () => ['test-model'] });
tasks.tick = async () => {};
if (!store.data.tasks.length) {
  const task = store.create({ profileId: 'isolated:android', prompt: 'Verify mobile confirmation' }, 'Android test Profile');
  task.status = 'waiting_user'; task.pending = { id: randomUUID(), kind: 'question', title: '请选择需要的格式', details: '请确认本次测试任务的输出格式。', createdAt: new Date().toISOString() };
  store.event(task, 'assistant', '电脑已完成准备，等待手机回答。');
  const complete = store.create({ profileId: 'isolated:android', prompt: 'Completed result sample' }, 'Android test Profile');
  complete.status = 'completed'; complete.result = { kind: 'completed', summary: '手机和电脑共享的真实任务记录。', evidence: ['Isolated test authority'], remaining: [] };
  tasks.publish();
}
const service = new MobileService({ root: path.join(root, 'mobile'), tasks, computerName: 'Android Test PC', profiles: async () => [{ id: 'isolated:android', name: 'Android test Profile', source: 'isolated', ready: true }] });
(async () => {
  await service.configure({ enabled: true });
  const makePair = async () => { const pairing = await service.pair(`https://10.0.2.2:${service.snapshot().port}`); fs.writeFileSync(path.join(root, 'pairing.txt'), pairing.uri); };
  await makePair();
  // Renew only for test setup; never expose credentials in console output.
  const renewal = setInterval(() => void makePair(), 120000);
  const close = async () => { clearInterval(renewal); await service.close(); await tasks.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  console.log('Android fixture ready on port ' + service.snapshot().port);
})();
