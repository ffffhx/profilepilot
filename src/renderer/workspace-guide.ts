import { workspacePages, type WorkspaceId } from "../shared/workspaces";
import { guidePlacement, type GuideRect, type GuideSide } from "./workspace-guide-layout";

const STORAGE_KEY = "profilepilot:workspace-guide:v3";
type GuideStep = {
  id: string; workspace: WorkspaceId; selector: string; title: string; description: string;
  shell?: boolean; side?: GuideSide; optional?: boolean; reveal?: string;
};
const tab = (workspace: WorkspaceId, title: string, description: string): GuideStep => ({
  id: `${workspace}-tab`, workspace, selector: `.workspace-link[data-workspace="${workspace}"]`, shell: true, title, description
});
const steps: GuideStep[] = [
  tab("browser", "PC 控制：管理浏览器与桌面应用", "默认展示浏览器 Profiles，保存账号、登录状态和配置。点击页面顶部的「Electron 应用」可切换到桌面应用列表。"),
  { id: "browser-new", workspace: "browser", selector: '.account-sync-panel [data-action="open-agent-browser-setup"]', side: "top", title: "从这里创建 Agent 浏览器", description: "选择一个已有 Profile 作为来源，创建独立的 Agent 浏览器。如果想用平时已登录的 Chrome，可以到「配套工具」连接浏览器扩展。" },
  { id: "browser-profiles", workspace: "browser", selector: ".profiles-section-head", side: "bottom", title: "在这里选择你的浏览器", description: "从下方列表选择需要的 Profile，查看连接状态、启动浏览器或管理配置。" },
  tab("phones", "手机控制：连接 Android 与移动工作区", "这里支持电脑查看或控制 Android 手机，也能让你从手机发送电脑任务、跟进结果和处理确认。"),
  { id: "phone-connect", workspace: "phones", selector: '.phone-connection-section', side: "bottom", title: "先连接 Android 手机", description: "USB 或 Wi-Fi 任选一种。连接成功后，点击下方“查看手机”即可使用，无需安装手机 App。" },
  { id: "phone-mobile", workspace: "phones", selector: '[data-phone-options] [data-action="mobile"]', reveal: "[data-phone-options]", side: "top", title: "也可以用手机管理电脑任务", description: "从这个入口连接移动版，在手机上发任务、查看进度和处理确认。使用时需要电脑保持运行，手机能访问这台电脑。" },
  tab("tools", "配套工具：完成连接与安装", "第一次使用日常 Chrome，可以先来这里。浏览器扩展负责连接，CLI 和使用指引方便外部 Agent 调用 ProfilePilot。"),
  { id: "tools-extension", workspace: "tools", selector: '[data-action="connect-browser-extension"]', side: "bottom", title: "连接你日常使用的 Chrome", description: "先在这一栏选择常用 Profile，再点击此按钮，按 Chrome 中的提示完成扩展安装与连接，就能沿用已有登录状态。" },
  { id: "tools-cli", workspace: "tools", selector: '[data-action="install-profilepilot-cli"]', side: "bottom", title: "让外部 Agent 使用 ProfilePilot", description: "需要从外部 Agent 操作浏览器或手机时，在这里安装 CLI 和配套使用指引。安装状态和更新入口也会显示在这一栏。" },
  tab("agent", "Agent：把任务交给 AI", "在这个 Tab 描述目标、查看执行过程和结果。任务进行中也可以补充要求、暂停或接管。"),
  { id: "agent-prompt", workspace: "agent", selector: "#prompt, #steering", side: "top", optional: true, title: "在输入框里说清楚目标", description: "例如：整理当前网页里的产品名称和价格，生成表格。说明预期结果，必要时附上文件；已有任务也能在这里补充要求。" },
  { id: "local-apps-tab", workspace: "local-apps", selector: '[data-pc-view="local-apps"]', title: "Electron 应用：管理项目和服务", description: "在 PC 控制顶部切换浏览器 Profiles 和 Electron 应用。这里可以查看应用的运行与连接状态，添加本地项目或后台服务。" },
  { id: "apps-add", workspace: "local-apps", selector: '.app-topbar [data-action="add"]', side: "left", title: "先添加一个本地项目", description: "选择项目目录并配置启动命令，以后就能在这里启动、停止和查看日志。只有需要管理本地项目时才需要添加。" },
  { id: "apps-list", workspace: "local-apps", selector: ".pc-apps-table thead", side: "bottom", title: "从表格选择应用", description: "选中一行后可以查看应用详情、管理启动配置和调试连接。应用的状态、连接方式与端口也会直接展示在表格中。" },
  { id: "settings", workspace: "agent", selector: '.sidebar-footer [data-nav="settings"]', title: "在 Agent 设置中配置模型", description: "内置 Agent 的模型服务、任务运行与记录选项在这里配置。准备好浏览器和模型后，回到 Agent 开始第一个任务。" }
];
const visible = (node: HTMLElement) => {
  const rect = node.getBoundingClientRect();
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none";
};

/** Highlights real controls across the shell's same-origin workspace frames. */
export function createWorkspaceGuide() {
  const evaluated = new Set<WorkspaceId>();
  let dialog: HTMLDialogElement | undefined;
  let current: WorkspaceId | undefined;
  let dismiss: (() => void) | undefined;
  let forced = false;

  function open(): void {
    const workspace = document.documentElement.dataset.workspace as WorkspaceId;
    if (!Object.hasOwn(workspacePages, workspace)) return;
    if (dialog?.open && current === workspace) return;
    dismiss?.();
    const tourSteps = steps.filter(step => step.workspace === workspace);
    if (!tourSteps.length) return;
    current = workspace;
    evaluated.add(workspace);
    const frame = document.querySelector<HTMLIFrameElement>(`iframe.workspace-page[data-workspace="${workspace}"]`);
    const identity = document.querySelector<HTMLElement>(".workspace-identity");
    if (frame) frame.inert = true;
    if (identity) identity.inert = true;
    const restoreFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : document.querySelector<HTMLElement>("[data-workspace-guide]");
    const element = document.createElement("dialog");
    dialog = element;
    element.id = "workspace-guide";
    element.className = "workspace-guide";
    element.dataset.workspace = workspace;
    element.setAttribute("aria-modal", "false");
    try {
      const theme = localStorage.getItem("profilepilot-workspace-theme") || "light";
      element.dataset.theme = theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme;
    } catch { /* Storage is optional. */ }
    element.setAttribute("aria-labelledby", "workspace-guide-title");
    element.setAttribute("aria-describedby", "workspace-guide-description");
    element.innerHTML = `<div class="guide-veil" aria-hidden="true"></div><div class="guide-shield" aria-hidden="true"></div><div class="guide-spotlight" aria-hidden="true" hidden></div>
      <section class="guide-card"><header class="guide-header"><span class="guide-chapter-label">${workspacePages[workspace].label} · 快速上手</span><button type="button" class="guide-close" data-guide-close aria-label="关闭新手引导">×</button></header>
      <h2 id="workspace-guide-title" tabindex="-1"></h2><p id="workspace-guide-description"></p>
      <p class="guide-status" role="status" hidden></p><button type="button" class="guide-retry" data-guide-retry hidden>重新定位</button>
      <footer class="guide-footer"><div class="guide-meta"><span class="guide-progress" aria-live="polite" aria-atomic="true"></span><button type="button" class="guide-skip" data-guide-close>跳过引导</button></div><div class="guide-actions"><button type="button" data-guide-back>上一步</button><button type="button" class="primary" data-guide-next>下一步</button></div></footer></section>`;
    const card = element.querySelector<HTMLElement>(".guide-card")!;
    const ring = element.querySelector<HTMLElement>(".guide-spotlight")!;
    const status = element.querySelector<HTMLElement>(".guide-status")!;
    const retry = element.querySelector<HTMLButtonElement>("[data-guide-retry]")!;
    let index = 0, direction = 1, animation = 0, startedAt = 0;
    let lastGeometry = "", scrolled = false, viewport = "";
    const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
    const visitedDocuments = new Set<Document>();
    let openedDetails: { doc: Document; selector: string; wasOpen: boolean } | undefined;

    function rememberScroll(doc: Document) {
      if (visitedDocuments.has(doc)) return;
      visitedDocuments.add(doc);
      for (const node of doc.querySelectorAll<HTMLElement>("*")) {
        if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) {
          scrollPositions.set(node, { top: node.scrollTop, left: node.scrollLeft });
        }
      }
    }
    function restoreDetails() {
      const details = openedDetails?.doc.querySelector<HTMLDetailsElement>(openedDetails.selector);
      if (details && openedDetails) details.open = openedDetails.wasOpen;
      openedDetails = undefined;
    }
    function clearTarget() {
      ring.hidden = true;
      element.dataset.targetReady = "false";
      lastGeometry = "";
    }
    function targetFor(step: GuideStep): { node: HTMLElement; frame?: HTMLIFrameElement } | undefined {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe.workspace-page[data-workspace="${step.workspace}"][data-active="true"]`);
      if (!frame || document.documentElement.dataset.workspaceLoading === "true") return;
      const doc = step.shell ? document : frame.contentDocument;
      if (!doc) return;
      rememberScroll(doc);
      if (step.reveal) {
        const details = doc.querySelector<HTMLDetailsElement>(step.reveal);
        if (details) {
          openedDetails ||= { doc, selector: step.reveal, wasOpen: details.open };
          details.open = true;
        }
      }
      const node = [...doc.querySelectorAll<HTMLElement>(step.selector)].find(visible);
      return node ? { node, frame: step.shell ? undefined : frame } : undefined;
    }
    function bounds(node: HTMLElement, frame?: HTMLIFrameElement): GuideRect | undefined {
      const rect = node.getBoundingClientRect();
      let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = node.ownerDocument.defaultView!.getComputedStyle(ancestor);
        const clip = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
      }
      if (frame) {
        const outer = frame.getBoundingClientRect();
        const sx = outer.width / frame.clientWidth, sy = outer.height / frame.clientHeight;
        left = outer.left + left * sx; right = outer.left + right * sx;
        top = outer.top + top * sy; bottom = outer.top + bottom * sy;
        const rail = document.querySelector(".workspace-rail")?.getBoundingClientRect();
        const header = document.querySelector(".workspace-identity")?.getBoundingClientRect();
        left = Math.max(left, outer.left, rail?.right || 0); right = Math.min(right, outer.right);
        top = Math.max(top, outer.top, header?.bottom || 0); bottom = Math.min(bottom, outer.bottom);
      }
      left = Math.max(5, left); top = Math.max(5, top);
      right = Math.min(innerWidth - 5, right); bottom = Math.min(innerHeight - 5, bottom);
      return right - left > 2 && bottom - top > 2 ? { left, top, width: right - left, height: bottom - top } : undefined;
    }
    function go(next: number) {
      if (next < 0 || next >= tourSteps.length) return;
      direction = next < index ? -1 : 1;
      restoreDetails();
      index = next;
      const step = tourSteps[index];
      element.dataset.step = String(index);
      element.dataset.stepId = step.id;
      element.dataset.targetSelector = step.selector;
      element.dataset.targetScope = step.shell ? "shell" : "page";
      element.dataset.targetWorkspace = step.workspace;
      element.querySelector("h2")!.textContent = step.title;
      element.querySelector("#workspace-guide-description")!.textContent = step.description;
      element.querySelector(".guide-progress")!.textContent = `${index + 1} / ${tourSteps.length}`;
      element.querySelector<HTMLButtonElement>("[data-guide-back]")!.hidden = index === 0;
      element.querySelector<HTMLButtonElement>("[data-guide-next]")!.textContent = index === tourSteps.length - 1 ? "完成导览" : "下一步";
      status.hidden = true; retry.hidden = true;
      clearTarget();
      scrolled = false; startedAt = performance.now();
      element.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
    }
    function track() {
      if (!element.open) return;
      // A freshly loaded composer can request focus late. Keep the guide usable
      // while still allowing keyboard focus on the real workspace navigation.
      if (!element.contains(document.activeElement) && !document.activeElement?.closest(".workspace-rail")) {
        element.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
      }
      const step = tourSteps[index];
      const size = `${innerWidth}:${innerHeight}`;
      if (size !== viewport) { viewport = size; scrolled = false; }
      const target = targetFor(step);
      if (target && !scrolled) {
        target.node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        scrolled = true;
      }
      const rect = target && bounds(target.node, target.frame);
      if (rect) {
        status.hidden = true; retry.hidden = true;
        ring.hidden = false; element.dataset.targetReady = "true";
        const placement = guidePlacement(rect, { width: card.offsetWidth, height: card.offsetHeight }, { width: innerWidth, height: innerHeight }, step.side);
        const geometry = JSON.stringify([rect, placement]);
        if (geometry !== lastGeometry) {
          lastGeometry = geometry;
          Object.assign(ring.style, { left: `${rect.left - 5}px`, top: `${rect.top - 5}px`, width: `${rect.width + 10}px`, height: `${rect.height + 10}px` });
          Object.assign(card.style, { left: `${placement.left}px`, top: `${placement.top}px` });
          card.dataset.side = placement.side;
        }
      } else {
        clearTarget();
        const elapsed = performance.now() - startedAt;
        if (step.optional && elapsed > 1500) { go(index + direction); }
        else {
          status.hidden = false;
          status.textContent = elapsed > 5000 ? "当前页面暂未显示这个位置。可以重新定位，或继续下一步。" : "正在定位页面中的控件…";
          retry.hidden = elapsed <= 5000;
          card.style.left = `${Math.max(12, (innerWidth - card.offsetWidth) / 2)}px`;
          card.style.top = `${Math.max(12, (innerHeight - card.offsetHeight) / 2)}px`;
        }
      }
      animation = requestAnimationFrame(track);
    }
    function advance() {
      if (index === tourSteps.length - 1) finish("completed");
      else go(index + 1);
    }
    element.addEventListener("click", event => {
      const button = (event.target as Element).closest("button");
      if (button?.hasAttribute("data-guide-close")) finish("dismissed");
      else if (button?.hasAttribute("data-guide-next")) advance();
      else if (button?.hasAttribute("data-guide-back")) go(index - 1);
      else if (button?.hasAttribute("data-guide-retry")) go(index);
    });
    element.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); return; }
      if (event.key === "Escape") { event.preventDefault(); finish("dismissed"); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); advance(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
    });
    let finished = false;
    function finish(result: "completed" | "dismissed", restore = true) {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(animation);
      restoreDetails();
      for (const [node, position] of scrollPositions) {
        if (node.isConnected) { node.scrollTop = position.top; node.scrollLeft = position.left; }
      }
      try { localStorage.setItem(`${STORAGE_KEY}:${workspace}`, result); } catch { /* Dismiss still works without storage. */ }
      element.close();
      element.remove();
      delete document.documentElement.dataset.workspaceGuideActive;
      if (frame) frame.inert = frame.dataset.active !== "true";
      if (identity) identity.inert = false;
      if (dialog === element) { dialog = undefined; dismiss = undefined; }
      if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    }
    dismiss = () => finish("dismissed", false);
    element.addEventListener("close", () => finish("dismissed"), { once: true });
    document.body.append(element);
    document.documentElement.dataset.workspaceGuideActive = "true";
    element.show();
    go(0);
    animation = requestAnimationFrame(track);
  }

  return {
    open,
    close() { dismiss?.(); },
    showOnce(workspace: WorkspaceId) {
      if (dialog?.open && current !== workspace) dismiss?.();
      if (!steps.some(step => step.workspace === workspace)) return;
      if (evaluated.has(workspace)) return;
      evaluated.add(workspace);
      const force = !forced && new URLSearchParams(location.search).get("guide") === "1";
      forced = true;
      try { if (!force && ["completed", "dismissed"].includes(localStorage.getItem(`${STORAGE_KEY}:${workspace}`) || "")) return; } catch { /* Remember visits in memory if storage is unavailable. */ }
      open();
    }
  };
}

export function openWorkspaceGuide(): void {
  const host = window.workspaceHost || window.parent.workspaceHost;
  if (host) { host.openGuide(); return; }
  window.location.href = `./workspace.html?guide=1&workspace=${document.documentElement.dataset.workspace || "browser"}`;
}
