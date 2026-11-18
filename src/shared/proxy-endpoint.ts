export type ProxyScheme = "http" | "https" | "socks5" | "socks5h";

export interface ParsedProxyEndpoint {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyEndpoint(input: unknown): ParsedProxyEndpoint | null {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > 512 || /[\s\0]/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks5" && scheme !== "socks5h") return null;
    if (url.search || url.hash || (url.pathname && url.pathname !== "/")) return null;
    const authority = withScheme.slice(withScheme.indexOf("://") + 3).split("/")[0];
    const hasAt = authority.includes("@");
    if (hasAt && !url.username && !url.password) return null;
    const hostPort = hasAt ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
    const portMatch = hostPort.match(/:(\d+)$/);
    if (!portMatch) return null;
    const port = Number(url.port || portMatch[1]);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const hasCredentials = Boolean(url.username || url.password);
    const decodedUsername = hasCredentials ? safeDecodeCredential(url.username) : undefined;
    const decodedPassword = hasCredentials ? safeDecodeCredential(url.password) : undefined;
    if (hasCredentials && (decodedUsername === null || decodedPassword === null)) return null;
    return {
      scheme,
      host: url.hostname,
      port,
      ...(hasCredentials
        ? {
            username: decodedUsername ?? "",
            password: decodedPassword ?? ""
          }
        : {})
    };
  } catch {
    return null;
  }
}

function safeDecodeCredential(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function normalizeProxyEndpoint(input: unknown): string | null {
  const parsed = parseProxyEndpoint(input);
  if (!parsed) return null;
  if (parsed.username !== undefined || parsed.password !== undefined) {
    const encodedUser = encodeURIComponent(parsed.username || "");
    const encodedPass = parsed.password ? `:${encodeURIComponent(parsed.password)}` : "";
    return `${parsed.scheme}://${encodedUser}${encodedPass}@${parsed.host}:${parsed.port}`;
  }
  return `${parsed.scheme}://${parsed.host}:${parsed.port}`;
}

export function redactProxyEndpoint(input: unknown): string | null {
  const parsed = parseProxyEndpoint(input);
  if (!parsed) return null;
  return `${parsed.scheme}://${parsed.host}:${parsed.port}`;
}
