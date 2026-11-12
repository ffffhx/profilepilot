import type { PhoneAction, PhoneDevice } from "../shared/phones";
import type { IphoneToolsStatus } from "../shared/iphones";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function openIphoneAdd(onAdded: (device: PhoneDevice) => void): void {
  const dialog = document.createElement("dialog"); dialog.className = "phone-connect-dialog phone-add-dialog"; dialog.setAttribute("aria-label", "添加 iPhone");
  dialog.classList.add("iphone-setup-dialog");
  dialog.innerHTML = `<header><h2>连接 iPhone 真机</h2><button data-close aria-label="关闭">×</button></header>
    <p>Windows / macOS · iOS 18 及以上。首次使用需要数据线、开发者模式和已签名的控制组件。</p>
    <section class="iphone-setup-step"><h3>1. 准备电脑</h3><p data-tools-status role="status">正在检查连接工具…</p>
      <div class="iphone-setup-actions"><button data-do="setup">准备 USB 工具</button><button data-do="driver">Apple 设备驱动</button><button data-do="refresh">刷新设备</button></div>
    </section>
    <section class="iphone-setup-step"><h3>2. 选择 iPhone</h3><p>用数据线连接、解锁手机，并选择「信任此电脑」。可以先准备电脑，稍后再接手机。</p>
      <label>USB 设备<select data-device aria-label="USB iPhone"><option value="">尚未检测到 iPhone</option></select></label>
      <button data-do="devmode" data-needs-device>显示开发者模式入口</button><p>随后在手机「设置 → 隐私与安全性」中开启开发者模式，按提示重启并确认。</p>
    </section>
    <details class="iphone-setup-step" open><summary>3. 首次使用：准备并签名控制组件</summary>
      <p>先下载 WebDriverAgent 安装包。已有完整签名的安装包可直接导入。</p>
      <div class="iphone-setup-actions"><button data-do="prepare">准备控制组件</button><button data-do="show" hidden>显示安装包</button><button data-do="install" data-needs-device>导入已签名 IPA</button></div>
      <p data-artifact></p>
      <div data-windows-signing><p>没有 Mac：在 Sideloadly 中选择上述安装包，由你本人登录 Apple ID 并安装一次，然后在这里补全内部测试包的签名。</p>
        <div class="iphone-setup-actions"><button data-do="signer">打开 Sideloadly 官网</button><button data-do="signing-setup">准备 Windows 签名工具</button><button data-do="sign" data-needs-device>补全签名并安装</button></div>
        <p>签名工具需要 Python 3.11+。补签会使用本机 Sideloadly 开发证书和手机上的有效描述文件；Apple 登录由你在 Sideloadly 中完成。免费签名到期后需再次签名。</p>
      </div><p data-mac-signing hidden>在 Xcode 中为你的设备签名安装 WebDriverAgent，也可导入完整签名的 IPA。</p>
    </details>
    <section class="iphone-setup-step"><h3>4. 启动 USB 连接</h3><label>控制组件 bundle ID（通常无需填写）<input data-bundle aria-label="WebDriverAgent bundle ID" placeholder="自动识别已安装的控制组件"></label>
      <div class="iphone-setup-actions"><button class="primary" data-do="connect" data-needs-device>启动并添加 iPhone</button><button data-do="cancel" data-needs-device>停止 USB 连接</button></div><p data-usb-status role="status"></p>
      <p>连接后可单独开始查看或操作会话。</p>
    </section>
    <div class="iphone-setup-feedback"><p role="alert" data-setup-error hidden></p><p data-progress role="status"></p></div>
    <details class="iphone-setup-step"><summary>高级：连接已运行的控制地址</summary>
    <form><label>设备名称<input name="name" aria-label="iPhone 名称" value="iPhone" maxlength="80" required></label>
    <label>控制地址<input name="endpoint" aria-label="iPhone 控制地址" type="url" value="http://127.0.0.1:8100" required></label>
    <p>可填写本机 USB 转发地址或同一局域网地址。添加时只检查连接。</p><p role="alert" data-error hidden></p><footer><button type="submit" class="primary">检测并添加</button></footer></form></details>`;
  let busy = false, requested: string | undefined, polling = false;
  const devices = dialog.querySelector<HTMLSelectElement>("[data-device]")!, progress = dialog.querySelector<HTMLElement>("[data-progress]")!, error = dialog.querySelector<HTMLElement>("[data-setup-error]")!;
  const bundle = () => dialog.querySelector<HTMLInputElement>("[data-bundle]")!.value.trim() || undefined;
  const update = () => dialog.querySelectorAll<HTMLButtonElement>("[data-do]").forEach(button => { button.disabled = busy || button.hasAttribute("data-needs-device") && !devices.value; });
  const showTools = (status: IphoneToolsStatus) => {
    const selected = devices.value;
    devices.innerHTML = status.devices.length ? status.devices.map(device => `<option value="${esc(device.udid)}" ${device.error ? "disabled" : ""}>${esc(device.name)}${device.version ? ` · iOS ${esc(device.version)}` : ""}${device.error ? " · 等待信任" : ""} · ${esc(device.udid.slice(-8))}</option>`).join("") : '<option value="">尚未检测到 iPhone</option>';
    if (status.devices.some(device => device.udid === selected && !device.error)) devices.value = selected;
    dialog.querySelector<HTMLElement>("[data-tools-status]")!.textContent = `${status.installed ? `USB 工具 ${status.version} 已准备` : "USB 工具尚未准备"}。${status.error || status.nextStep}`;
    dialog.querySelector<HTMLElement>("[data-windows-signing]")!.hidden = status.platform !== "win32";
    dialog.querySelector<HTMLElement>("[data-mac-signing]")!.hidden = status.platform !== "darwin";
    dialog.querySelector<HTMLElement>('[data-do="driver"]')!.hidden = status.platform !== "win32"; update();
  };
  async function poll(): Promise<void> {
    if (polling || !dialog.isConnected) return; polling = true;
    try {
      const jobs = await window.phones.iphoneUsbStatus(), job = jobs.find(item => item.udid === (requested || devices.value));
      dialog.querySelector<HTMLElement>("[data-usb-status]")!.textContent = job?.message || "";
      if (job?.phase === "ready" && job.deviceId && requested === job.udid) {
        const device = (await window.phones.snapshot()).devices.find(item => item.id === job.deviceId);
        if (device && dialog.isConnected) { requested = undefined; onAdded(device); dialog.close(); }
      }
    } catch (cause) { error.hidden = false; error.textContent = (cause as Error).message; }
    finally { polling = false; }
  }
  devices.addEventListener("change", () => { update(); void poll(); });
  dialog.querySelectorAll<HTMLButtonElement>("[data-do]").forEach(button => button.addEventListener("click", () => {
    if (busy) return; busy = true; update(); error.hidden = true;
    progress.textContent = ["setup", "prepare", "signing-setup"].includes(button.dataset.do!) ? "正在准备组件，首次下载可能需要几分钟…" : "正在处理…";
    void (async () => {
      switch (button.dataset.do) {
        case "setup": showTools(await window.phones.iphoneSetup()); break;
        case "refresh": showTools(await window.phones.iphoneDoctor()); break;
        case "driver": await window.phones.iphoneOpenGuide("driver"); break;
        case "signer": await window.phones.iphoneOpenGuide("signer"); break;
        case "prepare": { const artifact = await window.phones.iphonePrepareWda(); dialog.querySelector<HTMLElement>("[data-artifact]")!.textContent = `WebDriverAgent ${artifact.version} 安装包已准备，尚未签名。`; dialog.querySelector<HTMLElement>('[data-do="show"]')!.hidden = false; break; }
        case "show": await window.phones.iphoneShowArtifact(); break;
        case "devmode": progress.textContent = (await window.phones.iphoneRevealDeveloperMode(devices.value)).nextStep; return;
        case "install": { const ipa = await window.phones.iphoneSelectFile("ipa"); if (ipa) { progress.textContent = (await window.phones.iphoneInstallSigned(devices.value, ipa)).nextStep; return; } break; }
        case "signing-setup": await window.phones.iphoneSigningSetup(); progress.textContent = "Windows 签名工具已准备。完成 Sideloadly 首次安装后，点击「补全签名并安装」。"; return;
        case "sign": { const result = await window.phones.iphoneSignSideloadly(devices.value, bundle()); dialog.querySelector<HTMLInputElement>("[data-bundle]")!.value = result.bundleId; progress.textContent = `${result.nextStep} 签名有效期至 ${new Date(result.expiresAt).toLocaleString()}。`; return; }
        case "connect": await window.phones.iphoneUsbStart({ udid: devices.value, bundleId: bundle() }); requested = devices.value; await poll(); break;
        case "cancel": requested = undefined; await window.phones.iphoneUsbStop(devices.value); await poll(); break;
      }
      progress.textContent = "";
    })().catch(cause => { progress.textContent = ""; error.hidden = false; error.textContent = (cause as Error).message; }).finally(() => { busy = false; update(); });
  }));
  dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
  dialog.querySelector("form")!.addEventListener("submit", event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, values = new FormData(form), submit = form.querySelector("button")!;
    if (submit.disabled) return; submit.disabled = true;
    const error = form.querySelector<HTMLElement>("[data-error]")!; error.hidden = true;
    void window.phones.iphoneAdd({ name: String(values.get("name")), endpoint: String(values.get("endpoint")) }).then(device => {
      onAdded(device); dialog.close();
    }).catch(cause => { error.hidden = false; error.textContent = (cause as Error).message; }).finally(() => { submit.disabled = false; });
  });
  const timer = setInterval(() => void poll(), 2000);
  dialog.addEventListener("close", () => { clearInterval(timer); dialog.remove(); }); document.body.append(dialog); dialog.showModal(); update();
  void window.phones.iphoneDoctor().then(showTools).catch(cause => { error.hidden = false; error.textContent = (cause as Error).message; });
}

export function renderIphonePane(root: HTMLElement, device: PhoneDevice | undefined): void {
  root.hidden = device?.platform !== "ios"; if (root.hidden || !device) return;
  const state = device.state, active = !!state && !["idle", "stopped", "disconnected"].includes(state.phase);
  const markup = `<section class="phone-card"><header><h2>${esc(device.name)}</h2><span>iOS ${esc(device.iphone?.osVersion || "待确认")}</span></header>
    <p>${device.connection === "device" ? "iPhone 控制组件已连接" : "iPhone 尚未连接"}</p>
    <p>${active ? `${esc(state.controller)} · ${state.phase === "paused" ? "已暂停" : state.mode === "view" ? "正在查看" : "正在操作"}` : "开始会话后可查看画面、点击、滑动和输入文字。"}</p>
    ${device.error ? `<p role="alert">${esc(device.error)}</p>` : ""}
    <div class="phone-mode-actions">${active ? `<button data-action="iphone-pause" ${state.phase === "paused" ? "disabled" : ""}>暂停</button><button data-action="iphone-stop">结束会话</button>` : `<button data-action="iphone-view">仅查看</button><button class="primary" data-action="iphone-control">查看并操作</button><button data-action="iphone-remove">移除设备</button>`}</div>
    <details><summary>连接信息</summary><p>${esc(device.iphone?.endpoint)}</p><p>iPhone 的控制暂停和结束入口在电脑端。签名过期后需要重新签名安装控制组件。</p></details></section>`;
  if (root.dataset.markup !== markup) { root.innerHTML = markup; root.dataset.markup = markup; }
}

export function openIphoneScreen(device: PhoneDevice): void {
  if (!device.state?.sessionId) return;
  const id = device.id, sessionId = device.state.sessionId;
  let state = device.state, busy = false, closing = false, frame: { width: number; height: number; generation: number } | undefined;
  let pointer: { x: number; y: number; at: number; pointerId: number } | undefined;
  const dialog = document.createElement("dialog"); dialog.className = "phone-basic-dialog iphone-screen-dialog"; dialog.setAttribute("aria-label", "iPhone 真机画面");
  dialog.innerHTML = `<header><div><h2>${esc(device.name)}</h2><p role="status"></p></div><div class="phone-basic-toolbar"><button data-pause>暂停</button><button data-resume hidden>继续</button><button data-stop>结束并关闭</button></div></header>
    <div class="phone-basic-body"><div class="phone-basic-screen"><img alt="iPhone 当前画面" draggable="false" hidden><span data-placeholder>正在获取手机画面…</span></div>
    <p role="alert" data-error hidden></p><div class="phone-basic-toolbar"><button data-refresh>刷新画面</button><button data-home>主屏幕</button></div>
    <form data-text-form><label>向当前输入框输入文字<textarea aria-label="iPhone 输入文字" maxlength="2000"></textarea></label><button type="submit">输入</button></form></div>`;
  const screen = dialog.querySelector<HTMLImageElement>("img")!, status = dialog.querySelector<HTMLElement>('[role="status"]')!, error = dialog.querySelector<HTMLElement>("[data-error]")!;
  const active = () => !closing && ["viewing", "controlling"].includes(state.phase);
  const visible = () => dialog.isConnected && !document.hidden && window.workspacePane?.active !== false;
  const update = () => {
    status.textContent = state.phase === "paused" ? "已暂停 · 可以在手机上自行操作" : state.phase === "disconnected" ? "连接已断开，请结束后重新连接" : state.phase === "stopped" ? "会话已结束" : state.mode === "view" ? "仅查看 · 连续截图预览" : "可操作 · 点击或拖动画面";
    dialog.querySelector<HTMLButtonElement>("[data-pause]")!.disabled = !active();
    dialog.querySelector<HTMLButtonElement>("[data-resume]")!.hidden = state.phase !== "paused";
    dialog.querySelector<HTMLButtonElement>("[data-resume]")!.disabled = busy || closing;
    dialog.querySelector<HTMLButtonElement>("[data-refresh]")!.disabled = busy || !active();
    dialog.querySelector<HTMLButtonElement>("[data-home]")!.disabled = busy || !active() || state.mode !== "control";
    dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = busy || !active() || state.mode !== "control";
    screen.dataset.interactive = String(active() && state.mode === "control" && !!frame && !busy);
  };
  const failed = (cause: unknown) => { error.hidden = false; error.textContent = (cause as Error).message; };
  async function send(action: PhoneAction): Promise<void> {
    if (busy || !active() || !visible()) return;
    busy = true; const generation = state.generation; update();
    try {
      const result = await window.phones.perform({ id, sessionId, generation, requestId: crypto.randomUUID(), action });
      if (!active() || generation !== state.generation) return;
      state = result.state;
      if (action.kind === "screenshot") {
        const shot = result.result as { base64: string; mime: string; width: number; height: number };
        if (shot.mime !== "image/png" || !shot.width || !shot.height) throw new Error("iPhone 截图无效。");
        const next = new Image(); next.src = `data:image/png;base64,${shot.base64}`; await next.decode();
        if (!active() || generation !== state.generation) return;
        if (next.naturalWidth !== shot.width || next.naturalHeight !== shot.height) throw new Error("iPhone 画面尺寸无效。");
        screen.src = next.src; screen.hidden = false; dialog.querySelector<HTMLElement>("[data-placeholder]")!.hidden = true;
        frame = { width: shot.width, height: shot.height, generation };
      } else frame = undefined;
      error.hidden = true;
    } catch (cause) { frame = undefined; failed(cause); }
    finally { busy = false; update(); }
    if (action.kind !== "screenshot" && active()) void send({ kind: "screenshot" });
  }
  async function control(command: "pause" | "resume" | "stop"): Promise<void> {
    if (closing) return;
    frame = undefined; pointer = undefined;
    if (command === "stop") closing = true;
    try {
      const latest = (await window.phones.snapshot()).devices.find(item => item.id === id);
      if (latest?.state?.sessionId !== sessionId) { state = { ...state, phase: "stopped" }; if (command === "stop") dialog.close(); return; }
      const result = await window.phones.control(id, command, { sessionId, generation: latest.state.generation });
      if (result.state?.sessionId === sessionId && result.state.generation >= state.generation) state = result.state;
      if (command === "stop") dialog.close(); else if (command === "resume") void send({ kind: "screenshot" });
    } catch (cause) { closing = false; failed(cause); }
    finally { update(); }
  }
  const unsubscribe = window.phones.onChanged(snapshot => {
    const next = snapshot.devices.find(item => item.id === id)?.state;
    if (!next || next.sessionId !== sessionId) state = { ...state, phase: "stopped" };
    else if (next.generation >= state.generation) { if (next.generation !== state.generation) { frame = undefined; pointer = undefined; } state = next; }
    update();
  });
  for (const command of ["pause", "resume", "stop"] as const) dialog.querySelector(`[data-${command}]`)!.addEventListener("click", () => void control(command));
  dialog.querySelector("[data-refresh]")!.addEventListener("click", () => void send({ kind: "screenshot" }));
  dialog.querySelector("[data-home]")!.addEventListener("click", () => void send({ kind: "key", key: "home" }));
  dialog.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); const input = dialog.querySelector("textarea")!; if (input.value) void send({ kind: "text", text: input.value }); });
  const point = (event: PointerEvent) => { const rect = screen.getBoundingClientRect(); return frame ? { x: Math.max(0, Math.min(frame.width - 1, Math.floor((event.clientX - rect.left) / rect.width * frame.width))), y: Math.max(0, Math.min(frame.height - 1, Math.floor((event.clientY - rect.top) / rect.height * frame.height))) } : undefined; };
  screen.addEventListener("pointerdown", event => { if (!active() || busy || state.mode !== "control" || !frame || event.button !== 0) return; event.preventDefault(); pointer = { ...point(event)!, at: Date.now(), pointerId: event.pointerId }; screen.setPointerCapture(event.pointerId); });
  screen.addEventListener("pointerup", event => { const from = pointer; pointer = undefined; const to = point(event); if (!from || from.pointerId !== event.pointerId || !to || frame?.generation !== state.generation) return;
    void send(Math.hypot(to.x - from.x, to.y - from.y) < 12 ? { kind: "tap", x: from.x, y: from.y } : { kind: "swipe", x: from.x, y: from.y, toX: to.x, toY: to.y, duration: Math.max(50, Math.min(2000, Date.now() - from.at)) }); });
  screen.addEventListener("pointercancel", () => { pointer = undefined; });
  dialog.addEventListener("cancel", event => { event.preventDefault(); void control("stop"); });
  const timer = setInterval(() => { if (!pointer && active() && visible()) void send({ kind: "screenshot" }); }, 1800);
  dialog.addEventListener("close", () => { clearInterval(timer); unsubscribe(); dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); update(); void send({ kind: "screenshot" });
}
