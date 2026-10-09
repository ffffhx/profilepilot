const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readProfileAvatar } = require('../dist/main/profile-avatar');

test('local Chrome avatars load, invalidate after changes, and reject paths and non-images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-avatar-'));
  const file = path.join(root, 'Google Profile Picture.png');
  try {
    assert.equal(await readProfileAvatar(root), null);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    await writeFile(file, png);
    assert.equal(await readProfileAvatar(root), `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(await readProfileAvatar(root), await readProfileAvatar(root));
    for (const invalid of ['../secret.png', '..\\secret.png', 'C:\\secret.png', 'https://example.com/avatar', '..']) assert.equal(await readProfileAvatar(root, invalid), null);
    await writeFile(file, '<svg onload="alert(1)"></svg>');
    assert.equal(await readProfileAvatar(root), null, 'a cached image must not survive replacement');
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(await readProfileAvatar(root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
