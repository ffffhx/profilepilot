export const workspacePages = {
  agent: { file: "tasks.html", label: "Agent" },
  browser: { file: "index.html", label: "浏览器" },
  "local-apps": { file: "local-apps.html", label: "本地应用" },
  phones: { file: "phones.html", label: "手机" },
  tools: { file: "tools.html", label: "配套工具" }
} as const;
export type WorkspaceId = keyof typeof workspacePages;

/** Only bundled workspaces in the shell's own directory are navigation targets. */
export function workspaceRoute(href: string, base: string): { id: WorkspaceId; url: URL } | undefined {
  try {
    const url = new URL(href, base);
    for (const [id, page] of Object.entries(workspacePages)) {
      const expected = new URL(page.file, base);
      if (url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname &&
          !url.username && !url.password && url.searchParams.get("mode") !== "mini") {
        return { id: id as WorkspaceId, url };
      }
    }
  } catch { /* Not an application route. */ }
  return undefined;
}
