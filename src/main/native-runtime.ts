import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Windows keeps a running executable locked. Publish a complete, verified copy
// before spawn so rebuilding its bundled source never replaces a live binary.
export function nativeRuntimeCopy(source: string, cacheName: string): string {
  if (!/^profilepilot-[a-z-]+-runtime$/.test(cacheName)) throw new Error('Invalid native runtime cache name.');
  const bytes = readFileSync(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(os.tmpdir(), cacheName);
  mkdirSync(directory, { recursive: true });
  const cached = path.join(directory, digest + '.exe');
  const matches = () => {
    try { return createHash('sha256').update(readFileSync(cached)).digest('hex') === digest; }
    catch { return false; }
  };
  if (matches()) return cached;
  const unique = path.join(directory, `${digest}.${randomUUID()}`);
  const temporary = unique + '.tmp';
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o700 });
    try {
      linkSync(temporary, cached);
      return cached;
    } catch {
      if (matches()) return cached;
      // Preserve an unreadable/corrupt entry which another process may still
      // use; atomically publish an independent complete copy instead.
      const repaired = unique + '.exe';
      renameSync(temporary, repaired);
      return repaired;
    }
  } finally { rmSync(temporary, { force: true }); }
}
