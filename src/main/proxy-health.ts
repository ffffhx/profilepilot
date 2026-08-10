import net from "node:net";

// 上游代理入口的地址解析结果：scheme 用于拼 Chrome --proxy-server / Bifrost proxy:// 兜底规则，
// host+port 用于 TCP 探活（我们关心的是“这个入口能不能接流量”，而不是某个进程是否存活）。
export interface ParsedProxyEndpoint {
  scheme: "http" | "https" | "socks5";
  host: string;
  port: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 800;

// 解析用户填写的上游代理地址。支持 http://、https://、socks5:// 三种 scheme；
// 裸 host:port 按 http 处理。非法输入返回 null（调用方据此报错或降级，不抛异常）。
export function parseProxyEndpoint(input: unknown): ParsedProxyEndpoint | null {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > 200 || /[\s\0]/.test(raw)) {
    return null;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") {
    return null;
  }
  const host = url.hostname;
  const port = Number(url.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { scheme, host, port };
}

// 归一化成规范字符串（scheme://host:port）；无法解析时返回 null。
export function normalizeProxyEndpoint(input: unknown): string | null {
  const parsed = parseProxyEndpoint(input);
  return parsed ? `${parsed.scheme}://${parsed.host}:${parsed.port}` : null;
}

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
  return probeTcp(parsed.host, parsed.port, timeoutMs);
}
