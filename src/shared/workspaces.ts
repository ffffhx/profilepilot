export const workspacePages = {
  browser: { file: "index.html", label: "PC 控制" },
  phones: { file: "phones.html", label: "手机控制" },
  tools: { file: "tools.html", label: "配套工具" },
  agent: { file: "tasks.html", label: "Agent" },
  "local-apps": { file: "local-apps.html", label: "PC 控制 · Electron 应用" },
  settings: { file: "settings.html", label: "设置" }
} as const;
export type WorkspaceId = keyof typeof workspacePages;

/** The two PC views keep separate cached panes and API permissions. */
export function workspaceNavigationId(id: WorkspaceId): WorkspaceId {
  return id === "local-apps" ? "browser" : id;
}

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
