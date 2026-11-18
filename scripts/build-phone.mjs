import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { phoneBuildMetadata } from './phone-build-metadata.mjs';
import { developmentVersion } from './android-development-version.mjs';
import { developmentSigning } from './android-development-signing.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function detectGradleProxyProps(env = process.env) {
  const parseHostPort = raw => {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed.split(';')[0].replace(/^https?=/i, '')}`;
    try {
      const url = new URL(candidate);
      const port = Number(url.port);
      if (url.hostname && Number.isInteger(port) && port > 0 && port <= 65535) return { host: url.hostname, port: String(port) };
    } catch {}
    return null;
  };
  let endpoint = parseHostPort(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);
  if (!endpoint && process.platform === 'win32') {
    try {
      const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
      if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) {
        const match = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        endpoint = parseHostPort(match?.[1]);
      }
    } catch {}
  } else if (!endpoint && process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
      if (/HTTPSEnable\s*:\s*1/.test(out)) {
        const h = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1], p = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
        if (h && p) endpoint = { host: h, port: p };
      }
    } catch {}
  }
  if (!endpoint) return [];
  return [
    `-DsystemProp.http.proxyHost=${endpoint.host}`,
    `-DsystemProp.http.proxyPort=${endpoint.port}`,
    `-DsystemProp.https.proxyHost=${endpoint.host}`,
    `-DsystemProp.https.proxyPort=${endpoint.port}`,
    '-DsystemProp.http.nonProxyHosts=localhost|127.*|[::1]',
    '-DsystemProp.https.nonProxyHosts=localhost|127.*|[::1]',
    '-Dorg.gradle.internal.http.connectionTimeout=60000',
    '-Dorg.gradle.internal.http.socketTimeout=60000',
    '--max-workers=4'
  ];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const variant = release ? 'release' : 'debug';
let buildEnv = { ...process.env };
if (!release) {
  const version = developmentVersion(root, !process.argv.includes('--development-ci'));
  buildEnv = { ...developmentSigning(root), PROFILEPILOT_ANDROID_VERSION_CODE: String(version.versionCode),
    PROFILEPILOT_ANDROID_VERSION_NAME: version.versionName };
  console.log(`开发版：${version.versionName}-dev (${version.versionCode})`);
}
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
  ...detectGradleProxyProps(buildEnv),
  release ? ':app:assembleRelease' : ':app:assembleDebug', ':app:testDebugUnitTest', release ? ':app:lintRelease' : ':app:lintDebug', '--console=plain'];
if (process.argv.includes('--offline')) args.push('--offline');
if (process.argv.includes('--instrumentation')) args.push(':app:assembleDebugAndroidTest');
const runGradle = () => new Promise((resolve, reject) => {
  const child = spawn(java, args, { cwd: path.join(root, 'android-phone'), env: { ...buildEnv, ANDROID_HOME: sdk }, windowsHide: true, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Android 构建失败 (${code})`)));
});
try {
  await runGradle();
} catch (err) {
  if (process.argv.includes('--offline')) throw err;
  console.warn('[build-phone] 首次 Gradle 构建遇到网络波动或依赖拉取中断，自动重试一次...');
  await runGradle();
}
const output = path.join(root, 'dist', 'android'); mkdirSync(output, { recursive: true });
const buildOutput = path.join(root, 'android-phone', 'app', 'build', 'outputs', 'apk', variant);
const apk = readFileSync(path.join(buildOutput, `app-${variant}.apk`));
const metadata = phoneBuildMetadata(JSON.parse(readFileSync(path.join(buildOutput, 'output-metadata.json'), 'utf8')), apk);
writeFileSync(path.join(output, 'profilepilot-phone.apk'), apk);
writeFileSync(path.join(output, 'profilepilot-phone.apk.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(`手机配套 App（${variant}）已生成：dist/android/profilepilot-phone.apk`);
await import('./build-screen-camera.mjs');
