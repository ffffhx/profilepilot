require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { portableDownloadName, registerNativeDownload, taskArtifactDirectory } = require('../src/main/tasks/native-downloads.ts');

test('portable filenames handle Windows paths, reserved names and Unicode on either host', () => {
  assert.equal(portableDownloadName('C:\\Users\\test\\Downloads\\résumé.csv'), 'résumé.csv');
  assert.equal(portableDownloadName('/Users/test/Downloads/report.csv'), 'report.csv');
  assert.equal(portableDownloadName('CON.txt'), '_CON.txt');
  assert.equal(portableDownloadName('bad:file?.csv'), 'bad_file_.csv');
  assert.ok(Buffer.byteLength(portableDownloadName('文'.repeat(300))) <= 180);
  assert.throws(() => taskArtifactDirectory('/tmp/artifacts', '../elsewhere'), /无效/);
});

test('concurrent waits register one artifact while different download IDs remain independent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-download-race-'));
  try {
    const source = path.join(root, '报告.txt'), content = 'verified synthetic download\n中文\n';
    await fs.writeFile(source, content);
    const task = { id: 'race-task', sessionId: 'race-session', profileId: 'native:test' };
    const item = { id: 8, state: 'complete', filename: source, bytesReceived: Buffer.byteLength(content) };
    const results = await Promise.all([
      ...Array.from({ length: 16 }, () => registerNativeDownload(root, task, item)),
      registerNativeDownload(root, task, { ...item, id: 9 })
    ]);
    assert.equal(task.outputs.length, 2);
    for (const result of results.slice(0, 16)) assert.strictEqual(result, results[0]);
    assert.notEqual(results[16].id, results[0].id);
    assert.equal(await fs.readFile(results[0].path, 'utf8'), content);
    assert.equal(await fs.readFile(results[16].path, 'utf8'), content);
    assert.deepEqual(await registerNativeDownload(root, task, item), results[0]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed registration releases its pending entry and never adopts unregistered files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-download-recovery-'));
  try {
    const source = path.join(root, 'report.txt');
    const task = { id: 'retry-task', sessionId: 'retry-session', profileId: 'native:test' };
    const item = { id: 1, state: 'complete', filename: source, bytesReceived: 4 };
    const failed = await Promise.allSettled([registerNativeDownload(root, task, item), registerNativeDownload(root, task, item)]);
    assert.deepEqual(failed.map(result => result.status), ['rejected', 'rejected']);
    await fs.writeFile(source, 'good');
    const output = await registerNativeDownload(root, task, item);
    assert.equal(await fs.readFile(output.path, 'utf8'), 'good');
    assert.equal(task.outputs.length, 1);
    const orphanId = 'download-' + createHash('sha256').update(`${task.profileId}\0${task.sessionId}\0${2}`).digest('hex').slice(0, 24);
    const directory = path.join(root, task.id, orphanId);
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'report.txt'), 'other content');
    await assert.rejects(registerNativeDownload(root, task, { ...item, id: 2 }), /已存在但未登记/);
    assert.equal(await fs.readFile(path.join(directory, 'report.txt'), 'utf8'), 'other content');
    assert.equal(task.outputs.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('conflicting concurrent metadata is rejected without borrowing another caller success', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-download-metadata-'));
  try {
    const source = path.join(root, 'report.txt'); await fs.writeFile(source, 'valid');
    const task = { id: 'task', sessionId: 'session', profileId: 'native:test' };
    const item = { id: 1, state: 'complete', filename: source, bytesReceived: 5 };
    const valid = registerNativeDownload(root, task, item);
    await assert.rejects(registerNativeDownload(root, task, { ...item, bytesReceived: 999 }), /并发登记信息不一致/);
    const output = await valid;
    assert.equal(output.size, 5); assert.equal(task.outputs.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('exact download IDs copy complete files, preserve same-name outputs, and register once', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-dom-download-'));
  try {
    const source = path.join(root, 'report.csv'); await fs.writeFile(source, 'id,value\n1,redirect-content\n');
    const size = (await fs.stat(source)).size, task = { id: 'task', sessionId: 'session', profileId: 'native:test' };
    const item = { id: 10, state: 'complete', filename: source, bytesReceived: size, url: 'https://fixture.test/redirect', finalUrl: 'https://fixture.test/content' };
    const a = await registerNativeDownload(path.join(root, 'artifacts'), task, item);
    const again = await registerNativeDownload(path.join(root, 'artifacts'), task, item);
    const b = await registerNativeDownload(path.join(root, 'artifacts'), task, { ...item, id: 11 });
    assert.deepEqual(a, again); assert.equal(task.outputs.length, 2); assert.notEqual(a.path, b.path);
    assert.match(await fs.readFile(a.path, 'utf8'), /redirect-content/);
    assert.equal((await fs.stat(source)).size, size);
    await assert.rejects(registerNativeDownload(root, task, { ...item, id: 12, state: 'interrupted', error: 'USER_CANCELED' }), /USER_CANCELED/);
    await assert.rejects(registerNativeDownload(root, task, { ...item, id: 12, state: 'in_progress' }), /尚未完成/);
    await assert.rejects(registerNativeDownload(root, task, { ...item, id: 12, exists: false }), /没有可读取/);
    await assert.rejects(registerNativeDownload(root, task, { ...item, id: 12, bytesReceived: 999 }), /大小不匹配/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
