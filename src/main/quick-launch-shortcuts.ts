interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Only reserve configured keys, and keep the old binding when a save fails. */
export class QuickLaunchShortcuts {
  private registered = new Map<string, string>();
  private desired: Record<string, string> = {};
  private paused = false;

  constructor(private api: ShortcutApi, private launch: (id: string) => void) {}

  sync(bindings: Record<string, string>): void {
    this.desired = bindings;
    const next = this.paused ? {} : bindings;
    for (const [key, id] of this.registered) {
      if (next[id] !== key) { this.api.unregister(key); this.registered.delete(key); }
    }
    for (const [id, key] of Object.entries(next)) {
      if (this.registered.has(key)) continue;
      if (this.api.register(key, () => this.launch(id))) this.registered.set(key, id);
      else console.warn(`[quick-launch] 快捷键被占用或不可用：${key}`);
    }
  }

  pause(paused: boolean): void {
    this.paused = paused;
    this.sync(this.desired);
  }

  async save(id: string, shortcut: string | null, persist: () => Promise<void>): Promise<void> {
    const owner = shortcut ? this.registered.get(shortcut) : undefined;
    if (owner && owner !== id) throw new Error("这个快捷键已绑定其他 Profile，请先清除原绑定。");
    const newlyRegistered = Boolean(shortcut && !owner);
    if (newlyRegistered && !this.api.register(shortcut!, () => this.launch(id))) {
      throw new Error("这个快捷键被系统或其他应用占用，请换一个组合键。");
    }
    try {
      await persist();
    } catch (error) {
      if (newlyRegistered) this.api.unregister(shortcut!);
      throw error;
    }
    if (newlyRegistered) this.registered.set(shortcut!, id);
    const next = { ...this.desired };
    if (shortcut) next[id] = shortcut;
    else delete next[id];
    this.sync(next);
  }
}
