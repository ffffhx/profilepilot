import type { PhoneDevice } from "../shared/phones";
import type { ScreenCameraCrop, ScreenCameraLease, ScreenCameraPreview, ScreenCameraSource, ScreenCameraState } from "../shared/screen-camera";

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
let openDialog: HTMLDialogElement | undefined;
export async function openScreenCamera(device: PhoneDevice): Promise<void> {
  if (openDialog) return;
  const dialog = document.createElement("dialog"); openDialog = dialog;
  dialog.className = "screen-camera-dialog"; dialog.setAttribute("aria-label", "屏幕摄像头");
  dialog.innerHTML = `<header><div><h2>屏幕摄像头</h2><p>让 ${esc(device.name || device.model)} 上的扫码 App 看到电脑画面</p></div><button data-close aria-label="关闭屏幕摄像头">×</button></header>
    <p data-status role="status">正在检查手机是否支持…</p>
    <div class="screen-camera-columns" hidden><section><h3>电脑画面</h3><label>选择二维码所在的窗口<select data-source aria-label="选择电脑窗口"></select></label>
      <div class="screen-camera-crop"><canvas data-crop aria-label="拖动框选二维码区域"></canvas></div><p class="screen-camera-help">在画面上拖动框选二维码，留出四周白边。</p>
      <div class="screen-camera-buttons"><button data-reset>使用整个窗口</button><button data-refresh>刷新窗口列表</button><button data-start class="primary">开启屏幕摄像头</button></div></section>
    <section><h3>手机扫码 App</h3><div data-before class="screen-camera-empty">开启后，在这里选择手机 App 并打开扫一扫。</div>
      <div data-controls hidden><div class="screen-camera-app"><select data-app aria-label="选择手机扫码 App"></select><button data-launch>打开 App</button></div>
      <div class="screen-camera-phone"><img data-phone alt="手机扫码 App 的实时画面" draggable="false"></div><div class="screen-camera-buttons"><button data-back>返回</button><button data-stop>停止屏幕摄像头</button></div></div></section></div>`;
  document.body.append(dialog); dialog.showModal();
  const find = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const status = find<HTMLElement>("[data-status]"), sourceSelect = find<HTMLSelectElement>("[data-source]"), canvas = find<HTMLCanvasElement>("[data-crop]");
  const phone = find<HTMLImageElement>("[data-phone]"), startButton = find<HTMLButtonElement>("[data-start]");
  let sources: ScreenCameraSource[] = [], crop: ScreenCameraCrop | undefined, image = new Image();
  let lease: ScreenCameraLease | undefined, owned = false, active = false, closed = false, pending = false, starting = false;
  let timer: ReturnType<typeof setInterval> | undefined, drag: { x: number; y: number } | undefined;
  const message = (error: unknown) => { status.textContent = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ""); };
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { message(error); } };
  const draw = () => {
    const ctx = canvas.getContext("2d")!; ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!image.naturalWidth) return; ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (crop) { ctx.strokeStyle = "#245df2"; ctx.lineWidth = 3; ctx.strokeRect(crop.x * canvas.width, crop.y * canvas.height, crop.width * canvas.width, crop.height * canvas.height); }
  };
  const selectSource = async () => {
    const source = sources.find(item => item.id === sourceSelect.value); crop = undefined;
    if (!source) return; const next = new Image(); next.src = source.thumbnail; await next.decode();
    if (closed || sourceSelect.value !== source.id) return;
    image = next; canvas.width = next.naturalWidth; canvas.height = next.naturalHeight; draw();
  };
  const loadSources = async () => {
    const previous = sourceSelect.value; sources = await window.phones.cameraSources(); if (closed) return;
    sourceSelect.replaceChildren(...sources.map(source => new Option(source.name, source.id)));
    if (sources.some(source => source.id === previous)) sourceSelect.value = previous;
    startButton.disabled = !sources.length; await selectSource();
    if (!sources.length) throw new Error("没有可采集的窗口，请先打开浏览器并检查屏幕录制权限");
  };
  const point = (event: PointerEvent) => { const bounds = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) }; };
  canvas.onpointerdown = event => { if (active || starting) return; drag = point(event); canvas.setPointerCapture(event.pointerId); };
  canvas.onpointermove = event => { if (!drag) return; const to = point(event); crop = { x: Math.min(drag.x, to.x), y: Math.min(drag.y, to.y), width: Math.abs(to.x - drag.x), height: Math.abs(to.y - drag.y) }; draw(); };
  canvas.onpointerup = () => { drag = undefined; if (crop && (crop.width < 0.02 || crop.height < 0.02)) crop = undefined; draw(); };
  const setActive = (value: boolean) => {
    active = value; find<HTMLElement>("[data-controls]").hidden = !value; find<HTMLElement>("[data-before]").hidden = value;
    sourceSelect.disabled = value; startButton.disabled = value || starting;
    find<HTMLButtonElement>("[data-refresh]").disabled = value; find<HTMLButtonElement>("[data-reset]").disabled = value;
  };
  const releaseOwned = async () => {
    if (!owned || !lease) return;
    const current = (await window.phones.snapshot()).devices.find(item => item.id === lease!.id)?.state;
    if (current?.sessionId === lease.sessionId && current.generation === lease.generation && ["controlling", "executing"].includes(current.phase)) await window.phones.control(lease.id, "stop");
    owned = false;
  };
  const stop = async () => {
    if (timer) clearInterval(timer); timer = undefined;
    if (lease) await window.phones.cameraCommand({ ...lease, op: "stop" }).catch(() => {});
    await releaseOwned(); setActive(false); phone.removeAttribute("src");
  };
  const refresh = async () => {
    if (!active || !lease || pending || closed) return; pending = true;
    try {
      const state: ScreenCameraState = await window.phones.cameraCommand({ ...lease, op: "status" });
      if (!state.active) { await stop(); throw new Error(state.error || "屏幕摄像头已停止"); }
      const frame: ScreenCameraPreview = await window.phones.cameraCommand({ ...lease, op: "preview" });
      if (!closed && active) phone.src = `data:${frame.mime};base64,${frame.base64}`;
      if (active) status.textContent = state.streams ? "屏幕摄像头已连接 · 正在向手机相机提供电脑画面" : "画面已就绪 · 在右侧 App 中打开扫一扫";
    } catch (error) { message(error); } finally { pending = false; }
  };
  startButton.onclick = () => void attempt(async () => {
    if (starting || active) return; starting = true; startButton.disabled = true; status.textContent = "正在开启屏幕摄像头…";
    try {
      let current = (await window.phones.snapshot()).devices.find(item => item.id === device.id);
      if (closed) return;
      if (!current || current.connection !== "device") throw new Error("手机已断开连接");
      if (current.basic && !["idle", "stopped"].includes(current.basic.phase)) throw new Error("请先结束免安装控制，再使用屏幕摄像头");
      if (current.companion !== "ready") throw new Error("请先在设备设置中连接手机 App 并完成权限设置");
      if (!current.state?.sessionId || ["idle", "stopped"].includes(current.state.phase)) { current = await window.phones.start(device.id, "control", "本机用户", "屏幕摄像头扫码"); owned = true; }
      if (current.state?.phase !== "controlling" || current.state.mode !== "control") throw new Error("请先确认手机控制会话；屏幕摄像头不会恢复已暂停的会话");
      lease = { id: device.id, sessionId: current.state.sessionId!, generation: current.state.generation };
      if (closed) { await releaseOwned(); return; }
      await window.phones.cameraStart({ ...lease, sourceId: sourceSelect.value, crop });
      if (closed) { await stop(); return; }
      const result: { apps: { name: string; component: string }[] } = await window.phones.cameraCommand({ ...lease, op: "apps" });
      if (closed) { await stop(); return; }
      const select = find<HTMLSelectElement>("[data-app]"); select.replaceChildren(...result.apps.sort((a, b) => a.name.localeCompare(b.name)).map(app => new Option(app.name, app.component)));
      const wechat = result.apps.find(app => app.component.startsWith("com.tencent.mm/")); if (wechat) select.value = wechat.component;
      setActive(true); timer = setInterval(() => void refresh(), 700); void refresh();
    } catch (error) { await stop(); throw error; }
    finally { starting = false; startButton.disabled = active; }
  });
  find<HTMLButtonElement>("[data-launch]").onclick = () => void attempt(async () => { if (lease) await window.phones.cameraCommand({ ...lease, op: "launch", component: find<HTMLSelectElement>("[data-app]").value }); });
  find<HTMLButtonElement>("[data-back]").onclick = () => void attempt(async () => { if (lease) await window.phones.cameraCommand({ ...lease, op: "key", key: "back" }); });
  find<HTMLButtonElement>("[data-stop]").onclick = () => void attempt(async () => { await stop(); status.textContent = "屏幕摄像头已停止，可重新选择画面"; });
  phone.onclick = event => void attempt(async () => {
    if (!lease || !active || !phone.naturalWidth) return; const rect = phone.getBoundingClientRect();
    await window.phones.cameraCommand({ ...lease, op: "tap", x: Math.min(719, Math.floor((event.clientX - rect.left) / rect.width * 720)), y: Math.min(1279, Math.floor((event.clientY - rect.top) / rect.height * 1280)) });
  });
  sourceSelect.onchange = () => void attempt(selectSource);
  find<HTMLButtonElement>("[data-refresh]").onclick = () => void attempt(loadSources);
  find<HTMLButtonElement>("[data-reset]").onclick = () => { crop = undefined; draw(); };
  find<HTMLButtonElement>("[data-close]").onclick = () => dialog.close();
  const onPageHide = () => { if (!closed) dialog.close(); };
  dialog.addEventListener("close", () => {
    closed = true; window.removeEventListener("pagehide", onPageHide);
    if (timer) clearInterval(timer);
    void stop().catch(message).finally(() => { dialog.remove(); openDialog = undefined; });
  });
  window.addEventListener("pagehide", onPageHide, { once: true });
  await attempt(async () => {
    const support = await window.phones.cameraProbe(device.id); if (closed) return;
    if (!support.supported) throw new Error(support.reason);
    await loadSources(); if (closed) return;
    find<HTMLElement>(".screen-camera-columns").hidden = false; status.textContent = "选择二维码所在窗口，框选区域后开启";
  });
}
