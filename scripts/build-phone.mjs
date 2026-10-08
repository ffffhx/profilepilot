import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const variant = release ? 'release' : 'debug';
if (release) {
  for (const name of ['ANDROID_RELEASE_KEYSTORE', 'ANDROID_RELEASE_STORE_PASSWORD', 'ANDROID_RELEASE_KEY_ALIAS', 'ANDROID_RELEASE_KEY_PASSWORD']) {
    if (!process.env[name]) throw new Error(`Android 发布签名缺少环境变量：${name}`);
  }
  if (!existsSync(process.env.ANDROID_RELEASE_KEYSTORE)) throw new Error('Android 发布签名文件不存在。');
}
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
if (!existsSync(sdk)) throw new Error('Android SDK 未找到，请设置 ANDROID_HOME。');
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const args = ['-classpath', path.join(root, 'android-phone', 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
  release ? ':app:assembleRelease' : ':app:assembleDebug', ':app:testDebugUnitTest', release ? ':app:lintRelease' : ':app:lintDebug', '--console=plain'];
if (process.argv.includes('--offline')) args.push('--offline');
if (process.argv.includes('--instrumentation')) args.push(':app:assembleDebugAndroidTest');
await new Promise((resolve, reject) => {
  const child = spawn(java, args, { cwd: path.join(root, 'android-phone'), env: { ...process.env, ANDROID_HOME: sdk }, windowsHide: true, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Android 构建失败 (${code})`)));
});
const output = path.join(root, 'dist', 'android'); mkdirSync(output, { recursive: true });
copyFileSync(path.join(root, 'android-phone', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`), path.join(output, 'profilepilot-phone.apk'));
console.log(`手机配套 App（${variant}）已生成：dist/android/profilepilot-phone.apk`);
