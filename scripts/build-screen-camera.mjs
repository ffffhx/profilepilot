import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
const platforms = readdirSync(path.join(sdk, 'platforms')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const buildTools = readdirSync(path.join(sdk, 'build-tools')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const androidJar = path.join(sdk, 'platforms', platforms[0], 'android.jar');
const java = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const output = path.join(root, 'dist', 'android');
const classes = path.join(root, 'android-camera', 'build', 'classes');
const dex = path.join(root, 'android-camera', 'build', 'dex');
for (const dir of [output, classes, dex]) mkdirSync(dir, { recursive: true });
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Screen camera build failed (${result.status})`);
}
run(java('javac'), ['-encoding', 'UTF-8', '-source', '17', '-target', '17', '-classpath', androidJar, '-d', classes,
  path.join(root, 'android-camera/src/io/github/profilepilot/camera/ScreenCamera.java')]);
const classFiles = readdirSync(classes, { recursive: true }).filter(file => file.endsWith('.class')).map(file => path.join(classes, file));
run(java('java'), ['-cp', path.join(sdk, 'build-tools', buildTools[0], 'lib', 'd8.jar'), 'com.android.tools.r8.D8',
  '--min-api', '36', '--lib', androidJar, '--output', dex, ...classFiles]);
copyFileSync(path.join(dex, 'classes.dex'), path.join(output, 'profilepilot-screen-camera.dex'));
console.log('Built dist/android/profilepilot-screen-camera.dex');
