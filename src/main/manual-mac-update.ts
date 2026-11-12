import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { net, shell } from 'electron';

interface Asset { name: string; sha256: string; size: number; arch: string; url: string; }
export class ManualMacUpdater extends EventEmitter {
  autoDownload = false; autoInstallOnAppQuit = false; allowDowngrade = false; allowPrerelease = false;
  private asset?: Asset;
  private file = '';
  constructor(private readonly current: string, private readonly directory: string) { super(); }
  async checkForUpdates(): Promise<void> {
    const response = await net.fetch('https://github.com/ffffhx/profilepilot/releases/download/desktop-latest/desktop-update.json', {signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
    const manifest = await response.json();
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('更新版本无效');
    const next = manifest.version.split('.').map(Number), current = this.current.split('.').map(Number);
    const newer = next.findIndex((part: number, index: number) => part !== current[index]);
    if (newer < 0 || next[newer] < current[newer]) { this.emit('update-not-available'); return; }
    const asset = manifest.mac?.find((value: Asset) => value.arch === process.arch);
    if (!asset || asset.name !== `ProfilePilot-mac-${process.arch}.dmg` || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2 ** 31
      || asset.url !== `https://github.com/ffffhx/profilepilot/releases/download/v${manifest.version}/${asset.name}`) throw new Error('安装包信息无效');
    this.asset = asset;
    this.emit('update-available', {version: manifest.version, releaseNotes: manifest.notes || '下载后打开安装包，将 ProfilePilot 拖到“应用程序”完成更新。'});
  }
  async downloadUpdate(): Promise<void> {
    const asset = this.asset;
    if (!asset) throw new Error('请先检查更新');
    await fs.mkdir(this.directory, {recursive: true});
    const target = path.join(this.directory, asset.name), partial = `${target}.part`;
    const response = await net.fetch(asset.url, {signal: AbortSignal.timeout(30 * 60_000)});
    if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}`);
    const output = await fs.open(partial, 'w'), hash = createHash('sha256');
    let size = 0;
    try {
      for await (const bytes of response.body as any) {
        size += bytes.length;
        if (size > asset.size) throw new Error('安装包大小不符');
        hash.update(bytes); await output.writeFile(bytes);
        this.emit('download-progress', {percent: size / asset.size * 100});
      }
      if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('安装包校验失败，请重新下载');
      await output.close(); await fs.rename(partial, target); this.file = target;
      this.emit('update-downloaded');
    } catch (error) { await output.close().catch(() => {}); await fs.rm(partial, {force: true}); throw error; }
  }
  async openInstaller(): Promise<void> {
    if (!this.file) throw new Error('尚未下载安装包');
    const error = await shell.openPath(this.file);
    if (error) throw new Error(error);
  }
  quitAndInstall(): void { throw new Error('macOS 当前使用安装包引导更新'); }
}
