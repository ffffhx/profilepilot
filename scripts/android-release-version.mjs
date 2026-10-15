import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Main's append-only Git history advances on every push, including merge commits.
// Unlike workflow run counters, this sequence is shared by manual and tag builds.
export function androidReleaseVersion(properties, commitCount) {
  const baseName = /^versionName=([0-9A-Za-z.+-]{1,60})\s*$/m.exec(properties)?.[1];
  const baseCode = Number(/^versionCode=(\d+)\s*$/m.exec(properties)?.[1]);
  if (!baseName || !Number.isSafeInteger(baseCode) || baseCode < 1 || baseCode >= 1000000
      || !Number.isSafeInteger(commitCount) || commitCount < 1 || commitCount > 2098999999)
    throw new Error('Invalid Android base version or Git commit count.');
  const versionCode = 1000000 + commitCount;
  return { versionCode, versionName: `${baseName}+build.${commitCount}`, tag: `android-${versionCode}` };
}

export function configureAndroidRelease(root, env = process.env) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false')
    throw new Error('Android versioning requires checkout fetch-depth: 0.');
  const version = androidReleaseVersion(readFileSync(path.join(root, 'android-phone/version.properties'), 'utf8'), Number(git(['rev-list', '--count', 'HEAD'])));
  if (!env.GITHUB_ENV || !env.GITHUB_OUTPUT) throw new Error('Run this version configuration inside GitHub Actions.');
  appendFileSync(env.GITHUB_ENV, `PROFILEPILOT_ANDROID_VERSION_CODE=${version.versionCode}\nPROFILEPILOT_ANDROID_VERSION_NAME=${version.versionName}\n`);
  appendFileSync(env.GITHUB_OUTPUT, `tag=${version.tag}\n`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(configureAndroidRelease(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))));
}
