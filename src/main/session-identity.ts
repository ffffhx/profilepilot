import path from "node:path";
import type {
  CanonicalSessionIdentity,
  SessionIdentityDiagnostic,
  SessionRepresentation
} from "../shared/types";

type SessionCoreModule = typeof import("agent-session-core");

const DISCOVERY_CACHE_MS = 30_000;
const DISCOVERY_WINDOW_MS = 120 * 24 * 60 * 60_000;

let corePromise: Promise<SessionCoreModule> | null = null;
let discoveryCache:
  | {
      expiresAt: number;
      byEngine: Record<"codex" | "claude", SessionRepresentation[]>;
      diagnostics: SessionIdentityDiagnostic[];
    }
  | null = null;

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<SessionCoreModule>;

export async function resolveCanonicalSessionIdentity(
  session: string | null | undefined,
  explicitFile?: string | null
): Promise<CanonicalSessionIdentity | null> {
  const parsed = parseNativeSessionId(session);
  if (!parsed) {
    return null;
  }

  const discovered = await discoverRepresentations();
  const suffix = parsed.engine === "codex"
    ? `-${parsed.nativeSessionId}.jsonl`
    : `${parsed.nativeSessionId}.jsonl`;
  const representations = discovered.byEngine[parsed.engine]
    .filter((representation) => representation.filePath.endsWith(suffix));

  if (explicitFile && explicitFile.endsWith(suffix)) {
    representations.push({
      source: sessionSourceForPath(explicitFile, parsed.engine),
      filePath: explicitFile,
      mtimeMs: 0,
      sizeBytes: 0
    });
  }

  const uniqueRepresentations = uniqueSessionRepresentations(representations);
  const diagnostics = [...discovered.diagnostics];
  if (!uniqueRepresentations.length) {
    diagnostics.push({
      code: "SESSION_REPRESENTATION_NOT_FOUND",
      severity: "warning",
      message: "共享 Session 索引没有找到这个原生 Session 的档案表示；控制权仍按 Gateway Session ID 生效。"
    });
  }

  return {
    canonicalSessionId: `${parsed.engine}:${parsed.nativeSessionId.toLowerCase()}`,
    engine: parsed.engine,
    nativeSessionId: parsed.nativeSessionId.toLowerCase(),
    representations: uniqueRepresentations.sort((a, b) => b.mtimeMs - a.mtimeMs),
    diagnostics
  };
}

export function parseNativeSessionId(
  session: string | null | undefined
): { engine: "codex" | "claude"; nativeSessionId: string } | null {
  const value = String(session || "").trim();
  const codex = value.match(/^cx-([0-9a-fA-F-]{36})$/);
  if (codex) {
    return { engine: "codex", nativeSessionId: codex[1] };
  }
  const claude = value.match(/^cc-([0-9a-fA-F-]{36})$/);
  if (claude) {
    return { engine: "claude", nativeSessionId: claude[1] };
  }
  return null;
}

async function discoverRepresentations(): Promise<{
  byEngine: Record<"codex" | "claude", SessionRepresentation[]>;
  diagnostics: SessionIdentityDiagnostic[];
}> {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) {
    return discoveryCache;
  }

  const byEngine: Record<"codex" | "claude", SessionRepresentation[]> = {
    codex: [],
    claude: []
  };
  const diagnostics: SessionIdentityDiagnostic[] = [];
  try {
    const core = await loadSessionCore();
    const roots = core.defaultRoots();
    for (const engine of ["codex", "claude"] as const) {
      for (const root of roots[engine] || []) {
        const files = core.discoverSessionFiles({
          roots: {
            codex: engine === "codex" ? [root] : [],
            claude: engine === "claude" ? [root] : []
          },
          sinceMs: DISCOVERY_WINDOW_MS,
          maxFiles: 10_000
        });
        for (const file of files) {
          byEngine[engine].push({
            source: sessionSourceForPath(file.path, engine, root),
            filePath: file.path,
            mtimeMs: file.mtimeMs,
            sizeBytes: file.sizeBytes
          });
        }
      }
    }
  } catch (error) {
    diagnostics.push({
      code: "SESSION_CORE_UNAVAILABLE",
      severity: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  discoveryCache = {
    expiresAt: Date.now() + DISCOVERY_CACHE_MS,
    byEngine: {
      codex: uniqueSessionRepresentations(byEngine.codex),
      claude: uniqueSessionRepresentations(byEngine.claude)
    },
    diagnostics
  };
  return discoveryCache;
}

async function loadSessionCore(): Promise<SessionCoreModule> {
  if (!corePromise) {
    corePromise = nativeImport("agent-session-core");
  }
  return corePromise;
}

function sessionSourceForPath(
  filePath: string,
  engine: "codex" | "claude",
  configuredRoot = ""
): SessionRepresentation["source"] {
  const normalized = path.normalize(`${configuredRoot}\n${filePath}`).toLowerCase();
  if (engine === "claude") {
    return "claude-home";
  }
  if (normalized.includes(`${path.sep}library${path.sep}application support${path.sep}orca${path.sep}`)) {
    return "orca-codex-home";
  }
  if (normalized.includes(`${path.sep}.codex${path.sep}`)) {
    return "default-codex-home";
  }
  return "configured-codex-home";
}

function uniqueSessionRepresentations(
  representations: SessionRepresentation[]
): SessionRepresentation[] {
  const byPath = new Map<string, SessionRepresentation>();
  for (const representation of representations) {
    const existing = byPath.get(representation.filePath);
    if (!existing || representation.mtimeMs > existing.mtimeMs) {
      byPath.set(representation.filePath, representation);
    }
  }
  return [...byPath.values()];
}

export function __resetSessionIdentityCacheForTests(): void {
  discoveryCache = null;
  corePromise = null;
}
