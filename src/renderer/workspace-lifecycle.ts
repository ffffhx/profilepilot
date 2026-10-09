import type { WorkspaceId } from "../shared/workspaces";

declare global {
  interface Window {
    workspaceHost?: {
      navigate(href: string): boolean;
      openGuide(): void;
      ready(source: Window): void;
      owns(source: Window): boolean;
    };
    workspacePane?: {
      active: boolean;
      setActive(active: boolean): void;
      route(search: string): void;
      shortcut(event: KeyboardEventInit): boolean;
      dispose(): void;
    };
  }
}

export function workspaceHidden(): boolean {
  return document.hidden || window.workspacePane?.active === false;
}

export function onWorkspaceVisibilityChanged(listener: () => void): void {
  document.addEventListener("visibilitychange", listener);
  document.addEventListener("workspace-visibilitychange", listener);
}

export function navigateWorkspace(href: string): boolean {
  return (window.workspaceHost || window.parent.workspaceHost)?.navigate(href) ?? false;
}

export function workspaceRendered(): void {
  if (window.workspacePane) window.parent.workspaceHost?.ready(window);
}

export function currentWorkspace(): WorkspaceId | undefined {
  return document.documentElement.dataset.workspace as WorkspaceId | undefined;
}
