export interface ParsedProxyEndpoint {
  scheme: "http" | "https" | "socks5";
  host: string;
  port: number;
}

export function parseProxyEndpoint(input: unknown): ParsedProxyEndpoint | null {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > 200 || /[\s\0]/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") return null;
    // Chrome's proxy-server flag does not support credentials. Reject them instead
    // of silently dropping authentication when normalizing the address.
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return null;
    // URL.port omits even an explicitly supplied protocol-default port. Keep the
    // input's explicit-port requirement while accepting :80 and :443.
    const authority = withScheme.slice(withScheme.indexOf("://") + 3).split("/")[0];
    if (!/:\d+$/.test(authority)) return null;
    const port = Number(url.port || (scheme === "http" ? 80 : scheme === "https" ? 443 : 0));
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { scheme, host: url.hostname, port };
  } catch {
    return null;
  }
}

export function normalizeProxyEndpoint(input: unknown): string | null {
  const parsed = parseProxyEndpoint(input);
  return parsed ? `${parsed.scheme}://${parsed.host}:${parsed.port}` : null;
}
