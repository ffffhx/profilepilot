const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { SmsInbox } = loadCli('src/main/phones/sms-inbox.ts');

test('SMS delivery is durable before acknowledgement, deduplicated across reconnects and limited to 100 visible messages', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sms-'));
  const notices = [];
  let locked = true;
  const protection = {
    encrypt(value) { if (locked) throw Error('key unavailable'); return Buffer.from(Buffer.from(value).toString('base64')); },
    decrypt: buffer => Buffer.from(buffer.toString(), 'base64').toString()
  };
  const make = () => new SmsInbox(dir, protection, name => notices.push(name));
  let inbox = make();
  t.after(() => { inbox.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const event = { event: 'sms:received', messageId: randomUUID(), sender: 'test sender', message: '长短信'.repeat(100),
    receivedAt: Date.now(), simNumber: 2 };
  assert.throws(() => inbox.receive('phone', 'Pixel', event));
  assert.deepEqual(inbox.list(), []);
  locked = false;
  assert.equal(inbox.receive('phone', 'Pixel', event), event.messageId);
  inbox.close(); inbox = make();
  assert.equal(inbox.receive('phone', 'Pixel', event), event.messageId);
  assert.deepEqual(notices, ['Pixel']);
  assert.deepEqual(inbox.list(), [{ ...event, deviceName: 'Pixel' }]);
  assert.ok(!fs.readFileSync(path.join(dir, 'sms-inbox.sqlite')).includes(Buffer.from(event.message)));
  assert.throws(() => inbox.receive('phone', 'Pixel', { ...event, simNumber: 0 }));
  for (let i = 0; i < 100; ++i) inbox.receive('phone', 'Pixel', { ...event, messageId: randomUUID(), simNumber: null });
  assert.equal(inbox.receive('phone', 'Pixel', event), event.messageId);
  assert.equal(notices.length, 101);
  assert.equal(inbox.list().length, 100);
  assert.ok(inbox.list().every(sms => sms.simNumber === null));
});
