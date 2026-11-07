import { randomUUID } from 'node:crypto';
import type { GpuiApp, GpuiSession } from '../../shared/gpui';
import { gpuiError, toolData, type GpuiBackend } from './mcp';

export interface GpuiIndicator { setState(state: GpuiSession['state']): Promise<void>; close(): Promise<void>; }

/** Logical coordinates from semantic roots, independent of OS display/DPI coordinates. */
export function indicatorRect(tree: any) {
  const roots = Array.isArray(tree?.roots) ? tree.roots : [];
  const bounds = roots.map((id: string) => tree.nodes?.[id]).filter((node: any) => node?.state?.visible !== false)
    .map((node: any) => node?.bounds).filter((rect: any) => rect &&
      ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0);
  if (!bounds.length) throw gpuiError('GPUI_INDICATOR_UNAVAILABLE', '目标应用没有可定位的窗口元素。');
  const right = Math.max(...bounds.map((rect: any) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect: any) => rect.y + rect.height));
  return { x: Math.max(0, right - 156), y: Math.max(0, bottom - 10), width: 1, height: 1 };
}

/** A presentation-only connection: it never dispatches input or grants control. */
export class GpuiAnnotationIndicator implements GpuiIndicator {
  private group = 'profilepilot-control-' + randomUUID();
  private state: GpuiSession['state'] = 'preparing';
  private initialized = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private pending: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(private client: GpuiBackend, private app: GpuiApp, private unavailable: (error: Error) => void) {}
  setState(state: GpuiSession['state']): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.state = state; this.dirty = true; return this.refresh();
  }
  private refresh(): Promise<void> {
    const next = this.pending.then(async () => {
      if (this.closed || !this.dirty) return;
      this.dirty = false;
      if (!this.initialized) {
        const selected = toolData(await this.client.call('select_app', { target_id: this.app.target_id }))?.selected;
        if (selected?.target_id !== this.app.target_id || selected?.pid !== this.app.pid) throw gpuiError('GPUI_TARGET_CHANGED', '标识目标已变化。');
        this.initialized = true;
      }
      const tree = toolData(await this.client.call('get_ui_tree'));
      if (this.closed) return;
      const rect = indicatorRect(tree);
      // Transparent geometry paints only the bridge's compact, opaque text chip.
      await this.client.call('annotate_elements', { annotations: [{ id: this.group, group: this.group, rect,
        label: { preparing: 'ProfilePilot · 准备中', active: 'ProfilePilot · 控制中', paused: 'ProfilePilot · 已暂停' }[this.state],
        color: this.state === 'paused' ? '#A66A1400' : '#237B6000', style: 'fill', ttl_ms: 5000 }], replace_group: this.group });
      if (!this.closed && !this.timer) {
        this.timer = setInterval(() => { this.dirty = true; void this.refresh().catch(() => {}); }, 1500);
        this.timer.unref();
      }
    });
    this.pending = next.catch(error => {
      if (this.closed) return;
      this.closed = true; clearInterval(this.timer); this.client.close(); this.unavailable(error as Error);
    });
    return next;
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    try { await this.pending; if (this.initialized) await this.client.call('remove_annotations', { group: this.group }); }
    catch { /* A disconnected bridge expires the short-lived chip itself. */ }
    finally { this.client.close(); }
  }
}
