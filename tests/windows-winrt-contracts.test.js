const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');
const sdk = import('../scripts/windows-winrt-contracts.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const content = Buffer.from('owned build-only metadata fixture');
const entry = 'ref/netstandard2.0/Windows.WinMD';
const specification = { entry, length: content.length, sha256: hash(content) };
async function removeFixtureDirectory(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^profilepilot-winrt-(corrupt|repair)-/);
  await rm(resolved, { recursive: true, force: true });
}

function archive(entries) {
  const locals = [], central = []; let offset = 0;
  for (const value of entries) {
    const name = Buffer.from(value.name), bytes = value.bytes || content;
    const compression = value.compression ?? 8, payload = compression === 8 ? deflateRawSync(bytes) : bytes;
    const length = value.length ?? bytes.length, flags = value.flags || 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8); header.writeUInt16LE(compression, 10);
    header.writeUInt32LE(payload.length, 20); header.writeUInt32LE(length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, name, payload); central.push(header, name); offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('ZIP extraction returns only hash-verified whitelist data without executing other package content', async () => {
  const { extractVerifiedZipFiles } = await sdk;
  for (const compression of [0, 8]) {
    const result = extractVerifiedZipFiles(archive([{ name: entry, compression }, { name: 'tools/install.ps1', bytes: Buffer.from('throw "must never run"') }]), [specification]);
    assert.deepEqual([...result.keys()], [entry]); assert.deepEqual(result.get(entry), content);
  }
});

test('ZIP extraction rejects traversal paths, duplicate or missing entries and mismatched local paths', async () => {
  const { extractVerifiedZipFiles } = await sdk;
  for (const name of ['../escape', '/absolute', 'C:/escape', 'ref\\escape', 'ref/../escape']) {
    assert.throws(() => extractVerifiedZipFiles(archive([{ name: entry }, { name }]), [specification]), /unsafe ZIP path/);
  }
  assert.throws(() => extractVerifiedZipFiles(archive([{ name: entry }, { name: entry }]), [specification]), /duplicate/);
  assert.throws(() => extractVerifiedZipFiles(archive([{ name: 'other' }]), [specification]), /missing whitelisted/);
  const differentLocalName = archive([{ name: entry }]); differentLocalName[30] = 120;
  assert.throws(() => extractVerifiedZipFiles(differentLocalName, [specification]), /local path/);
});

test('ZIP entry bounds and decompression limits reject malformed archives and expanded payloads', async () => {
  const { extractVerifiedZipFiles } = await sdk;
  const invalidDirectory = archive([{ name: entry }]); invalidDirectory.writeUInt32LE(0xffffffff, invalidDirectory.length - 6);
  assert.throws(() => extractVerifiedZipFiles(invalidDirectory, [specification]), /directory bounds/);
  assert.throws(() => extractVerifiedZipFiles(archive([{ name: entry, flags: 1 }]), [specification]), /encrypted/);
  assert.throws(() => extractVerifiedZipFiles(archive([{ name: entry, bytes: Buffer.alloc(100000), length: content.length }]), [specification]), /larger than|buffer|output/i);
  assert.throws(() => extractVerifiedZipFiles(archive([{ name: entry, bytes: Buffer.alloc(content.length) }]), [specification]), /hash mismatch/);
});

test('download enforces declared and streamed limits and propagates its abort deadline', async () => {
  const { downloadSdkPackage } = await sdk;
  await assert.rejects(downloadSdkPackage('https://example.test/sdk', { maximumBytes: 2, fetchImpl: async () => new Response('abc', { headers: { 'content-length': '3' } }) }), /size limit/);
  await assert.rejects(downloadSdkPackage('https://example.test/sdk', { maximumBytes: 2, fetchImpl: async () => new Response('abc') }), /size limit/);
  await assert.rejects(downloadSdkPackage('https://example.test/sdk', { timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), /timed out/);
});

test('download permits bounded HTTPS redirects and rejects insecure destinations or redirect loops', async () => {
  const { downloadSdkPackage } = await sdk;
  const locations = [];
  const data = await downloadSdkPackage('https://example.test/sdk', { fetchImpl: async address => {
    locations.push(address);
    return locations.length === 1 ? new Response('', { status: 302, headers: { location: 'https://cdn.example.test/sdk' } }) : new Response(content);
  } });
  assert.deepEqual(data, content); assert.equal(locations.length, 2);
  await assert.rejects(downloadSdkPackage('https://example.test/sdk', { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://example.test/sdk' } }) }), /HTTPS/);
  let count = 0;
  await assert.rejects(downloadSdkPackage('https://example.test/sdk', { fetchImpl: async () => { count++; return new Response('', { status: 302, headers: { location: '/again' } }); } }), /too many/);
  assert.equal(count, 4);
});

test('non-Windows resolution does not touch disk or fetch a Windows dependency', async () => {
  const { resolveWindowsWinrtReferences } = await sdk;
  const result = await resolveWindowsWinrtReferences('missing-project-directory', { platform: 'darwin', download: async () => { throw new Error('unexpected download'); } });
  assert.equal(result.skipped, true); assert.deepEqual(result.references, []);
  await assert.rejects(stat('missing-project-directory'), { code: 'ENOENT' });
});

test('matching file lengths cannot make corrupted cached references trusted', async t => {
  const { WINRT_CONTRACTS, ensureWindowsWinrtContracts } = await sdk;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'profilepilot-winrt-corrupt-'));
  t.after(() => removeFixtureDirectory(directory));
  for (const file of WINRT_CONTRACTS.files) await writeFile(path.join(directory, file.name), Buffer.alloc(file.length));
  let downloads = 0;
  await assert.rejects(ensureWindowsWinrtContracts('', { platform: 'win32', cacheDirectory: directory, download: async () => { downloads++; return Buffer.from('untrusted package'); } }), /SHA-256/);
  assert.equal(downloads, 1);
  await assert.rejects(stat(path.join(directory, 'Microsoft.Windows.SDK.Contracts.nupkg')), { code: 'ENOENT' });
});

test('the pinned official cache can repair a changed reference without a network request', async t => {
  const { WINRT_CONTRACTS, ensureWindowsWinrtContracts } = await sdk;
  const installed = path.resolve(__dirname, '../node_modules/.cache/profilepilot/windows-winrt-contracts', WINRT_CONTRACTS.version, 'Microsoft.Windows.SDK.Contracts.nupkg');
  let official;
  try { official = await readFile(installed); } catch (error) { if (error.code === 'ENOENT') return t.skip('Build the Windows helper once to create its pinned package cache'); throw error; }
  assert.equal(hash(official), WINRT_CONTRACTS.sha256);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'profilepilot-winrt-repair-'));
  t.after(() => removeFixtureDirectory(directory));
  await writeFile(path.join(directory, 'Microsoft.Windows.SDK.Contracts.nupkg'), official);
  const options = { platform: 'win32', cacheDirectory: directory, download: async () => { throw new Error('unexpected download'); } };
  const first = await ensureWindowsWinrtContracts('', options);
  await writeFile(first.references[1], Buffer.alloc(WINRT_CONTRACTS.files[1].length));
  const repaired = await ensureWindowsWinrtContracts('', options);
  assert.deepEqual(repaired.hashes.map(file => file.sha256), WINRT_CONTRACTS.files.map(file => file.sha256));
  await writeFile(path.join(directory, 'Microsoft.Windows.SDK.Contracts.nupkg'), Buffer.alloc(official.length));
  await writeFile(first.references[1], Buffer.alloc(WINRT_CONTRACTS.files[1].length));
  await assert.rejects(ensureWindowsWinrtContracts('', options), /unexpected download/);
});
