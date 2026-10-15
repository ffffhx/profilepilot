import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidUpdateChannel } from './android-update-channels.mjs';

export function androidUpdateManifest(metadata, apk, tag, notes, variant = 'release') {
  const channel = androidUpdateChannel(variant);
  const entry = metadata.elements?.[0];
  if (metadata.applicationId !== channel.applicationId || metadata.variantName !== variant
      || metadata.elements?.length !== 1 || entry.type !== 'SINGLE' || entry.filters?.length
      || !Number.isInteger(entry.versionCode) || entry.versionCode < 1 || entry.versionCode > 2100000000
      || typeof entry.versionName !== 'string' || !entry.versionName.trim() || entry.versionName.length > 80
      || !Number.isInteger(metadata.minSdkVersionForDexing) || metadata.minSdkVersionForDexing < 30
      || metadata.minSdkVersionForDexing > 1000 || !/^[A-Za-z0-9._-]+$/.test(tag)
      || typeof notes !== 'string' || notes.length > 16000
      || apk.length < 4 || apk.length > 150 * 1024 * 1024 || apk.readUInt32LE(0) !== 0x04034b50)
    throw new Error('Android update requires one matching APK, valid Android metadata and a release tag.');
  return {
    schemaVersion: 1, applicationId: metadata.applicationId,
    versionCode: entry.versionCode, versionName: entry.versionName,
    minSdk: metadata.minSdkVersionForDexing, notes: notes.trim(),
    url: `https://github.com/ffffhx/profilepilot/releases/download/${encodeURIComponent(tag)}/${channel.assets[0]}`,
    size: apk.length, sha256: createHash('sha256').update(apk).digest('hex')
  };
}

export function prepareAndroidUpdate(root, tag, variant = 'release') {
  const channel = androidUpdateChannel(variant);
  const buildOutput = path.join(root, 'android-phone/app/build/outputs/apk', variant);
  const metadata = JSON.parse(readFileSync(path.join(buildOutput, 'output-metadata.json'), 'utf8'));
  const builtApk = path.join(buildOutput, path.basename(metadata.elements?.[0]?.outputFile || `app-${variant}.apk`));
  const apk = readFileSync(builtApk);
  const bundled = readFileSync(path.join(root, 'dist/android/profilepilot-phone.apk'));
  if (!apk.equals(bundled)) throw new Error('Bundled Android APK differs from the release build.');
  const manifest = androidUpdateManifest(metadata, apk, tag, readFileSync(path.join(root, 'android-phone/update-notes.txt'), 'utf8'), variant);
  const output = path.join(root, 'release'); mkdirSync(output, { recursive: true });
  copyFileSync(builtApk, path.join(output, channel.assets[0]));
  writeFileSync(path.join(output, channel.assets[1]), `${manifest.sha256}  ${channel.assets[0]}\n`);
  writeFileSync(path.join(output, channel.assets[2]), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const variant = process.argv.includes('--development') ? 'debug' : 'release';
  const requestedTag = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  const tag = requestedTag || (variant === 'debug' ? `android-dev-${JSON.parse(readFileSync(path.join(root, 'dist/android/profilepilot-phone.apk.json'), 'utf8')).versionCode}` : 'latest');
  console.log(JSON.stringify(prepareAndroidUpdate(root, tag, variant), null, 2));
}
