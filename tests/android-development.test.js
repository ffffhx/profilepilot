const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

test('development version supports CI -> local debugging -> next pushed update without downgrade', async () => {
  const { androidDevelopmentVersion: version } = await import('../scripts/android-development-version.mjs');
  const properties = 'versionCode=12\r\nversionName=0.3.6\r\n';
  const cloud = version(properties, 200, false), local = version(properties, 200), next = version(properties, 201, false);
  assert.ok(cloud.versionCode < local.versionCode);
  assert.ok(local.versionCode < next.versionCode);
  assert.deepEqual(version(properties, 200), local, 'Repeated local builds can replace the same version');
  assert.equal(cloud.tag, 'android-dev-' + cloud.versionCode);
  assert.ok(version(properties, 2098999).versionCode <= 2100000000);
  for (const count of [0, -1, 1.5, NaN, 2099000]) assert.throws(() => version(properties, count));
  assert.throws(() => version('versionName=bad name\n', 200));
});

class Remote {
  releases = new Map(); events = [];
  async find(tag) { return this.releases.get(tag) || null; }
  async create(tag, name, body, sha) { const value = { tag, name, body, sha, draft: true, files: {} }; this.releases.set(tag, value); return value; }
  async read(release, name) { return release.files[name] || null; }
  async upload(release, name, value) { this.events.push([release.tag, name]); release.files[name] = value; }
  async publish(release, body) { release.draft = false; release.body = body; }
}

async function assets(variant, code) {
  const { androidUpdateChannel } = await import('../scripts/android-update-channels.mjs');
  const { androidUpdateManifest } = await import('../scripts/prepare-android-update.mjs');
  const channel = androidUpdateChannel(variant), apk = Buffer.from([0x50, 0x4b, 3, 4, 1, 2]);
  const metadata = { applicationId: channel.applicationId, variantName: variant, minSdkVersionForDexing: 30,
    elements: [{ type: 'SINGLE', filters: [], versionCode: code, versionName: variant === 'debug' ? '0.3.6+build.200-dev' : '0.3.6' }] };
  const manifest = androidUpdateManifest(metadata, apk, `${channel.prefix}-${code}`, 'Update notes', variant);
  assert.equal(manifest.sha256, createHash('sha256').update(apk).digest('hex'));
  if (variant === 'debug') assert.throws(() => androidUpdateManifest(metadata, apk, 'latest', 'notes'), /matching APK/);
  return Object.fromEntries([[channel.assets[0], apk], [channel.assets[1], Buffer.from(`${manifest.sha256}  ${channel.assets[0]}\n`)],
    [channel.assets[2], Buffer.from(JSON.stringify(manifest))]]);
}

test('development publishes only its own package, download names and feed, preserving stable releases', async () => {
  const { publishAndroidUpdate, validateAndroidAssets } = await import('../scripts/publish-android-update.mjs');
  const remote = new Remote(), sha = 'a'.repeat(40);
  await publishAndroidUpdate(remote, await assets('release', 1000200), sha);
  const stable = JSON.stringify(remote.releases.get('android-latest'));
  const development = await assets('debug', 1200000);
  assert.throws(() => validateAndroidAssets(development));
  const result = await publishAndroidUpdate(remote, development, sha, 'debug');
  assert.equal(result.feedTag, 'android-dev-latest');
  assert.equal(result.tag, 'android-dev-1200000');
  assert.equal(JSON.stringify(remote.releases.get('android-latest')), stable);
  assert.equal(remote.releases.get('android-dev-latest').draft, false);
  assert.equal((await publishAndroidUpdate(remote, development, sha, 'debug')).published, false);
  await publishAndroidUpdate(remote, await assets('debug', 1201000), 'b'.repeat(40), 'debug');
  assert.equal((await publishAndroidUpdate(remote, development, sha, 'debug')).published, false);
  assert.equal(JSON.stringify(remote.releases.get('android-latest')), stable);
});

test('development GitHub releases are prereleases and never replace desktop latest', async () => {
  const { GitHubAndroidReleases } = await import('../scripts/publish-android-update.mjs');
  const client = new GitHubAndroidReleases('test-token'), requests = [];
  client.api = async (_endpoint, options) => { requests.push(JSON.parse(options.body)); return { id: 1 }; };
  await client.create('android-dev-1200000', 'Development', 'notes', 'a'.repeat(40));
  assert.equal(requests[0].prerelease, true);
  assert.equal(requests[0].make_latest, 'false');
});
