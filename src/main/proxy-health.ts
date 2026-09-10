import net from "node:net";
import { parseProxyEndpoint, type ParsedProxyEndpoint } from "../shared/proxy-endpoint";
export { parseProxyEndpoint, normalizeProxyEndpoint, type ParsedProxyEndpoint } from "../shared/proxy-endpoint";

// 上游代理入口的地址解析结果：scheme 用于拼 Chrome --proxy-server / Bifrost proxy:// 兜底规则，
// host+port 用于 TCP 探活（我们关心的是“这个入口能不能接流量”，而不是某个进程是否存活）。
const DEFAULT_PROBE_TIMEOUT_MS = 800;

// Chrome --proxy-server 需要的地址；http 默认省略 scheme 由 Chrome 处理，socks5 保留 scheme。
export function proxyEndpointForChrome(endpoint: ParsedProxyEndpoint): string {
  return `${endpoint.scheme}://${endpoint.host}:${endpoint.port}`;
}

// TCP 探活：能建立连接即视为可达，超时/错误/拒绝都视为不可达。纯粹的连通性探测，不发任何数据。
export function probeTcp(host: string, port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }

    let settled = false;
    const socket = new net.Socket();
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

// 解析地址后探活；地址非法直接判不可达。
export async function probeProxyEndpoint(input: unknown, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const parsed = parseProxyEndpoint(input);
  if (!parsed) return false;
  return probeTcp(parsed.host.replace(/^\[|\]$/g, ""), parsed.port, timeoutMs);
}
