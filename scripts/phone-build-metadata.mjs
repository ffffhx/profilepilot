import { createHash } from 'node:crypto';

// Written beside the bundled APK so desktop builds choose the matching app on either OS.
export function phoneBuildMetadata(metadata, apk) {
  const variant = metadata.variantName;
  const applicationId = variant === 'debug' ? 'io.github.profilepilot.phone.debug' : 'io.github.profilepilot.phone';
  const element = metadata.elements?.[0];
  if (!['debug', 'release'].includes(variant) || metadata.applicationId !== applicationId
      || metadata.elements?.length !== 1 || element.filters?.length || !Number.isInteger(element.versionCode)
      || element.versionCode < 1 || typeof element.versionName !== 'string'
      || !apk.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new Error('Invalid companion build output');
  return { schemaVersion: 1, variant, applicationId, versionCode: element.versionCode,
    versionName: element.versionName, sha256: createHash('sha256').update(apk).digest('hex') };
}
