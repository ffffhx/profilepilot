import type { PhoneWirelessDiscovery } from "../shared/phones";

/** Read-only discovery for the selected phone. Never pair, connect or start control. */
export class PhoneWirelessDiscoveryMonitor {
  state: { checking: boolean; result?: PhoneWirelessDiscovery } = { checking: false };
  private target = "";
  private version = 0;
  private pending = false;
  private checkedAt = -Infinity;

  constructor(
    private discover: (id: string) => Promise<PhoneWirelessDiscovery>,
    private changed: () => void,
    private now: () => number = Date.now
  ) {}

  update(id: string, enabled: boolean): void {
    if (id !== this.target) {
      this.target = id; this.version++; this.checkedAt = -Infinity;
      this.state = { checking: false };
    }
    if (this.now() - this.checkedAt > 30000) this.state.result = undefined;
    if (!id || !enabled || this.pending || this.now() - this.checkedAt < 10000) return;
    const version = this.version;
    this.pending = true; this.state.checking = true;
    void this.scan(id, version);
  }

  private async scan(id: string, version: number): Promise<void> {
    let result: PhoneWirelessDiscovery;
    try { result = await this.discover(id); }
    catch { result = { services: [], error: "自动发现暂不可用，可点击连接 Wi-Fi 手动输入地址。" }; }
    this.pending = false;
    if (version === this.version) {
      this.checkedAt = this.now(); this.state = { checking: false, result };
    }
    this.changed();
  }
}

export function wirelessDiscoveryPresentation(state: PhoneWirelessDiscoveryMonitor["state"], enabled: boolean) {
  const services = state.result?.services || [];
  if (services.some(service => service.kind === "connect" && service.reachable))
    return { label: "已发现 · 待连接", note: "已发现这台设备的无线调试，点击连接 Wi-Fi；首次使用需配对。" };
  if (services.some(service => service.kind === "pairing" && service.reachable))
    return { label: "等待配对", note: "已发现配对服务，请点击连接 Wi-Fi，使用设备显示的配对码。" };
  if (services.some(service => service.reachable === false))
    return { label: "发现但不可达", note: "发现了无线调试地址，但当前无法连接。请检查同一网络和防火墙。" };
  if (enabled) return { label: "已开启 · 待连接", note: "设备已开启无线调试，点击连接 Wi-Fi；首次使用需配对。" };
  if (state.result?.error) return { label: "发现暂不可用", note: state.result.error };
  if (state.checking && !state.result) return { label: "正在查找", note: "正在查找这台设备的无线调试，请保持手机与电脑在同一网络。" };
  return { label: "未连接", note: state.result
    ? "暂未发现可连接的无线调试。确认同一网络并开启后，可点击连接 Wi-Fi 配对或手动连接。"
    : "手机与电脑在同一网络，开启无线调试；首次使用需配对。" };
}
