import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Reserve a range per commit: local rebuilds may replace each other, while the
// next pushed commit always upgrades both an installed CI build and a local build.
export function androidDevelopmentVersion(properties, commitCount, local = true) {
  const baseName = /^versionName=([0-9A-Za-z.+-]{1,50})\s*$/m.exec(properties)?.[1];
  if (!baseName || !Number.isSafeInteger(commitCount) || commitCount < 1 || commitCount > 2098999)
    throw new Error('Invalid development version or Git commit count.');
  const versionCode = 1000000 + commitCount * 1000 + (local ? 999 : 0);
  return { versionCode, versionName: `${baseName}+${local ? 'local' : 'build'}.${commitCount}`, tag: `android-dev-${versionCode}` };
}

export function developmentVersion(root, local = true) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false')
    throw new Error('Development updates require full Git history; run git fetch --unshallow first.');
  return androidDevelopmentVersion(readFileSync(path.join(root, 'android-phone/version.properties'), 'utf8'),
    Number(git(['rev-list', '--count', 'HEAD'])), local);
}
