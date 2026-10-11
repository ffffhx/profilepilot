import type { PhoneDevice } from "../shared/phones";
import type { AndroidSetupAction, AndroidSetupSnapshot } from "../shared/android-setup";

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const size = (bytes: number) => bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "大小待确认";

export function openPhoneEmulator(connected: (device: PhoneDevice) => void, mode: "connect" | "create" = "connect"): void {
  if (document.querySelector(".phone-emulator-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "phone-connect-dialog phone-emulator-dialog";
  dialog.setAttribute("aria-label", "本机 Android 模拟器");
  dialog.innerHTML = `<header><div><h2>本机 Android 模拟器</h2><p>连接已有设备，或在这里安装环境并创建一台新设备。</p></div><button data-close aria-label="关闭模拟器窗口">×</button></header>
    <div class="emulator-tabs" role="tablist" aria-label="模拟器管理"><button id="emulator-existing-tab" role="tab" aria-selected="true" aria-controls="emulator-existing" data-emulator-tab="existing">已有设备</button><button id="emulator-create-tab" role="tab" aria-selected="false" aria-controls="emulator-create" data-emulator-tab="create" tabindex="-1">创建新设备</button></div>
    <section id="emulator-existing" role="tabpanel" aria-labelledby="emulator-existing-tab"><div class="emulator-section-heading"><p>已运行的模拟器会直接连接。</p><button data-emulator-refresh>刷新列表</button></div><div class="phone-connect-choices" data-emulator-list></div><p role="status" data-emulator-status>正在查找本机模拟器…</p><button data-go-create hidden>创建第一台虚拟设备</button></section>
    <section id="emulator-create" role="tabpanel" aria-labelledby="emulator-create-tab" hidden>
      <div class="emulator-setup-step"><div class="emulator-section-heading"><h3><span>1</span>安装 Android 环境</h3><button data-setup-refresh>重新检测</button></div><p data-setup-platform>正在检测环境…</p><div class="emulator-components" data-setup-components></div><p class="emulator-path" data-setup-path></p><p>自动补齐命令行工具、Java、调试工具和模拟器，无需安装 Android Studio。</p><button class="primary" data-setup-install disabled>安装所需组件</button></div>
      <div class="emulator-setup-step"><h3><span>2</span>下载系统镜像</h3><p>只显示适合这台电脑的稳定版镜像，首次下载通常需要数 GB 空间。</p><label class="emulator-field">Android 版本<select data-setup-image aria-label="Android 系统镜像"><option value="">正在获取镜像目录…</option></select></label><p data-image-status></p><button data-image-download disabled>下载所选镜像</button></div>
      <div class="emulator-setup-step"><h3><span>3</span>创建虚拟设备</h3><form data-create-form><label class="emulator-field">设备名称<input name="avdName" aria-label="虚拟设备名称" value="ProfilePilot_Phone" pattern="[A-Za-z][A-Za-z0-9_-]{0,49}" maxlength="50" required><small>英文字母开头，支持数字、下划线和短横线。</small></label><div class="emulator-config"><label class="emulator-field">内存<select name="memoryMb"><option value="2048">2 GB</option><option value="4096">4 GB</option><option value="8192">8 GB</option></select></label><label class="emulator-field">存储空间<select name="storageGb"><option value="8">8 GB</option><option value="16">16 GB</option><option value="32">32 GB</option></select></label></div><p>使用 Pixel 6 手机规格。创建完成后可启动并连接。</p><button type="submit" class="primary" data-create-device disabled>创建虚拟设备</button></form></div>
      <div class="emulator-license"><details><summary>查看 Android 组件许可协议</summary><div data-setup-licenses>获取组件目录后显示。</div></details><label><input type="checkbox" data-setup-accept>我已阅读并同意以上 Android 组件许可协议</label><p>缺少 Java 时会安装 Eclipse Temurin 21，开源许可随运行环境保留。</p></div>
      <p class="emulator-error" role="alert" data-catalog-error hidden></p>
    </section>
    <section class="emulator-job" data-setup-job hidden><strong role="status" aria-live="polite" data-job-message></strong><progress max="100" data-job-progress aria-label="安装进度"></progress><p data-job-note></p><p class="emulator-error" role="alert" data-job-error hidden></p><div class="emulator-job-actions"><button data-job-cancel>取消任务</button><button class="primary" data-created-launch hidden>启动并连接</button></div></section>
    <p class="emulator-error" role="alert" data-setup-error hidden></p>`;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  if (mode === "create") {
    dialog.setAttribute("aria-label", "添加 Android 虚拟设备");
    query("header h2").textContent = "添加 Android 虚拟设备";
    query("header p").textContent = "创建一台新设备，已有设备可在“我的设备”中启动。";
    query(".emulator-tabs").hidden = true;
    query("#emulator-create").removeAttribute("aria-labelledby");
    query("#emulator-create").setAttribute("aria-label", "创建新设备");
    query("[data-created-launch]").textContent = "启动并添加到设备列表";
  }
  query("#emulator-create").prepend(query(".emulator-license"));
  const status = query("[data-emulator-status]"), list = query("[data-emulator-list]");
  const imageSelect = query<HTMLSelectElement>("[data-setup-image]"), accepted = query<HTMLInputElement>("[data-setup-accept]");
  let state: AndroidSetupSnapshot | undefined, busy = false, polling = false, catalogLoading = false, activeTab = "existing", imageMarkup = "", licenseToken = "", finishedJob = "";
  const error = (message: string) => { const node = query("[data-setup-error]"); node.textContent = message; node.hidden = !message; };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, "");
  const switchTab = (tab: string) => {
    activeTab = tab;
    dialog.querySelectorAll<HTMLButtonElement>("[data-emulator-tab]").forEach(button => { const selected = button.dataset.emulatorTab === tab; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; });
    query("#emulator-existing").hidden = tab !== "existing"; query("#emulator-create").hidden = tab !== "create";
    if (tab === "create" && !state?.catalogLoaded && !catalogLoading) void loadCatalog();
  };
  const render = () => {
    if (!state || !dialog.isConnected) return;
    const running = state.job?.status === "running", disabled = busy || running || !state.supported;
    query("[data-setup-platform]").textContent = state.platformLabel;
    query("[data-setup-path]").textContent = `安装位置：${state.sdkRoot}`;
    query("[data-setup-components]").innerHTML = [["Java", state.javaReady], ["命令行工具", state.toolsReady], ["调试工具", state.adbReady], ["模拟器", state.emulatorReady]].map(([name, ready]) => `<span data-ready="${ready}">${name} · ${ready ? "已就绪" : "待安装"}</span>`).join("");
    const markup = state.images.map(image => `<option value="${esc(image.id)}">${esc(image.label)} · ${image.abi} · ${image.installed ? "已下载" : size(image.bytes)}</option>`).join("") || '<option value="">暂无可用镜像，请重新获取目录</option>';
    if (markup !== imageMarkup) { const previous = imageSelect.value; imageSelect.innerHTML = markup; if (state.images.some(image => image.id === previous)) imageSelect.value = previous; imageMarkup = markup; }
    if (licenseToken !== state.licenseToken) {
      query("[data-setup-licenses]").innerHTML = state.licenses.map(l => `<h4>${esc(l.id)}</h4><pre>${esc(l.text)}</pre>`).join("");
      licenseToken = state.licenseToken; accepted.checked = false;
    }
    const image = state.images.find(image => image.id === imageSelect.value);
    const install = query<HTMLButtonElement>("[data-setup-install]"); install.disabled = !!disabled || state.ready || !state.catalogLoaded || !accepted.checked;
    install.textContent = state.ready ? "环境已就绪" : "安装所需组件";
    const download = query<HTMLButtonElement>("[data-image-download]"); download.disabled = !!disabled || !state.ready || !image || image.installed || !accepted.checked;
    download.textContent = image?.installed ? "镜像已下载" : "下载所选镜像";
    query("[data-image-status]").textContent = image ? image.installed ? "此镜像已安装，可直接创建设备。" : `预计下载 ${size(image.bytes)}，解压后需要更多空间。` : "";
    imageSelect.disabled = !!disabled;
    query<HTMLButtonElement>("[data-create-device]").disabled = !!disabled || !state.ready || !image?.installed;
    query<HTMLButtonElement>("[data-setup-refresh]").disabled = !!disabled || catalogLoading;
    query<HTMLButtonElement>("[data-emulator-refresh]").disabled = busy || !!running;
    query("[data-catalog-error]").textContent = state.catalogError; query("[data-catalog-error]").hidden = !state.catalogError;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy || !!running;
    const job = state.job; query("[data-setup-job]").hidden = !job;
    if (job) {
      query("[data-job-message]").textContent = job.message;
      const progress = query<HTMLProgressElement>("[data-job-progress]"); progress.hidden = !running; if (job.progress === null) progress.removeAttribute("value"); else progress.value = job.progress;
      query("[data-job-error]").textContent = job.error; query("[data-job-error]").hidden = !job.error;
      query("[data-job-note]").textContent = running ? "关闭此窗口后任务会继续；退出应用会中止任务。" : "";
      query("[data-job-cancel]").hidden = !running;
      const launch = query<HTMLButtonElement>("[data-created-launch]"); launch.hidden = job.kind !== "create" || job.status !== "succeeded"; launch.disabled = busy;
      if (!running && job.id !== finishedJob) { finishedJob = job.id; if (mode === "connect") void loadExisting(false); }
    }
  };
  const launch = async (name: string) => {
    if (busy || state?.job?.status === "running") return;
    busy = true; error(""); render(); status.textContent = `正在启动并连接 ${name}…`;
    list.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
    try { const device = await window.phones.connectEmulator(name); if (dialog.isConnected) { connected(device); dialog.close(); } }
    catch (e) { if (dialog.isConnected) { status.textContent = "连接未完成，可重试。"; error(message(e)); } }
    finally { busy = false; render(); }
  };
  const loadExisting = async (initial: boolean) => {
    try {
      const names = await window.phones.listEmulators(); if (!dialog.isConnected) return;
      list.replaceChildren();
      for (const name of names) { const button = document.createElement("button"); button.dataset.emulatorName = name; const strong = document.createElement("strong"); strong.textContent = name; const small = document.createElement("small"); small.textContent = "启动 / 连接"; const text = document.createElement("span"); text.append(strong, small); button.append(text); button.disabled = busy || state?.job?.status === "running"; button.addEventListener("click", () => void launch(name)); list.append(button); }
      status.textContent = names.length ? "选择设备后会自动检测连接，首次启动可能需要一点时间。" : "还没有虚拟设备，可以在这里创建。";
      query("[data-go-create]").hidden = !!names.length;
      if (initial && !names.length) switchTab("create");
    } catch (e) { if (dialog.isConnected) { status.textContent = message(e); query("[data-go-create]").hidden = false; if (initial) switchTab("create"); } }
  };
  const loadCatalog = async () => {
    if (catalogLoading) return; catalogLoading = true; error(""); render();
    try { state = await window.phones.androidSetupCatalog(); }
    catch (e) { if (dialog.isConnected) error(message(e)); }
    finally { catalogLoading = false; render(); }
  };
  const start = async (action: AndroidSetupAction) => {
    if (busy) return; busy = true; error(""); render();
    try { state = await window.phones.androidSetupStart(action); }
    catch (e) { if (dialog.isConnected) error(message(e)); }
    finally { busy = false; render(); }
  };
  const poll = async () => {
    if (polling || !dialog.isConnected || busy || catalogLoading) return; polling = true;
    try { state = await window.phones.androidSetupSnapshot(); render(); } catch (e) { if (dialog.isConnected) error(message(e)); } finally { polling = false; }
  };
  dialog.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button"); if (!button || button.disabled) return;
    if (button.hasAttribute("data-close")) dialog.close();
    if (button.dataset.emulatorTab) switchTab(button.dataset.emulatorTab);
    if (button.hasAttribute("data-go-create")) switchTab("create");
    if (button.hasAttribute("data-emulator-refresh")) void loadExisting(false);
    if (button.hasAttribute("data-setup-refresh")) void loadCatalog();
    if (button.hasAttribute("data-setup-install") && state) void start({ kind: "environment", licenseToken: accepted.checked ? state.licenseToken : "" });
    if (button.hasAttribute("data-image-download") && state) void start({ kind: "image", imageId: imageSelect.value, licenseToken: accepted.checked ? state.licenseToken : "" });
    if (button.hasAttribute("data-job-cancel") && state?.job) { button.disabled = true; void window.phones.androidSetupCancel(state.job.id).then(value => { state = value; render(); }).catch(e => error(message(e))).finally(() => button.disabled = false); }
    if (button.hasAttribute("data-created-launch") && state?.job?.deviceName) void launch(state.job.deviceName);
  });
  query(".emulator-tabs").addEventListener("keydown", event => { const key = (event as KeyboardEvent).key; if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return; event.preventDefault(); switchTab(key === "Home" ? "existing" : key === "End" ? "create" : activeTab === "existing" ? "create" : "existing"); query<HTMLButtonElement>(`[data-emulator-tab="${activeTab}"]`).focus(); });
  accepted.addEventListener("change", render); imageSelect.addEventListener("change", render);
  query("[data-create-form]").addEventListener("submit", event => { event.preventDefault(); if (query<HTMLButtonElement>("[data-create-device]").disabled) return; void start({ kind: "create", name: query<HTMLInputElement>('[name="avdName"]').value.trim(), imageId: imageSelect.value, memoryMb: Number(query<HTMLSelectElement>('[name="memoryMb"]').value), storageGb: Number(query<HTMLSelectElement>('[name="storageGb"]').value) }); });
  const timer = window.setInterval(() => void poll(), 1000);
  dialog.addEventListener("close", () => { clearInterval(timer); dialog.remove(); });
  document.body.append(dialog); dialog.showModal();
  if (mode === "create") switchTab("create"); else void loadExisting(true);
  void poll();
}
