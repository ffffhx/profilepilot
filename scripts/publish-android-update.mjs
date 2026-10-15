import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANDROID_ASSETS = ['ProfilePilot-android.apk', 'ProfilePilot-android.apk.sha256', 'ProfilePilot-android-update.json'];
const repository = 'ffffhx/profilepilot';
const feedTag = 'android-latest';

export function validateAndroidAssets(assets) {
  const apk = assets[ANDROID_ASSETS[0]];
  const manifest = JSON.parse(assets[ANDROID_ASSETS[2]].toString('utf8'));
  const tag = `android-${manifest.versionCode}`;
  if (manifest.schemaVersion !== 1 || manifest.applicationId !== 'io.github.profilepilot.phone'
      || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1000001 || manifest.versionCode > 2100000000
      || typeof manifest.versionName !== 'string' || !/^[0-9A-Za-z.+-]{1,80}$/.test(manifest.versionName)
      || !Number.isInteger(manifest.minSdk) || manifest.minSdk < 30 || manifest.minSdk > 1000
      || typeof manifest.notes !== 'string' || manifest.notes.length > 16000
      || manifest.url !== `https://github.com/${repository}/releases/download/${tag}/${ANDROID_ASSETS[0]}`
      || !Buffer.isBuffer(apk) || apk.length < 4 || apk.length > 150 * 1024 * 1024
      || apk.readUInt32LE(0) !== 0x04034b50 || manifest.size !== apk.length
      || manifest.sha256 !== createHash('sha256').update(apk).digest('hex')
      || assets[ANDROID_ASSETS[1]].toString('utf8').trim() !== `${manifest.sha256}  ${ANDROID_ASSETS[0]}`)
    throw new Error('Refusing to publish inconsistent Android update assets.');
  return manifest;
}

function releaseBody(manifest, sha) {
  return `<!-- profilepilot-android:${JSON.stringify({ versionCode: manifest.versionCode, sha })} -->\n`
    + `Android ${manifest.versionName}\n\n${manifest.notes}\n\nSource: ${sha}\n`;
}
function publication(release) {
  const match = /^<!-- profilepilot-android:(.+) -->/u.exec(release?.body || '');
  if (!match) return null;
  const value = JSON.parse(match[1]);
  if (!Number.isSafeInteger(value.versionCode) || !/^[a-f0-9]{40}$/.test(value.sha)) throw new Error('Invalid Android release marker.');
  return value;
}
async function feedManifest(client, release) {
  if (!release) return null;
  const bytes = await client.read(release, ANDROID_ASSETS[2]);
  if (!bytes) return null; // Allows retry after an interrupted asset replacement.
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schemaVersion !== 1 || value.applicationId !== 'io.github.profilepilot.phone'
      || !Number.isSafeInteger(value.versionCode) || !/^[a-f0-9]{64}$/.test(value.sha256))
    throw new Error('Existing Android feed is invalid; refusing to overwrite it.');
  return value;
}

/** Immutable per-version download first; advertise it only after all assets exist. */
export async function publishAndroidUpdate(client, assets, sha) {
  let manifest = validateAndroidAssets(assets);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full source commit SHA is required.');
  let feed = await client.find(feedTag);
  const current = await feedManifest(client, feed);
  const knownVersion = Math.max(current?.versionCode || 0, publication(feed)?.versionCode || 0);
  if (manifest.versionCode < knownVersion || !feed?.draft && manifest.versionCode === current?.versionCode
      && publication(feed)?.versionCode === manifest.versionCode)
    return { published: false, reason: 'This Android version or a newer one is already published.', versionCode: knownVersion };

  const tag = `android-${manifest.versionCode}`;
  let version = await client.find(tag);
  if (version && publication(version)?.sha !== sha)
    throw new Error('Android version is already assigned to another commit. Publish from main with full, append-only Git history.');
  if (!version) version = await client.create(tag, `ProfilePilot Android ${manifest.versionName}`, releaseBody(manifest, sha), sha);
  if (!version.draft) {
    // A prior run may have published the APK and failed before promoting the feed.
    // Reuse those exact bytes instead of replacing an already downloadable package.
    assets = Object.fromEntries(await Promise.all(ANDROID_ASSETS.map(async name => [name, await client.read(version, name)])));
    const existing = validateAndroidAssets(assets);
    if (existing.versionCode !== manifest.versionCode) throw new Error('Published APK does not match its Android release tag.');
    manifest = existing;
  } else {
    for (const name of ANDROID_ASSETS) await client.upload(version, name, assets[name]);
    await client.publish(version, releaseBody(manifest, sha));
  }
  if (!feed) feed = await client.create(feedTag, 'ProfilePilot Android updates', releaseBody(manifest, sha), sha);
  // The old feed still references its immutable APK throughout these replacements.
  for (const name of ANDROID_ASSETS) await client.upload(feed, name, assets[name]);
  await client.publish(feed, releaseBody(manifest, sha));
  return { published: true, versionCode: manifest.versionCode, versionName: manifest.versionName, tag, feedTag };
}

export class GitHubAndroidReleases {
  constructor(token) { if (!token) throw new Error('GH_TOKEN is required.'); this.token = token; }
  async request(url, options = {}, allowMissing = false, binary = false) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120000), headers: {
      Authorization: `Bearer ${this.token}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...options.headers
    } });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub Android release request failed (HTTP ${response.status}).`);
    if (response.status === 204) return null;
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  api(suffix, options, allowMissing) { return this.request(`https://api.github.com/repos/${repository}${suffix}`, options, allowMissing); }
  find(tag) { return this.api(`/releases/tags/${encodeURIComponent(tag)}`, {}, true); }
  create(tag, name, body, sha) {
    return this.api('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, target_commitish: sha, name, body, draft: true, prerelease: false, make_latest: 'false' }) });
  }
  async read(release, name) {
    const asset = release.assets?.find(item => item.name === name);
    return asset ? this.request(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, {}, false, true) : null;
  }
  async upload(release, name, bytes) {
    const existing = release.assets?.find(item => item.name === name);
    if (existing) await this.api(`/releases/assets/${existing.id}`, { method: 'DELETE' });
    await this.request(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' }, body: bytes
    });
  }
  publish(release, body) {
    return this.api(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, draft: false, make_latest: 'false' }) });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_REPOSITORY !== repository) throw new Error('Android publishing is restricted to the configured repository.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'release');
  const assets = Object.fromEntries(ANDROID_ASSETS.map(name => [name, readFileSync(path.join(root, name))]));
  console.log(JSON.stringify(await publishAndroidUpdate(new GitHubAndroidReleases(process.env.GH_TOKEN), assets, process.env.GITHUB_SHA), null, 2));
}
