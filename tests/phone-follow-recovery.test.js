const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { FollowRecovery } = loadCli('src/main/phones/follow-recovery.ts');

test('recovery merges concurrent observers and bounds attempts and frequency', async () => {
  let now = 0, calls = 0;
  const recovery = new FollowRecovery(() => now);
  for (let i = 0; i < 3; i++) {
    recovery.lost();
    const attempt = async () => { calls++; return 'same-session'; };
    const first = recovery.recover(() => {}, attempt), concurrent = recovery.recover(() => {}, attempt);
    assert.equal(first, concurrent); assert.equal(await first, 'same-session');
    assert.equal(recovery.waiting, false);
    recovery.lost();
    await assert.rejects(recovery.recover(() => {}, attempt), /次数、间隔/);
    recovery.cancel(); now += 10000;
  }
  recovery.lost(); await assert.rejects(recovery.recover(() => {}, async () => 'fourth'), /次数、间隔/);
  assert.equal(calls, 3);
});

test('recovery cannot return a late connection after user stop or authority change', async () => {
  for (const cancel of [false, true]) {
    const recovery = new FollowRecovery(); let release, active = true;
    recovery.lost();
    const pending = recovery.recover(() => { if (!active) throw new Error('owner changed'); },
      () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve(); active = false;
    if (cancel) recovery.cancel();
    release('old result'); await assert.rejects(pending, /owner changed|取消/);
    assert.equal(recovery.waiting, false);
  }
});

test('two-second recovery deadline also bounds a stalled connection attempt', { timeout: 3000 }, async () => {
  const recovery = new FollowRecovery(), began = Date.now(); let signal;
  recovery.lost();
  await assert.rejects(recovery.recover(() => {}, value => { signal = value; return new Promise(() => {}); }), /两秒/);
  assert.equal(signal.aborted, true); assert.ok(Date.now() - began < 2500);
});
