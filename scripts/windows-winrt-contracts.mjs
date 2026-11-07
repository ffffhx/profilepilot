// Build-only references from the official Microsoft SDK package. None of this
// metadata or package code is executed or shipped as an application runtime.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const WINRT_CONTRACTS = Object.freeze({
  version: '10.0.19041.2',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.contracts/10.0.19041.2/microsoft.windows.sdk.contracts.10.0.19041.2.nupkg',
  length: 3666778,
  sha256: '379b663ea3ebaa7df78b2b2666190bbbabe5e11b221428c503c49c09310c7f78',
  files: Object.freeze([
    Object.freeze({ name: 'Windows.WinMD', length: 174080, sha256: '249d4ebdcb399002f7b6dcb50384ad0df3ab6a7cf7087161eda4e43052128e6d' }),
    Object.freeze({ name: 'Windows.Foundation.FoundationContract.winmd', length: 24576, sha256: '7f415384a27e313cbd240a24e0f8dcc82f72c8b3febc5b65b8e2f781c01e8ba1' }),
    Object.freeze({ name: 'Windows.Foundation.UniversalApiContract.winmd', length: 5858304, sha256: '863dae0871727cc424c07e737146b629abc516ca4d8c14914e0d81e9c637b587' })
  ])
});

const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(`Windows SDK references: ${message}`); };
const verified = (bytes, expected) => Buffer.isBuffer(bytes) && bytes.length === expected.length && digest(bytes) === expected.sha256;

// Deliberately supports only the ordinary, single-disk ZIP format used by the
// pinned package. Extracted paths come exclusively from the caller's whitelist;
// archive paths are never passed to the filesystem. Hashes validate the actual
// uncompressed bytes, including data-descriptor ZIP entries.
export function extractVerifiedZipFiles(archive, specifications) {
  requireValue(Buffer.isBuffer(archive) && archive.length >= 22 && archive.length <= MAX_PACKAGE_BYTES, 'invalid archive size');
  const expected = new Map(specifications.map(file => [file.entry, file]));
  requireValue(expected.size === specifications.length && expected.size > 0, 'invalid extraction whitelist');
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 65557); at--) {
    if (archive.readUInt32LE(at) === 0x06054b50 && at + 22 + archive.readUInt16LE(at + 20) === archive.length) { end = at; break; }
  }
  requireValue(end >= 0, 'missing ZIP end record');
  const count = archive.readUInt16LE(end + 10), centralSize = archive.readUInt32LE(end + 12), centralOffset = archive.readUInt32LE(end + 16);
  requireValue(archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0 && archive.readUInt16LE(end + 8) === count, 'multi-disk ZIP is unsupported');
  requireValue(count > 0 && count <= 512 && centralOffset + centralSize === end, 'invalid ZIP directory bounds');
  const result = new Map(), ranges = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    requireValue(cursor >= 0 && cursor + 46 <= end && archive.readUInt32LE(cursor) === 0x02014b50, 'invalid ZIP directory entry');
    const flags = archive.readUInt16LE(cursor + 8), compression = archive.readUInt16LE(cursor + 10);
    const compressedLength = archive.readUInt32LE(cursor + 20), length = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    requireValue(nameLength > 0 && next <= end && archive.readUInt16LE(cursor + 34) === 0, 'invalid ZIP entry bounds');
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength), name = rawName.toString('utf8');
    requireValue(!name.includes('\\') && !name.includes('\0') && !name.includes(':') && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.'), 'unsafe ZIP path');
    const specification = expected.get(name);
    if (specification) {
      requireValue(!result.has(name), 'duplicate whitelisted ZIP entry');
      requireValue((flags & 1) === 0 && [0, 8].includes(compression), 'encrypted or unsupported ZIP entry');
      requireValue(length === specification.length && length > 0 && length <= 6 * 1024 * 1024 && compressedLength <= MAX_PACKAGE_BYTES, 'unexpected extracted size');
      requireValue(localOffset + 30 <= centralOffset && archive.readUInt32LE(localOffset) === 0x04034b50, 'invalid ZIP local entry');
      const localNameLength = archive.readUInt16LE(localOffset + 26), localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      requireValue(archive.readUInt16LE(localOffset + 6) === flags && archive.readUInt16LE(localOffset + 8) === compression && localNameLength === nameLength && dataOffset + compressedLength <= centralOffset, 'inconsistent ZIP local entry');
      requireValue(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(rawName), 'inconsistent ZIP local path');
      requireValue(ranges.every(range => dataOffset >= range.end || dataOffset + compressedLength <= range.start), 'overlapping ZIP entry data');
      ranges.push({ start: dataOffset, end: dataOffset + compressedLength });
      const compressed = archive.subarray(dataOffset, dataOffset + compressedLength);
      const bytes = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: length });
      requireValue(verified(bytes, specification), `uncompressed hash mismatch for ${name}`);
      result.set(name, bytes);
    }
    cursor = next;
  }
  requireValue(cursor === end && result.size === expected.size, 'missing whitelisted ZIP entries');
  return result;
}

export async function downloadSdkPackage(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000, maximumBytes = MAX_PACKAGE_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Windows SDK download timed out')), timeoutMs);
  let reader;
  try {
    let address = new URL(url), response;
    for (let redirects = 0; ; redirects++) {
      requireValue(address.protocol === 'https:' && !address.username && !address.password, 'download redirects must use HTTPS without credentials');
      response = await fetchImpl(address.href, { redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      requireValue(redirects < 3 && response.headers.get('location'), 'too many or invalid download redirects');
      address = new URL(response.headers.get('location'), address);
      await response.body?.cancel();
    }
    requireValue(response.ok && response.body, `download failed with HTTP ${response.status}`);
    const declared = response.headers.get('content-length');
    requireValue(declared === null || (/^\d+$/.test(declared) && Number(declared) <= maximumBytes), 'download exceeds the size limit');
    reader = response.body.getReader();
    const chunks = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length; requireValue(length <= maximumBytes, 'download exceeds the size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch {} }
    controller.abort();
  }
}

async function readVerified(file, expected) {
  try {
    const information = await stat(file);
    if (!information.isFile() || information.size !== expected.length) return undefined;
    const bytes = await readFile(file); return verified(bytes, expected) ? bytes : undefined;
  }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function writeAtomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function ensureWindowsWinrtContracts(root, { platform = process.platform, cacheDirectory, download = downloadSdkPackage } = {}) {
  // Importing this module is safe on macOS/Linux. Calling the resolver there
  // never probes Windows directories, creates caches or accesses the network.
  if (platform !== 'win32') return { version: WINRT_CONTRACTS.version, references: [], skipped: true };
  const directory = cacheDirectory || path.join(root, 'node_modules', '.cache', 'profilepilot', 'windows-winrt-contracts', WINRT_CONTRACTS.version);
  const references = WINRT_CONTRACTS.files.map(file => path.join(directory, file.name));
  const existing = await Promise.all(WINRT_CONTRACTS.files.map((file, index) => readVerified(references[index], file)));
  if (!existing.every(Boolean)) {
    await mkdir(directory, { recursive: true });
    const packagePath = path.join(directory, 'Microsoft.Windows.SDK.Contracts.nupkg');
    let archive = await readVerified(packagePath, WINRT_CONTRACTS);
    if (!archive) {
      archive = await download(WINRT_CONTRACTS.url);
      requireValue(verified(archive, WINRT_CONTRACTS), 'downloaded package SHA-256 or length mismatch');
      await writeAtomic(packagePath, archive);
    }
    const specifications = WINRT_CONTRACTS.files.map(file => ({ ...file, entry: `ref/netstandard2.0/${file.name}` }));
    const extracted = extractVerifiedZipFiles(archive, specifications);
    for (let index = 0; index < specifications.length; index++) await writeAtomic(references[index], extracted.get(specifications[index].entry));
  }
  // Return actual content hashes so the native build identity includes every
  // compiler input, even when a cache was recovered during this invocation.
  const hashes = await Promise.all(references.map(async (file, index) => {
    const bytes = await readVerified(file, WINRT_CONTRACTS.files[index]);
    requireValue(bytes, 'reference changed while validating the build cache');
    return { name: WINRT_CONTRACTS.files[index].name, sha256: digest(bytes) };
  }));
  return { version: WINRT_CONTRACTS.version, packageSha256: WINRT_CONTRACTS.sha256, references, hashes };
}

// Shared by the production compiler and isolated native test compilers. Keep
// the three SDK contracts and CLR projection facades together at every callsite.
export async function resolveWindowsWinrtReferences(root, options = {}) {
  const sdk = await ensureWindowsWinrtContracts(root, options);
  if (sdk.skipped) return sdk;
  const framework = options.framework || path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const facades = ['System.Runtime.dll', 'System.Runtime.WindowsRuntime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll'].map(name => path.join(framework, name));
  const hashes = await Promise.all(facades.map(async file => ({ name: path.basename(file), sha256: digest(await readFile(file)) })));
  return { ...sdk, references: [...sdk.references, ...facades], hashes: [...sdk.hashes, ...hashes] };
}
