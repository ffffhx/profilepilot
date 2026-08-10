import { execFileSync } from "node:child_process";
import path from "node:path";

export interface BrowserDriverRepositoryIdentity {
  project?: string;
  branch?: string;
}

export function repositoryIdentityFromCwd(
  cwdInput: string | undefined
): BrowserDriverRepositoryIdentity {
  const cwd = typeof cwdInput === "string" && cwdInput.trim() ? cwdInput.trim() : "";
  if (!cwd) return {};

  const fallbackProject = path.basename(cwd) || cwd;
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { project: fallbackProject };

  const remote = gitOutput(root, ["remote", "get-url", "origin"]);
  const project = repositoryNameFromRemote(remote) || path.basename(root) || fallbackProject;
  const branch = gitOutput(root, ["branch", "--show-current"]);
  if (branch) return { project, branch };

  const revision = gitOutput(root, ["rev-parse", "--short", "HEAD"]);
  return { project, branch: revision ? `detached@${revision}` : undefined };
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
      maxBuffer: 64 * 1024
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function repositoryNameFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const normalized = remote.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const name = normalized.split(/[\\/:]/).filter(Boolean).at(-1);
  return name || undefined;
}
