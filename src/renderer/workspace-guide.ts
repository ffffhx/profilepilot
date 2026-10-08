import { workspacePages, type WorkspaceId } from "../shared/workspaces";
import { guidePlacement, type GuideRect, type GuideSide } from "./workspace-guide-layout";

const STORAGE_KEY = "profilepilot:workspace-guide:v2";
type GuideStep = {
  id: string; workspace: WorkspaceId; selector: string; title: string; description: string;
  shell?: boolean; side?: GuideSide; optional?: boolean; reveal?: string;
};
const tab = (workspace: WorkspaceId, title: string, description: string): GuideStep => ({
  id: `${workspace}-tab`, workspace, selector: `.workspace-link[data-workspace="${workspace}"]`, shell: true, title, description
});
const steps: GuideStep[] = [
  tab("agent", "Agent：把任务交给 AI", "在这个 Tab 描述目标、查看执行过程和结果。任务进行中也可以补充要求、暂停或接管。"),
  { id: "agent-new", workspace: "agent", selector: '.agent-workspace-heading [data-nav="tasks"]', side: "left", title: "从这里开始一个新任务", description: "点击「新建任务」后，选择浏览器 Profile，再告诉 Agent 你想完成什么。先在左下角「设置」配置模型服务。" },
  { id: "agent-prompt", workspace: "agent", selector: "#prompt, #steering", side: "top", optional: true, title: "在输入框里说清楚目标", description: "例如：整理当前网页里的产品名称和价格，生成表格。说明预期结果，必要时附上文件；已有任务也能在这里补充要求。" },
  { id: "agent-profile", workspace: "agent", selector: "#workspace-profile", shell: true, side: "bottom", title: "确认要使用的浏览器 Profile", description: "这里显示当前浏览器环境。不同 Profile 保存各自的账号和登录状态；创建任务时，也请确认任务输入区选中了所需的 Profile。" },
  tab("browser", "浏览器：管理账号与环境", "集中查看日常 Chrome 和独立 Profile，确认运行、连接与控制状态。Profile 是保存账号、登录状态和配置的浏览器空间。"),
  { id: "browser-new", workspace: "browser", selector: '[data-action="new-profile"]', side: "bottom", title: "需要独立环境时，新建 Profile", description: "为测试或其他账号创建独立的浏览器环境。如果想用平时已登录的 Chrome，可以到「配套工具」连接浏览器扩展。" },
  { id: "browser-profiles", workspace: "browser", selector: ".profiles-section-head", side: "bottom", title: "在这里查找你的浏览器", description: "通过搜索找到需要的 Profile，再从下方列表选择它，查看连接状态、启动浏览器或管理配置。" },
  tab("local-apps", "本地应用：管理项目和服务", "把常用开发项目、Electron 应用和后台服务集中在这里，查看运行状态、端口与日志。支持连接的 Electron 应用也可以交给 Agent 操作。"),
  { id: "apps-add", workspace: "local-apps", selector: '.app-topbar [data-action="add"]', side: "left", title: "先添加一个本地项目", description: "选择项目目录并配置启动命令，以后就能在这里启动、停止和查看日志。只有需要管理本地项目时才需要添加。" },
  { id: "apps-list", workspace: "local-apps", selector: ".app-sidebar", side: "right", title: "从列表切换项目", description: "已添加的应用会出现在这里。选中一个项目后，右侧会展示它的运行信息、连接入口和日志，便于排查启动问题。" },
  tab("phones", "手机：连接 Android 与移动工作区", "这里支持电脑查看或控制 Android 手机，也能让你从手机发送电脑任务、跟进结果和处理确认。"),
  { id: "phone-connect", workspace: "phones", selector: '.phone-empty-actions [data-action="wifi"], .phone-route [data-action="wifi"], [data-phone-options] [data-action="wifi"]', reveal: "[data-phone-options]", side: "top", title: "从这里连接 Android 手机", description: "按连接向导完成 Wi-Fi 配对，也可以使用 USB 连接。电脑控制手机需要手机端授权；连接后仍可随时暂停或接管。" },
  { id: "phone-mobile", workspace: "phones", selector: '[data-phone-options] [data-action="mobile"]', reveal: "[data-phone-options]", side: "top", title: "也可以用手机管理电脑任务", description: "从这个入口连接移动版，在手机上发任务、查看进度和处理确认。使用时需要电脑保持运行，手机能访问这台电脑。" },
  tab("tools", "配套工具：完成连接与安装", "第一次使用日常 Chrome，可以先来这里。浏览器扩展负责连接，CLI 和使用指引方便外部 Agent 调用 ProfilePilot。"),
  { id: "tools-extension", workspace: "tools", selector: '[data-action="connect-browser-extension"]', side: "bottom", title: "连接你日常使用的 Chrome", description: "先在这一栏选择常用 Profile，再点击此按钮，按 Chrome 中的提示完成扩展安装与连接，就能沿用已有登录状态。" },
  { id: "tools-cli", workspace: "tools", selector: '[data-action="install-profilepilot-cli"]', side: "bottom", title: "让外部 Agent 使用 ProfilePilot", description: "需要从外部 Agent 操作浏览器或手机时，在这里安装 CLI 和配套使用指引。安装状态和更新入口也会显示在这一栏。" },
  { id: "tools-preferences", workspace: "tools", selector: '[data-action="open-control-preferences"]', side: "top", title: "告诉 Agent 你的控制偏好", description: "在这里编辑浏览器、手机的使用偏好，例如默认使用哪个 Profile、什么时候需要你接管，让外部 Agent 按你的习惯工作。" },
  { id: "settings", workspace: "tools", selector: ".workspace-settings", shell: true, title: "最后，在设置中配置模型", description: "内置 Agent 的模型服务在这里配置。准备好浏览器和模型后，回到 Agent 开始第一个任务。想再看一遍，点击下方「新手引导」。" }
];
const visible = (node: HTMLElement) => {
  const rect = node.getBoundingClientRect();
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none";
};

/** Highlights real controls across the shell's same-origin workspace frames. */
export function createWorkspaceGuide(navigate: (href: string) => boolean) {
  let evaluated = false;
  let dialog: HTMLDialogElement | undefined;

  function open(): void {
    if (dialog?.open) return;
    evaluated = true;
    const startingWorkspace = document.documentElement.dataset.workspace as WorkspaceId | undefined;
    const restoreFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : document.querySelector<HTMLElement>("[data-workspace-guide]");
    const element = document.createElement("dialog");
    dialog = element;
    element.id = "workspace-guide";
    element.className = "workspace-guide";
    try {
      const theme = localStorage.getItem("profilepilot-workspace-theme") || "light";
      element.dataset.theme = theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme;
    } catch { /* Storage is optional. */ }
    element.setAttribute("aria-labelledby", "workspace-guide-title");
    element.setAttribute("aria-describedby", "workspace-guide-description");
    element.innerHTML = `<div class="guide-veil" aria-hidden="true"></div><div class="guide-spotlight" aria-hidden="true" hidden></div>
      <section class="guide-card"><header class="guide-header"><label class="guide-chapter-label">功能导览 <select data-guide-chapter aria-label="跳转到功能章节">${Object.entries(workspacePages).map(([id, page]) => `<option value="${id}">${page.label}</option>`).join("")}<option value="settings">设置</option></select></label><button type="button" class="guide-close" data-guide-close aria-label="关闭新手引导">×</button></header>
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
      if (next < 0 || next >= steps.length) return;
      direction = next < index ? -1 : 1;
      restoreDetails();
      index = next;
      const step = steps[index];
      element.dataset.step = String(index);
      element.dataset.stepId = step.id;
      element.dataset.targetSelector = step.selector;
      element.dataset.targetScope = step.shell ? "shell" : "page";
      element.dataset.targetWorkspace = step.workspace;
      element.querySelector("h2")!.textContent = step.title;
      element.querySelector("#workspace-guide-description")!.textContent = step.description;
      element.querySelector<HTMLSelectElement>("[data-guide-chapter]")!.value = step.id === "settings" ? "settings" : step.workspace;
      element.querySelector(".guide-progress")!.textContent = `${index + 1} / ${steps.length}`;
      element.querySelector<HTMLButtonElement>("[data-guide-back]")!.hidden = index === 0;
      element.querySelector<HTMLButtonElement>("[data-guide-next]")!.textContent = index === steps.length - 1 ? "完成导览" : "下一步";
      status.hidden = true; retry.hidden = true;
      clearTarget();
      scrolled = false; startedAt = performance.now();
      navigate(workspacePages[step.workspace].file);
      element.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
    }
    function track() {
      if (!element.open) return;
      // A newly loaded frame may autofocus its composer after showModal().
      if (!element.contains(document.activeElement)) element.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
      const step = steps[index];
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
      if (index === steps.length - 1) element.close("completed");
      else go(index + 1);
    }
    element.addEventListener("click", event => {
      const button = (event.target as Element).closest("button");
      if (button?.hasAttribute("data-guide-close")) element.close("dismissed");
      else if (button?.hasAttribute("data-guide-next")) advance();
      else if (button?.hasAttribute("data-guide-back")) go(index - 1);
      else if (button?.hasAttribute("data-guide-retry")) go(index);
    });
    element.querySelector("[data-guide-chapter]")!.addEventListener("change", event => {
      const value = (event.target as HTMLSelectElement).value;
      go(steps.findIndex(step => value === "settings" ? step.id === "settings" : step.workspace === value));
    });
    element.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); return; }
      if ((event.target as Element).closest("select")) return;
      if (event.key === "ArrowRight") { event.preventDefault(); advance(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
    });
    element.addEventListener("close", () => {
      cancelAnimationFrame(animation);
      restoreDetails();
      for (const [node, position] of scrollPositions) {
        if (node.isConnected) { node.scrollTop = position.top; node.scrollLeft = position.left; }
      }
      try { localStorage.setItem(STORAGE_KEY, element.returnValue === "completed" ? "completed" : "dismissed"); } catch { /* Dismiss still works without storage. */ }
      element.remove();
      if (dialog === element) dialog = undefined;
      if (startingWorkspace && Object.hasOwn(workspacePages, startingWorkspace)) navigate(workspacePages[startingWorkspace].file);
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    }, { once: true });
    document.body.append(element);
    element.showModal();
    go(0);
    animation = requestAnimationFrame(track);
  }

  return {
    open,
    showOnce() {
      if (evaluated) return;
      evaluated = true;
      const force = new URLSearchParams(location.search).get("guide") === "1";
      try { if (!force && ["completed", "dismissed"].includes(localStorage.getItem(STORAGE_KEY) || "")) return; } catch { /* Show once when storage is unavailable. */ }
      open();
    }
  };
}

export function openWorkspaceGuide(): void {
  const host = window.workspaceHost || window.parent.workspaceHost;
  if (host) { host.openGuide(); return; }
  window.location.href = "./workspace.html?guide=1";
}
