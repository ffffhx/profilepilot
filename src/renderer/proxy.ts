import type { BifrostSnapshot } from "./types";

export const DEFAULT_CLASH_PROXY_SERVER = "http://127.0.0.1:7897";
export const DEFAULT_BIFROST_PROXY_SERVER = "http://127.0.0.1:9900";

export function normalizeProxyServerInput(input: string): string | null {
  const raw = String(input || "").trim();
  if (!raw || raw.length > 200 || /[\s\0]/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") return null;
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${scheme}://${url.hostname}:${port}`;
}

export function bifrostMainProxyServer(snapshot: BifrostSnapshot | null): string {
  const port = snapshot?.mainPort;
  return Number.isInteger(port) && port! >= 1 && port! <= 65535
    ? `http://127.0.0.1:${port}`
    : DEFAULT_BIFROST_PROXY_SERVER;
}

export function resolveUpstreamProxyServerInput(input: string, fallback: string): string | null {
  const raw = String(input || "").trim();
  return normalizeProxyServerInput(raw || fallback || DEFAULT_CLASH_PROXY_SERVER);
}

export function proxyServerUsesPort(server: string, port: number): boolean {
  const normalized = normalizeProxyServerInput(server);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return loopback && Number(url.port) === port;
  } catch {
    return false;
  }
}
