import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processAlive } from './connection';

/** Only the owner writes secrets/discovery. Incomplete locks get a startup
 * grace period; a live or inaccessible PID is never treated as stale. */
export function acquireBrowserServiceLock(root: string): (() => void) | undefined {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, 'browser-service.lock');
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  for (let attempt = 0; attempt < 4; attempt++) {
    try { writeFileSync(file, owner, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const previous = JSON.parse(readFileSync(file, 'utf8'));
        stale = Number.isSafeInteger(previous.pid) && previous.pid > 0 && !processAlive(previous.pid);
      } catch { try { stale = Date.now() - statSync(file).mtimeMs > 30000; } catch { /* Another starter changed it. */ } }
      if (!stale) return;
      // A separate exclusive recovery marker serializes stale-file removal.
      const recovery = `${file}.recovery`;
      try { writeFileSync(recovery, owner, { flag: 'wx', mode: 0o600 }); }
      catch {
        // A process may die during the few synchronous recovery operations.
        // Never remove a marker whose owner is alive or whose write is recent.
        try { const previous = JSON.parse(readFileSync(recovery, 'utf8')); if (Number.isSafeInteger(previous.pid) && previous.pid > 0 && !processAlive(previous.pid)) { rmSync(recovery); continue; } } catch {}
        return;
      }
      try {
        let previous;
        try { previous = JSON.parse(readFileSync(file, 'utf8')); }
        catch { if (Date.now() - statSync(file).mtimeMs <= 30000) return; }
        if (previous && (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || processAlive(previous.pid))) return;
        const retired = `${file}.${randomUUID()}.stale`;
        renameSync(file, retired); rmSync(retired);
      } finally { rmSync(recovery, { force: true }); }
      continue;
    }
    return () => { try { if (readFileSync(file, 'utf8') === owner) rmSync(file); } catch {} };
  }
}
