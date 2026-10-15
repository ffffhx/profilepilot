const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const sha = 'a'.repeat(40);
const root = path.resolve(__dirname, '..');
function assets(code = 1000200, content = Buffer.from([0x50, 0x4b, 3, 4, 1, 2])) {
  const hash = createHash('sha256').update(content).digest('hex');
  return { 'ProfilePilot-android.apk': content,
    'ProfilePilot-android.apk.sha256': Buffer.from(`${hash}  ProfilePilot-android.apk\n`),
    'ProfilePilot-android-update.json': Buffer.from(JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.profilepilot.phone',
      versionCode: code, versionName: '0.3.3+build.200', minSdk: 30, notes: '手机更新', size: content.length, sha256: hash,
      url: `https://github.com/ffffhx/profilepilot/releases/download/android-${code}/ProfilePilot-android.apk` })) };
}
class Remote {
  releases = new Map(); events = []; failure = null;
  async find(tag) { return this.releases.get(tag) || null; }
  async create(tag, name, body, target) {
    this.events.push(['create', tag]); const release = { tag, name, body, target, draft: true, files: {} };
    this.releases.set(tag, release); return release;
  }
  async read(release, name) { return release.files[name] || null; }
  async upload(release, name, bytes) {
    this.events.push(['upload', release.tag, name]);
    if (this.failure === `${release.tag}/${name}`) throw new Error('Simulated upload failure');
    release.files[name] = bytes;
  }
  async publish(release, body) {
    this.events.push(['publish', release.tag]);
    if (this.failure === `publish/${release.tag}`) throw new Error('Simulated publish failure');
    release.draft = false; release.body = body;
  }
}

test('Android versions increase with main history and stay identical for reruns/manual/tag builds of a commit', async () => {
  const { androidReleaseVersion } = await import('../scripts/android-release-version.mjs');
  const properties = 'versionCode=9\r\nversionName=0.3.3\r\n';
  assert.deepEqual(androidReleaseVersion(properties, 200), { versionCode: 1000200, versionName: '0.3.3+build.200', tag: 'android-1000200' });
  assert.equal(androidReleaseVersion(properties, 201).versionCode, 1000201);
  for (const value of [0, -1, 1.5, NaN, 2100000000]) assert.throws(() => androidReleaseVersion(properties, value));
  assert.throws(() => androidReleaseVersion('versionCode=9\nversionName=bad name\n', 200));
  assert.throws(() => androidReleaseVersion('versionCode=1000000\nversionName=1.0\n', 200));
});
test('publish immutable APK before feed; manifest is replaced last and source commit is recorded', async () => {
  const { publishAndroidUpdate } = await import('../scripts/publish-android-update.mjs');
  const remote = new Remote(); const result = await publishAndroidUpdate(remote, assets(), sha);
  assert.equal(result.published, true);
  const version = remote.releases.get('android-1000200'), feed = remote.releases.get('android-latest');
  assert.equal(version.draft, false); assert.equal(feed.draft, false);
  assert.match(feed.body, new RegExp(sha));
  const versionReady = remote.events.findIndex(e => e[0] === 'publish' && e[1] === version.tag);
  const feedFirstWrite = remote.events.findIndex(e => e[0] === 'upload' && e[1] === feed.tag);
  assert.ok(versionReady < feedFirstWrite);
  assert.deepEqual(remote.events.filter(e => e[0] === 'upload' && e[1] === feed.tag).map(e => e[2]),
    ['ProfilePilot-android.apk', 'ProfilePilot-android.apk.sha256', 'ProfilePilot-android-update.json']);
  assert.match(JSON.parse(feed.files['ProfilePilot-android-update.json']).url, /android-1000200\//);
});
test('old or duplicate runs never downgrade or replace an advertised version', async () => {
  const { publishAndroidUpdate } = await import('../scripts/publish-android-update.mjs');
  const remote = new Remote(); await publishAndroidUpdate(remote, assets(), sha);
  remote.events = [];
  assert.equal((await publishAndroidUpdate(remote, assets(1000199), sha)).published, false);
  assert.equal((await publishAndroidUpdate(remote, assets(), sha)).published, false);
  assert.deepEqual(remote.events, []);
});
test('a failed APK upload leaves the existing feed intact', async () => {
  const { publishAndroidUpdate } = await import('../scripts/publish-android-update.mjs');
  const remote = new Remote(); await publishAndroidUpdate(remote, assets(), sha);
  const original = remote.releases.get('android-latest').files['ProfilePilot-android-update.json'];
  remote.failure = 'android-1000201/ProfilePilot-android.apk';
  await assert.rejects(publishAndroidUpdate(remote, assets(1000201), 'b'.repeat(40)), /Simulated/);
  assert.equal(remote.releases.get('android-latest').files['ProfilePilot-android-update.json'], original);
  assert.equal(remote.releases.get('android-1000201').draft, true);
});
test('retry after feed upload failure reuses published APK bytes even when the rebuilt APK differs', async () => {
  const { publishAndroidUpdate } = await import('../scripts/publish-android-update.mjs');
  const remote = new Remote(); remote.failure = 'android-latest/ProfilePilot-android-update.json';
  const original = assets();
  await assert.rejects(publishAndroidUpdate(remote, original, sha), /Simulated/);
  remote.failure = null; remote.events = [];
  await publishAndroidUpdate(remote, assets(1000200, Buffer.from([0x50, 0x4b, 3, 4, 8, 9])), sha);
  assert.equal(remote.releases.get('android-latest').files['ProfilePilot-android.apk'], original['ProfilePilot-android.apk']);
  assert.equal(remote.events.some(e => e[0] === 'upload' && e[1] === 'android-1000200'), false);
});
test('retry completes a draft feed when the final publication request failed', async () => {
  const { publishAndroidUpdate } = await import('../scripts/publish-android-update.mjs');
  const remote = new Remote(); remote.failure = 'publish/android-latest';
  await assert.rejects(publishAndroidUpdate(remote, assets(), sha), /Simulated publish failure/);
  assert.equal(remote.releases.get('android-latest').draft, true);
  remote.failure = null;
  assert.equal((await publishAndroidUpdate(remote, assets(), sha)).published, true);
  assert.equal(remote.releases.get('android-latest').draft, false);
});
test('corrupted files, source collisions and invalid commits cannot publish an update', async () => {
  const { publishAndroidUpdate, validateAndroidAssets } = await import('../scripts/publish-android-update.mjs');
  const corrupted = assets(); corrupted['ProfilePilot-android.apk'][5] ^= 1;
  assert.throws(() => validateAndroidAssets(corrupted), /inconsistent/);
  const remote = new Remote(); remote.failure = 'android-latest/ProfilePilot-android.apk';
  await assert.rejects(publishAndroidUpdate(remote, assets(), sha));
  await assert.rejects(publishAndroidUpdate(remote, assets(), 'b'.repeat(40)), /another commit/);
  await assert.rejects(publishAndroidUpdate(new Remote(), assets(), 'main'), /full source commit/);
});
test('stable release stays explicit and development publication runs on main with full Git history', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const development = readFileSync(path.join(root, '.github/workflows/android-development.yml'), 'utf8');
  assert.doesNotMatch(workflow, /branches: \[main\]/);
  assert.match(development, /branches: \[main\]/);
  assert.match(development, /paths:[\s\S]*"android-phone\/\*\*"/);
  assert.match(development, /fetch-depth: 0/);
  assert.match(development, /publish-android-update.mjs --development/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /group: profilepilot-release-packages/);
  assert.match(workflow, /publish_android:[\s\S]*node scripts\/publish-android-update.mjs/);
  assert.match(workflow, /build:\n[\s\S]*github.event_name == 'workflow_dispatch' \|\| startsWith\(github.ref, 'refs\/tags\/'\)/);
  const source = readFileSync(path.join(root, 'android-phone/app/build.gradle.kts'), 'utf8');
  const download = readFileSync(path.join(root, 'src/renderer/phone-basic.ts'), 'utf8');
  const site = readFileSync(path.join(root, 'site/index.html'), 'utf8');
  for (const entry of [source, download, site]) assert.match(entry, /releases\/download\/android-latest\/ProfilePilot-android/);
});
test('GitHub client explicitly keeps Android releases out of the desktop latest slot', async () => {
  const { GitHubAndroidReleases } = await import('../scripts/publish-android-update.mjs');
  const calls = []; const client = new GitHubAndroidReleases('test-token');
  client.api = async (endpoint, options) => { calls.push([endpoint, JSON.parse(options.body)]); return { id: 12 }; };
  const release = await client.create('android-1000200', 'Android', 'notes', sha);
  await client.publish(release, 'notes');
  assert.equal(calls[0][1].draft, true); assert.equal(calls[1][1].draft, false);
  assert.ok(calls.every(call => call[1].make_latest === 'false'));
});
