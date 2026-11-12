const topbar = document.querySelector("[data-topbar]");
const workflowButtons = document.querySelectorAll("[data-workflow]");
const workflowCopy = document.querySelector("[data-workflow-copy]");
const workflowVisual = document.querySelector("[data-workflow-visual]");
const copyButtons = document.querySelectorAll("[data-copy-command]");

const workflows = {
  "native": {
    "index": "01",
    "title": "连接你已经登录的 Chrome",
    "copy": "在「配套工具」中选择日常 Profile，按引导安装并连接浏览器扩展，沿用已有页面和账号。",
    "nodes": [
      "选择 Profile",
      "连接扩展",
      "开始使用"
    ]
  },
  "extensions": {
    "index": "02",
    "title": "配置模型，描述要完成的目标",
    "copy": "在设置中配置模型服务，回到 Agent 选择浏览器，描述目标与预期结果，随时查看进度、补充要求或接管。",
    "nodes": [
      "配置模型",
      "描述目标",
      "跟进结果"
    ]
  },
  "account": {
    "index": "03",
    "title": "把开发项目和后台服务放在一起",
    "copy": "添加项目目录和启动命令，集中启动应用、查看端口与日志。支持调试的 Electron 应用可以连接 Agent。",
    "nodes": [
      "添加项目",
      "启动应用",
      "查看日志"
    ]
  },
  "cdp": {
    "index": "04",
    "title": "准备 Android 的连接与权限",
    "copy": "安装配套 APK，按手机上的提示准备连接、无障碍与悬浮提示。在电脑端选择设备、发起控制，手机上可随时暂停或停止。",
    "nodes": [
      "安装 APK",
      "准备权限",
      "电脑端控制"
    ]
  }
};

function syncTopbar() {
  if (!topbar) {
    return;
  }
  topbar.classList.toggle("scrolled", window.scrollY > 12);
}

function setWorkflow(key) {
  key = Object.hasOwn(workflows, key) ? key : 'native';
  const data = workflows[key];
  workflowButtons.forEach((button) => {
    const active = button.dataset.workflow === key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  if (workflowCopy) {
    workflowCopy.innerHTML = `
      <span>${data.index}</span>
      <h3>${data.title}</h3>
      <p>${data.copy}</p>
    `;
  }
  document.getElementById('workflow-panel')?.setAttribute('aria-labelledby', 'workflow-tab-' + key);

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

workflowButtons.forEach((button, index) => {
  button.addEventListener("click", () => setWorkflow(button.dataset.workflow || "native"));
  button.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % workflowButtons.length
      : event.key === 'ArrowLeft' ? (index - 1 + workflowButtons.length) % workflowButtons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? workflowButtons.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = workflowButtons[next];
    setWorkflow(target.dataset.workflow || 'native');
    target.focus();
  });
});

copyButtons.forEach((copyButton) => {
  copyButton.addEventListener("click", async () => {
    const command = copyButton.dataset.copyCommand || "";
    const defaultLabel = copyButton.textContent || "复制";
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
        copyButton.textContent = defaultLabel;
      }, 1400);
    } catch {
      if (copyWithFallback()) {
        copyButton.textContent = "已复制";
        window.setTimeout(() => {
          copyButton.textContent = defaultLabel;
        }, 1400);
      } else {
        copyButton.textContent = "手动复制";
      }
    }
  });
});

window.addEventListener("scroll", syncTopbar, { passive: true });
syncTopbar();

const revealTargets = document.querySelectorAll("main > section, .site-footer");
if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -40px" }
  );
  revealTargets.forEach((element) => {
    element.classList.add("reveal");
    revealObserver.observe(element);
  });
}
