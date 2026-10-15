export function androidUpdateChannel(variant = 'release') {
  if (!['release', 'debug'].includes(variant)) throw new Error('Unknown Android update channel.');
  const development = variant === 'debug';
  const prefix = development ? 'android-dev' : 'android';
  const basename = development ? 'ProfilePilot-android-dev' : 'ProfilePilot-android';
  return {
    variant, development, applicationId: 'io.github.profilepilot.phone' + (development ? '.debug' : ''),
    prefix, feedTag: `${prefix}-latest`, basename,
    assets: [`${basename}.apk`, `${basename}.apk.sha256`, `${basename}-update.json`],
    title: development ? 'ProfilePilot Android development' : 'ProfilePilot Android'
  };
}
