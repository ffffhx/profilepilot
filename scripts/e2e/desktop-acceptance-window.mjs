import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopAcceptanceWindowFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tools/desktop-verification/acceptance-window.json');

// A local test constraint, never bundled into ProfilePilot. GUI acceptance
// harnesses consult it before launching any window or sending desktop input.
export async function assertDesktopAcceptanceWindow({ gateFile = desktopAcceptanceWindowFile, now = Date.now() } = {}) {
  let gate;
  try { gate = JSON.parse(await readFile(gateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const notBefore = Date.parse(gate.notBefore);
  if (!Number.isFinite(notBefore)) throw new Error('Invalid desktop acceptance notBefore constraint.');
  if (now < notBefore) throw Object.assign(new Error(`Desktop acceptance is deferred until ${new Date(notBefore).toISOString()}: ${gate.reason || 'The user is using this computer.'}`), { code: 'DESKTOP_ACCEPTANCE_DEFERRED', notBefore: new Date(notBefore).toISOString() });
}
