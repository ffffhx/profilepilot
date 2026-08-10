import type { SystemProxyRoute, SystemProxySnapshot } from "../shared/types";

const SYSTEM_PROXY_TARGETS = [
  { protocol: "http", url: "http://www.example.com/" },
  { protocol: "https", url: "https://www.example.com/" }
] as const;

export function parseResolvedProxy(
  protocol: SystemProxyRoute["protocol"],
  value: string
): SystemProxyRoute[] {
  return String(value || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): SystemProxyRoute => {
      if (part.toUpperCase() === "DIRECT") {
        return { protocol, kind: "direct", endpoint: null };
      }
      const match = part.match(/^([A-Za-z0-9]+)\s+(.+)$/);
      if (!match) {
        return { protocol, kind: "unknown", endpoint: part };
      }
      const token = match[1].toUpperCase();
      const kind: SystemProxyRoute["kind"] =
        token === "PROXY"
          ? "http"
          : token === "HTTPS"
            ? "https"
            : token === "SOCKS" || token === "SOCKS4"
              ? "socks4"
              : token === "SOCKS5"
                ? "socks5"
                : token === "QUIC"
                  ? "quic"
                  : "unknown";
      return { protocol, kind, endpoint: match[2].trim() || null };
    });
}

export async function resolveSystemProxySnapshot(
  resolveProxy: (url: string) => Promise<string>
): Promise<SystemProxySnapshot> {
  const results = await Promise.allSettled(
    SYSTEM_PROXY_TARGETS.map(async ({ protocol, url }) => ({
      protocol,
      routes: parseResolvedProxy(protocol, await resolveProxy(url))
    }))
  );
  const routes = results.flatMap((result) => result.status === "fulfilled" ? result.value.routes : []);
  const primaryRoutes = SYSTEM_PROXY_TARGETS
    .map(({ protocol }) => routes.find((route) => route.protocol === protocol))
    .filter((route): route is SystemProxyRoute => Boolean(route));
  const proxyCount = primaryRoutes.filter((route) => route.kind !== "direct" && route.kind !== "unknown").length;
  const directCount = primaryRoutes.filter((route) => route.kind === "direct").length;
  const mode: SystemProxySnapshot["mode"] =
    proxyCount && directCount
      ? "mixed"
      : proxyCount
        ? "proxy"
        : directCount === SYSTEM_PROXY_TARGETS.length
          ? "direct"
          : "unknown";
  return { mode, routes };
}
