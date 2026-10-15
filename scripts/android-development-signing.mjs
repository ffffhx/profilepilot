import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export function developmentSigning(root, env = process.env) {
  const keystore = env.ANDROID_DEVELOPMENT_KEYSTORE || path.join(os.homedir(), '.profilepilot', 'android-signing', 'development.keystore');
  if (!existsSync(keystore)) throw new Error('缺少固定开发签名。请将原开发密钥保存到 ~/.profilepilot/android-signing/development.keystore，或设置 ANDROID_DEVELOPMENT_KEYSTORE；不要生成新密钥。');
  const configured = { ...env, ANDROID_DEVELOPMENT_KEYSTORE: keystore,
    ANDROID_DEVELOPMENT_STORE_PASSWORD: env.ANDROID_DEVELOPMENT_STORE_PASSWORD || 'android',
    ANDROID_DEVELOPMENT_KEY_ALIAS: env.ANDROID_DEVELOPMENT_KEY_ALIAS || 'androiddebugkey',
    ANDROID_DEVELOPMENT_KEY_PASSWORD: env.ANDROID_DEVELOPMENT_KEY_PASSWORD || 'android' };
  const keytool = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
  let certificate;
  try {
    certificate = execFileSync(keytool, ['-exportcert', '-keystore', keystore, '-alias', configured.ANDROID_DEVELOPMENT_KEY_ALIAS,
      '-storepass:env', 'ANDROID_DEVELOPMENT_STORE_PASSWORD'], { env: configured, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('无法读取固定开发签名，请检查密钥文件、别名和密码。'); }
  const expected = readFileSync(path.join(root, 'android-phone/development-certificate.sha256'), 'utf8').trim();
  if (createHash('sha256').update(certificate).digest('hex') !== expected)
    throw new Error('开发签名与已安装版本不一致，请使用原固定密钥；不能直接覆盖安装。');
  return configured;
}
