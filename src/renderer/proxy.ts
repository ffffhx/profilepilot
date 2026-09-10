import type { BifrostSnapshot } from "./types";
import { normalizeProxyEndpoint, parseProxyEndpoint } from "../shared/proxy-endpoint";

export const DEFAULT_CLASH_PROXY_SERVER = "http://127.0.0.1:7897";
export const DEFAULT_BIFROST_PROXY_SERVER = "http://127.0.0.1:9900";

export function normalizeProxyServerInput(input: string): string | null {
  return normalizeProxyEndpoint(input);
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
  const endpoint = parseProxyEndpoint(server);
  return Boolean(endpoint && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.host) && endpoint.port === port);
}
