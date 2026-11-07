import type { BrowserWindow, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { DesktopStatus } from '../../shared/desktop';
import { desktopErrorMessage } from './errors';

const unavailable = () => Object.assign(new Error(desktopErrorMessage('DESKTOP_CONTROL_NOTICE_UNAVAILABLE')), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
export function noticeOwnerKey(status: DesktopStatus): string | null {
  return status.session && status.inputObservation.generation ? JSON.stringify([status.session.name, status.inputObservation.generation]) : null;
}
type NoticeRecord = {
  key: string | null; phase: 'creating' | 'loading' | 'ready' | 'failed'; window?: BrowserWindow;
  promise: Promise<void>; resolve(): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>;
  retiring: boolean;
  documentNonce: string; loaded: boolean; acknowledged: boolean; navigationStarted: boolean;
};
export interface DesktopNoticeOptions {
  file: string; create(): BrowserWindow; status(): DesktopStatus;
  onUnavailable(): void; onUserClose(): void; diagnostic(error: unknown): void;
  timeoutMs?: number;
}

// One UI component, with one attempt per owner/input generation. Failures are
// latched before notifying the service because that notification re-enters update.
export class DesktopControlNotice {
  private record?: NoticeRecord;
  private failedKey?: string;
  private closing = false;
  constructor(private readonly options: DesktopNoticeOptions) {}

  private current(record: NoticeRecord): boolean {
    return !this.closing && this.record === record && record.key !== null && noticeOwnerKey(this.options.status()) === record.key;
  }
  private log(error: unknown) { try { this.options.diagnostic(error); } catch { /* Diagnostics never alter control. */ } }
  private destroyed(record: NoticeRecord): boolean {
    try { return !record.window || record.window.isDestroyed(); } catch { return false; }
  }
  private retire(record: NoticeRecord) {
    record.retiring = true;
    if (record.timer) clearTimeout(record.timer); record.timer = undefined;
    if (!this.destroyed(record)) {
      try { record.window!.hide(); } catch (error) { this.log(error); }
      try { record.window!.destroy(); } catch (error) { this.log(error); }
    }
    // A destroy call is not evidence by itself. Keep the failed record as a
    // barrier until isDestroyed or the closed event confirms its retirement.
    if (this.record === record && this.destroyed(record)) this.record = undefined;
  }
  private fail(record: NoticeRecord, error: unknown, pause = true) {
    if (record.phase === 'failed') return;
    record.phase = 'failed';
    if (record.key) this.failedKey = record.key;
    if (record.timer) clearTimeout(record.timer); record.timer = undefined;
    record.reject(unavailable()); if (error !== undefined) this.log(error);
    const relevant = this.current(record);
    this.retire(record); // Revoke toolbar authority before cleanup/callbacks.
    if (pause && relevant) try { if (noticeOwnerKey(this.options.status()) === record.key) this.options.onUnavailable(); } catch (failure) { this.log(failure); }
  }
  private show(record: NoticeRecord) {
    if (!this.current(record) || this.destroyed(record)) throw unavailable();
    record.window!.showInactive();
    if (!this.current(record) || record.phase === 'failed' || this.destroyed(record) || !record.window!.isVisible()) throw unavailable();
  }
  private finish(record: NoticeRecord) {
    if (!record.loaded || !record.acknowledged || !this.current(record) || record.phase !== 'loading') return;
    this.show(record);
    record.phase = 'ready'; if (record.timer) clearTimeout(record.timer); record.timer = undefined; record.resolve();
  }
  private loaded(record: NoticeRecord) {
    if (!this.current(record) || record.phase !== 'loading') return;
    try {
      record.loaded = true;
      this.show(record);
      this.finish(record);
    } catch (error) { this.fail(record, error); }
  }
  private begin(record: NoticeRecord, key: string) {
    record.key = key; record.phase = 'loading'; record.acknowledged = false;
    record.promise = new Promise<void>((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    void record.promise.catch(() => {});
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => { if (this.current(record) && record.phase === 'loading') this.fail(record, unavailable()); }, this.options.timeoutMs ?? 5000);
  }
  private create(key: string): NoticeRecord {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const record: NoticeRecord = { key, phase: 'creating', promise, resolve, reject, retiring: false,
      documentNonce: randomUUID(), loaded: false, acknowledged: false, navigationStarted: false };
    this.record = record;
    try {
      const window = record.window = this.options.create();
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      const unavailableEvent = () => { if (this.current(record)) this.fail(record, unavailable()); };
      window.webContents.on('preload-error', unavailableEvent);
      window.webContents.on('render-process-gone', unavailableEvent);
      window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
        if (!mainFrame || this.record !== record || record.phase === 'failed') return;
        if (record.loaded || record.navigationStarted) this.fail(record, unavailable());
        record.navigationStarted = true;
      });
      window.on('unresponsive', () => { if (this.current(record)) this.fail(record, unavailable()); });
      window.on('closed', () => {
        if (this.record !== record) return;
        if (!record.retiring) this.fail(record, unavailable());
        if (this.record === record) this.record = undefined;
      });
      window.on('close', event => {
        if (record.retiring || !this.current(record)) return;
        event.preventDefault();
        try { this.options.onUserClose(); } catch (error) { this.log(error); }
        try { if (!this.destroyed(record)) window.hide(); } catch (error) { this.fail(record, error); }
      });
      this.begin(record, key);
      void Promise.resolve(window.loadFile(this.options.file, { query: { notice: record.documentNonce } })).then(() => this.loaded(record), error => { if (this.current(record)) this.fail(record, error); });
    } catch (error) { this.fail(record, error); }
    return record;
  }
  async prepare(signal: AbortSignal): Promise<void> {
    const key = noticeOwnerKey(this.options.status());
    if (this.closing || !key || signal.aborted || this.failedKey === key) throw unavailable();
    let record = this.record;
    if (record && (record.phase === 'failed' || record.phase !== 'ready' && record.key !== key)) {
      if (record.phase !== 'failed') this.fail(record, undefined, false); else this.retire(record);
      if (this.record) { this.failedKey = key; throw unavailable(); }
      record = undefined;
    }
    if (!record) record = this.create(key);
    else if (record.phase === 'ready') {
      if (record.key !== key) this.begin(record, key);
      try { this.show(record); } catch (error) { this.fail(record, error); }
    }
    if (record.phase === 'failed' || !this.current(record) || signal.aborted) throw unavailable();
    const current = record;
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => { cancel = () => { this.fail(current, undefined, false); reject(unavailable()); }; });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      await Promise.race([current.promise, aborted]);
      if (signal.aborted || !this.current(current) || current.phase !== 'ready') throw unavailable();
    } finally { signal.removeEventListener('abort', cancel); }
  }
  update(status: DesktopStatus): void {
    const record = this.record, key = noticeOwnerKey(status);
    if (this.closing || !record) return;
    if (!key) {
      if (record.phase !== 'ready') this.fail(record, undefined, false);
      else {
        record.key = null;
        try { if (!this.destroyed(record)) record.window!.hide(); } catch (error) { this.fail(record, error, false); }
      }
      return;
    }
    if (record.key === key && record.phase === 'ready') {
      try { this.show(record); } catch (error) { this.fail(record, error); }
    }
  }
  acceptsToolbar(sender: WebContents, ready = true): boolean {
    const record = this.record;
    try { return !!record && record.phase !== 'failed' && (!ready || record.phase === 'ready') && record.window?.webContents === sender && !this.destroyed(record) && this.current(record); }
    catch { return false; }
  }
  acknowledge(sender: WebContents, generation: string, documentNonce: string): void {
    const record = this.record;
    if (!record || !this.acceptsToolbar(sender, false) || documentNonce !== record.documentNonce ||
        generation !== this.options.status().inputObservation.generation) throw unavailable();
    try { record.acknowledged = true; this.finish(record); }
    catch (error) { this.fail(record, error); throw unavailable(); }
  }
  documentUnavailable(sender: WebContents, documentNonce: string): void {
    const record = this.record;
    if (!record || record.phase === 'failed' || record.window?.webContents !== sender || documentNonce !== record.documentNonce) throw unavailable();
    this.fail(record, unavailable());
  }
  close(): void {
    if (this.closing) return; this.closing = true;
    const record = this.record;
    if (record) { if (record.phase !== 'failed') { record.phase = 'failed'; record.reject(unavailable()); } this.retire(record); }
  }
}
