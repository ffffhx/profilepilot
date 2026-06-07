const topbar = document.querySelector("[data-topbar]");
const workflowButtons = document.querySelectorAll("[data-workflow]");
const workflowCopy = document.querySelector("[data-workflow-copy]");
const workflowVisual = document.querySelector("[data-workflow-visual]");
const copyButton = document.querySelector("[data-copy-command]");

const workflows = {
  native: {
    index: "01",
    title: "发现你已经在用的 Chrome Profile",
    copy: "读取 Chrome Local State，把 Default 和 Profile N 作为一等公民呈现，同时保护默认 Profile 不被误删。",
    nodes: ["Local State", "Default", "Profile N"]
  },
  extensions: {
    index: "02",
    title: "从源 Profile 扫描并迁移扩展",
    copy: "识别扩展来源、版本、数据目录和 Web Store 地址，先备份目标，再复制可本地挂载的扩展和数据。",
    nodes: ["Scan", "Backup", "Migrate"]
  },
  account: {
    index: "03",
    title: "把已落盘登录态同步到目标环境",
    copy: "复制 Cookies、Local Storage、IndexedDB、Web Data 和账号偏好，让测试 Profile 继承可验证会话。",
    nodes: ["Session", "Storage", "Restore point"]
  },
  cdp: {
    index: "04",
    title: "用可控端口启动 Agent 浏览器",
    copy: "隔离 Profile 可以带 remote debugging port 启动，避开默认浏览器状态，方便自动化工具接管。",
    nodes: ["Isolated", "Port check", "CDP URL"]
  }
};

function syncTopbar() {
  if (!topbar) {
    return;
  }
  topbar.classList.toggle("scrolled", window.scrollY > 12);
}

function setWorkflow(key) {
  const data = workflows[key] || workflows.native;
  workflowButtons.forEach((button) => {
    const active = button.dataset.workflow === key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  if (workflowCopy) {
    workflowCopy.innerHTML = `
      <span>${data.index}</span>
      <h3>${data.title}</h3>
      <p>${data.copy}</p>
    `;
  }

  if (workflowVisual) {
    workflowVisual.innerHTML = data.nodes
      .map((node, index) => {
        const className = index === 0 ? "workflow-node on" : index === data.nodes.length - 1 ? "workflow-node accent" : "workflow-node";
        const line = index < data.nodes.length - 1 ? '<div class="workflow-line"></div>' : "";
        return `<div class="${className}">${node}</div>${line}`;
      })
      .join("");
  }
}

workflowButtons.forEach((button) => {
  button.addEventListener("click", () => setWorkflow(button.dataset.workflow || "native"));
});

if (copyButton) {
  copyButton.addEventListener("click", async () => {
    const command = copyButton.dataset.copyCommand || "";
    const copyWithFallback = () => {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    };

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else if (!copyWithFallback()) {
        throw new Error("Clipboard fallback failed.");
      }
      copyButton.textContent = "已复制";
      window.setTimeout(() => {
        copyButton.textContent = "复制";
      }, 1400);
    } catch {
      if (copyWithFallback()) {
        copyButton.textContent = "已复制";
        window.setTimeout(() => {
          copyButton.textContent = "复制";
        }, 1400);
      } else {
        copyButton.textContent = "手动复制";
      }
    }
  });
}

window.addEventListener("scroll", syncTopbar, { passive: true });
syncTopbar();
