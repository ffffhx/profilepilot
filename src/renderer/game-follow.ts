import type { PhoneDevice } from "../shared/phones";
import type { FollowAnalysis, FollowFrame, FollowPoint, FollowRect, FollowRuntime, FollowStatus, GameFollowConfig } from "../shared/game-follow";

let opened: HTMLDialogElement | undefined;
const baseConfig = (): GameFollowConfig => ({
  version: 1, name: "队友跟随", width: 1280, height: 720,
  map: { x: .02, y: .02, width: .25, height: .42 }, selfTemplate: "", targetTemplate: "", selfRotates: true,
  grid: { columns: 48, rows: 48, blocked: [], clearance: 1 },
  joystick: { x: .16, y: .78, radius: .07, rotation: 0 },
  confidence: .90, stopDistance: .08, intervalMs: 400
});
export async function openGameFollower(device?: PhoneDevice) {
  if (opened) return;
  const dialog = document.createElement("dialog"); opened = dialog;
  dialog.className = "game-follow-dialog"; dialog.setAttribute("aria-label", "视觉跟随");
  dialog.innerHTML = `<header class="gf-header"><div><span class="gf-eyebrow">本地视觉 · 无需大模型</span><h2>队友跟随</h2><p>识别小地图中的位置，沿可行路线跟随指定队友。</p></div><button data-gf-close aria-label="关闭视觉跟随">×</button></header>
    <div class="gf-layout"><section class="gf-main"><div class="gf-source-bar">
      <button data-gf-capture>获取手机画面</button><label class="gf-file">导入截图<input data-gf-file type="file" accept="image/png,image/jpeg" multiple></label>
      <button data-gf-demo>演示地图</button><span data-gf-source>先获取画面或导入截图</span></div>
      <div class="gf-canvas-wrap"><canvas data-gf-canvas width="1280" height="720" aria-label="游戏画面和校准选区"></canvas><p data-gf-empty>连接手机后获取横屏游戏画面，或先用演示地图体验识别与寻路。</p></div>
      <div class="gf-legend"><span><i class="gf-self"></i>自己</span><span><i class="gf-target"></i>队友</span><span><i class="gf-wall"></i>障碍区域</span><span><i class="gf-path"></i>规划路线</span></div>
      <div class="gf-feedback" role="status" aria-live="polite"><strong data-gf-status>准备校准</strong><span data-gf-metrics>所有图像均在本机处理</span></div>
      <div class="gf-bottom"><button data-gf-analyze>分析当前画面</button><button data-gf-replay>开始演示</button>
        <button data-gf-observe>仅观察手机</button><button class="primary" data-gf-start>开始跟随</button><button class="gf-stop" data-gf-stop disabled>停止</button></div>
    </section><aside class="gf-sidebar">
      <section><h3>1 · 选取目标</h3><p>框选小地图，再框选其中的自己和队友图标。头像尽量紧贴边缘。</p>
        <div class="gf-tools"><button data-gf-tool="map">小地图</button><button data-gf-tool="self">自己图标</button><button data-gf-tool="target">队友图标</button><button data-gf-tool="joystick">摇杆中心</button></div>
        <div class="gf-templates"><div><img data-gf-self alt="自己的图标"><span>自己</span></div><div><img data-gf-target alt="队友图标"><span>跟随对象</span></div></div>
        <label class="gf-check"><input data-gf-rotates type="checkbox" checked>自己图标会随朝向旋转</label>
      </section><section><h3>2 · 标记障碍</h3><p>在小地图上涂出墙壁和不可行走区域，路线会绕开标记。</p>
        <div class="gf-tools"><button data-gf-tool="wall">画障碍</button><button data-gf-tool="erase">擦除</button><button data-gf-clear>清空障碍</button></div>
        <label>绕墙留白 <select data-gf-clearance><option value="0">不扩展</option><option value="1" selected>1 格</option><option value="2">2 格</option></select></label>
      </section><section><h3>3 · 跟随设置</h3>
        <label>控制方式<select data-gf-backend><option value="app">手机 App · 连续移动</option><option value="basic">免安装 · 分段移动</option></select></label>
        <p>旧版安卓模拟器可选择免安装模式，每次移动最多 350 毫秒，速度受截图延迟影响。</p>
        <label>方案名称<input data-gf-name maxlength="80" value="队友跟随"></label>
        <label>识别阈值<input data-gf-confidence type="number" min=".65" max=".999" step=".01" value=".90"></label>
        <label>跟随距离（地图宽度 %）<input data-gf-distance type="number" min="2" max="30" value="8"></label>
        <label>摇杆半径（屏幕短边 %）<input data-gf-radius type="number" min="1" max="20" value="7"></label>
        <label>地图至摇杆方向角度<select data-gf-rotation><option value="0">0°</option><option value="-45">−45°</option><option value="45">45°</option><option value="90">90°</option><option value="-90">−90°</option><option value="180">180°</option></select></label>
        <button data-gf-save>保存校准</button><span data-gf-saved></span>
      </section><section class="gf-runtime"><span data-gf-runtime>正在检查视觉组件…</span><button data-gf-setup hidden>安装视觉组件</button></section>
    </aside></div>`;
  document.body.append(dialog); dialog.showModal();
  const find = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const canvas = find<HTMLCanvasElement>("[data-gf-canvas]"), ctx = canvas.getContext("2d")!;
  const canvasWrap = find<HTMLElement>(".gf-canvas-wrap");
  const fitCanvas = () => {
    const scale = Math.min(canvasWrap.clientWidth / canvas.width, canvasWrap.clientHeight / canvas.height);
    canvas.style.width = `${canvas.width * scale}px`; canvas.style.height = `${canvas.height * scale}px`;
  };
  const resize = new ResizeObserver(fitCanvas); resize.observe(canvasWrap);
  const status = find<HTMLElement>("[data-gf-status]"), metrics = find<HTMLElement>("[data-gf-metrics]");
  let config = baseConfig(), frame: FollowFrame | undefined, image: HTMLImageElement | undefined;
  let analysis: FollowAnalysis | undefined, tool = "map", drag: FollowPoint | undefined, selection: FollowRect | undefined;
  let closed = false, busy = false, running = false, replaying = false, runId: string | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined, replayTimer: ReturnType<typeof setTimeout> | undefined;
  let frames: FollowFrame[] = [], replayIndex = 0;
  let demo: { own: FollowPoint; target: FollowPoint; tick: number; ownIcon: HTMLCanvasElement; targetIcon: HTMLCanvasElement } | undefined;
  const source = find<HTMLElement>("[data-gf-source]");
  const error = (cause: unknown) => { status.textContent = String((cause as Error)?.message || cause).replace(/^Error invoking remote method '[^']+': Error: /, ""); };
  const attempt = async (work: () => Promise<void>) => {
    if (busy || closed) return; busy = true; buttons();
    try { await work(); } catch (cause) { error(cause); } finally { busy = false; buttons(); }
  };
  const ready = () => !!frame && !!config.selfTemplate && !!config.targetTemplate;
  function buttons() {
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("button")) {
      if (button.hasAttribute("data-gf-close") || button.hasAttribute("data-gf-stop")) continue;
      button.disabled = busy || running || replaying;
    }
    find<HTMLButtonElement>("[data-gf-stop]").disabled = !running && !replaying;
    for (const key of ["start", "observe"]) find<HTMLButtonElement>(`[data-gf-${key}]`).disabled ||= !ready() || !device || device.connection !== "device";
    find<HTMLButtonElement>("[data-gf-analyze]").disabled ||= !ready();
    find<HTMLButtonElement>("[data-gf-replay]").disabled ||= !ready() || (!demo && frames.length < 2);
    find<HTMLButtonElement>("[data-gf-capture]").disabled ||= !device || device.connection !== "device";
    for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")) input.disabled = busy || running || replaying;
  }
  function readSettings() {
    config.name = find<HTMLInputElement>("[data-gf-name]").value.trim();
    config.confidence = Number(find<HTMLInputElement>("[data-gf-confidence]").value);
    config.stopDistance = Number(find<HTMLInputElement>("[data-gf-distance]").value) / 100;
    config.joystick.radius = Number(find<HTMLInputElement>("[data-gf-radius]").value) / 100;
    config.joystick.rotation = Number(find<HTMLSelectElement>("[data-gf-rotation]").value);
    config.selfRotates = find<HTMLInputElement>("[data-gf-rotates]").checked;
    config.grid.clearance = Number(find<HTMLSelectElement>("[data-gf-clearance]").value);
  }
  function settings() {
    find<HTMLInputElement>("[data-gf-name]").value = config.name;
    find<HTMLInputElement>("[data-gf-confidence]").value = String(config.confidence);
    find<HTMLInputElement>("[data-gf-distance]").value = String(config.stopDistance * 100);
    find<HTMLInputElement>("[data-gf-radius]").value = String(config.joystick.radius * 100);
    find<HTMLSelectElement>("[data-gf-rotation]").value = String(config.joystick.rotation);
    find<HTMLInputElement>("[data-gf-rotates]").checked = config.selfRotates;
    find<HTMLSelectElement>("[data-gf-clearance]").value = String(config.grid.clearance);
    for (const [key, value] of [["self", config.selfTemplate], ["target", config.targetTemplate]]) {
      const img = find<HTMLImageElement>(`[data-gf-${key}]`);
      if (value) img.src = `data:image/png;base64,${value}`; else img.removeAttribute("src");
    }
  }
  const mapPoint = (p: FollowPoint) => ({ x: (config.map.x + p.x * config.map.width) * canvas.width,
    y: (config.map.y + p.y * config.map.height) * canvas.height });
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height); if (!image) return;
    ctx.drawImage(image, 0, 0);
    const r = config.map, mx = r.x * canvas.width, my = r.y * canvas.height, mw = r.width * canvas.width, mh = r.height * canvas.height;
    ctx.lineWidth = Math.max(2, canvas.width / 500); ctx.strokeStyle = "#60a5fa"; ctx.strokeRect(mx, my, mw, mh);
    ctx.fillStyle = "#ef444470";
    for (const cell of config.grid.blocked) ctx.fillRect(mx + cell % config.grid.columns * mw / config.grid.columns,
      my + Math.floor(cell / config.grid.columns) * mh / config.grid.rows, mw / config.grid.columns, mh / config.grid.rows);
    if (analysis) {
      ctx.strokeStyle = "#fbbf24"; ctx.beginPath();
      analysis.path.forEach((p, i) => { const q = mapPoint(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke();
      for (const [detection, color] of [[analysis.self, "#34d399"], [analysis.target, "#a78bfa"]] as const) if (detection) {
        const q = mapPoint(detection); ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(q.x, q.y, 13, 0, 2 * Math.PI); ctx.stroke();
      }
    }
    const j = config.joystick; ctx.strokeStyle = "#ffffffa0"; ctx.beginPath();
    ctx.arc(j.x * canvas.width, j.y * canvas.height, j.radius * Math.min(canvas.width, canvas.height), 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(j.x * canvas.width, j.y * canvas.height, 4, 0, Math.PI * 2); ctx.stroke();
    if (selection) { ctx.strokeStyle = "#fff"; ctx.setLineDash([5, 4]); ctx.strokeRect(selection.x * canvas.width, selection.y * canvas.height, selection.width * canvas.width, selection.height * canvas.height); ctx.setLineDash([]); }
  }
  async function display(next: FollowFrame, reset = false) {
    const loaded = new Image();
    // decode() can wait for a rendering opportunity in an occluded Electron window.
    // Loading the data image also works while the user is looking at another app.
    await new Promise<void>((resolve, reject) => {
      loaded.onload = () => resolve(); loaded.onerror = () => reject(new Error("无法读取截图"));
      loaded.src = `data:${next.mime};base64,${next.base64}`;
    });
    if (closed) return;
    if (reset && (loaded.naturalWidth !== config.width || loaded.naturalHeight !== config.height)) {
      config = baseConfig(); config.width = loaded.naturalWidth; config.height = loaded.naturalHeight; settings();
      status.textContent = "新画面尺寸已载入，请重新选取小地图和目标";
    }
    image = loaded; frame = { ...next, width: loaded.naturalWidth, height: loaded.naturalHeight };
    if (frame.base64.length > 4_000_000) {
      const compact = document.createElement("canvas"); compact.width = frame.width; compact.height = frame.height;
      compact.getContext("2d")!.drawImage(loaded, 0, 0);
      frame = { ...frame, mime: "image/jpeg", base64: compact.toDataURL("image/jpeg", .9).split(",")[1] };
    }
    canvas.width = loaded.naturalWidth; canvas.height = loaded.naturalHeight; fitCanvas();
    find<HTMLElement>("[data-gf-empty]").hidden = true; draw(); buttons();
  }
  function crop(r: FollowRect): string {
    const small = document.createElement("canvas");
    small.width = Math.round(r.width * canvas.width); small.height = Math.round(r.height * canvas.height);
    small.getContext("2d")!.drawImage(image!, r.x * canvas.width, r.y * canvas.height, small.width, small.height, 0, 0, small.width, small.height);
    return small.toDataURL("image/png").split(",")[1];
  }
  const point = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  function paint(p: FollowPoint) {
    const r = config.map, x = Math.floor((p.x - r.x) / r.width * config.grid.columns), y = Math.floor((p.y - r.y) / r.height * config.grid.rows);
    if (x < 0 || y < 0 || x >= config.grid.columns || y >= config.grid.rows) return;
    const cells = new Set(config.grid.blocked);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx < 0 || y + dy < 0 || x + dx >= config.grid.columns || y + dy >= config.grid.rows) continue;
      const cell = (y + dy) * config.grid.columns + x + dx;
      tool === "wall" ? cells.add(cell) : cells.delete(cell);
    }
    config.grid.blocked = [...cells]; analysis = undefined; draw();
  }
  canvas.onpointerdown = event => {
    if (busy || running || replaying || !image || event.button !== 0) return;
    drag = point(event); canvas.setPointerCapture(event.pointerId);
    if (tool === "joystick") { config.joystick = { ...config.joystick, ...drag }; drag = undefined; draw(); }
    else if (tool === "wall" || tool === "erase") paint(drag);
  };
  canvas.onpointermove = event => {
    if (!drag) return; const to = point(event);
    if (tool === "wall" || tool === "erase") { paint(to); return; }
    selection = { x: Math.min(drag.x, to.x), y: Math.min(drag.y, to.y), width: Math.abs(to.x - drag.x), height: Math.abs(to.y - drag.y) }; draw();
  };
  canvas.onpointerup = () => {
    drag = undefined; const selected = selection; selection = undefined;
    if (!selected || selected.width * canvas.width < 6 || selected.height * canvas.height < 6) { draw(); return; }
    if (tool === "map") {
      config.map = selected; config.selfTemplate = ""; config.targetTemplate = ""; config.grid.blocked = [];
      status.textContent = "小地图已选取，接着框选自己和队友图标";
    } else if (tool === "self" || tool === "target") {
      const r = config.map;
      if (selected.x < r.x || selected.y < r.y || selected.x + selected.width > r.x + r.width || selected.y + selected.height > r.y + r.height) {
        status.textContent = "请在已选的小地图内框选图标"; draw(); return;
      }
      if (tool === "self") config.selfTemplate = crop(selected); else config.targetTemplate = crop(selected);
      status.textContent = tool === "self" ? "自己图标已选取" : "跟随对象已选取";
    }
    analysis = undefined; settings(); draw(); buttons();
  };
  canvas.onpointercancel = () => { drag = undefined; selection = undefined; draw(); };
  dialog.querySelectorAll<HTMLButtonElement>("[data-gf-tool]").forEach(button => {
    button.onclick = () => {
      tool = button.dataset.gfTool!; selection = undefined;
      dialog.querySelectorAll("[data-gf-tool]").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
      status.textContent = tool === "joystick" ? "点击游戏中摇杆的固定中心" : tool === "wall" || tool === "erase" ? "在小地图上拖动涂抹" : "在画面上拖动框选";
    };
  });
  find<HTMLButtonElement>("[data-gf-clear]").onclick = () => { config.grid.blocked = []; analysis = undefined; draw(); };
  find<HTMLButtonElement>("[data-gf-capture]").onclick = () => void attempt(async () => {
    if (!device) return;
    const captured = await window.phones.screen(device.id);
    demo = undefined; frames = []; analysis = undefined;
    await display(captured, true); source.textContent = device.name;
  });
  find<HTMLInputElement>("[data-gf-file]").onchange = event => void attempt(async () => {
    const files = [...((event.target as HTMLInputElement).files || [])].slice(0, 200);
    frames = []; demo = undefined;
    for (const file of files) {
      if (file.size > 3_000_000) throw new Error("单张截图请小于 3 MB");
      const encoded = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      frames.push({ mime: file.type, base64: encoded.split(",")[1], width: 0, height: 0 });
    }
    if (frames[0]) await display(frames[0], true);
    source.textContent = files.length > 1 ? `${files.length} 张截图 · 按选择顺序回放` : files[0]?.name || "";
    find<HTMLButtonElement>("[data-gf-replay]").textContent = "回放截图";
  });
  const report = (result: FollowAnalysis) => {
    analysis = result; status.textContent = result.message;
    metrics.textContent = `识别 ${result.elapsedMs} ms · 自己 ${result.self ? (result.self.confidence * 100).toFixed(1) + "%" : "未找到"} · 队友 ${result.target ? (result.target.confidence * 100).toFixed(1) + "%" : "未找到"}`;
    draw();
  };
  async function analyze() {
    if (!frame) throw new Error("请先载入画面");
    readSettings();
    report(await window.phones.followCommand({ op: "analyze", config, frame }));
  }
  find<HTMLButtonElement>("[data-gf-analyze]").onclick = () => void attempt(analyze);
  find<HTMLButtonElement>("[data-gf-save]").onclick = () => void attempt(async () => {
    readSettings(); await window.phones.followCommand({ op: "save", config }); find<HTMLElement>("[data-gf-saved]").textContent = "已保存";
  });
  async function refresh() {
    if (!running || closed) return;
    try {
      const state: FollowStatus = await window.phones.followCommand({ op: "status" });
      if (state.runId !== runId) throw new Error("跟随任务已改变");
      if (state.frame) await display(state.frame);
      if (state.analysis) report(state.analysis);
      metrics.textContent += ` · ${state.fps} 帧/秒 · ${state.actions} 次移动`;
      running = state.running;
      if (state.error) status.textContent = state.error;
      else if (!running) status.textContent = "跟随已停止";
    } catch (cause) { error(cause); }
    finally { buttons(); if (running && !closed) poll = setTimeout(() => void refresh(), 400); }
  }
  async function start(mode: "observe" | "control") {
    if (!device) throw new Error("请先连接手机");
    readSettings(); demo = undefined;
    const backend = find<HTMLSelectElement>("[data-gf-backend]").value as "app" | "basic";
    const state: FollowStatus = await window.phones.followCommand({ op: "start", id: device.id, mode, backend, config });
    runId = state.runId; running = state.running;
    if (closed) { if (runId) await window.phones.followCommand({ op: "stop", runId }); return; }
    status.textContent = mode === "observe" ? "正在识别手机画面，不发送移动操作" : "正在开始跟随";
    void refresh();
  }
  find<HTMLButtonElement>("[data-gf-start]").onclick = () => void attempt(() => start("control"));
  find<HTMLButtonElement>("[data-gf-observe]").onclick = () => void attempt(() => start("observe"));
  async function stop() {
    replaying = false; clearTimeout(replayTimer); clearTimeout(poll);
    if (runId && running) await window.phones.followCommand({ op: "stop", runId });
    running = false; buttons();
  }
  find<HTMLButtonElement>("[data-gf-stop]").onclick = () => { void stop().then(() => { status.textContent = "已停止"; }).catch(error); };
  function icon(seed: number) {
    const c = document.createElement("canvas"); c.width = c.height = 22; const g = c.getContext("2d")!;
    g.fillStyle = seed ? "#8b5cf6" : "#10b981"; g.fillRect(0, 0, 22, 22);
    g.fillStyle = "#fff"; g.beginPath(); g.moveTo(11, 3); g.lineTo(seed ? 18 : 4, 18); g.lineTo(seed ? 4 : 18, seed ? 11 : 18); g.closePath(); g.fill();
    g.fillStyle = "#172033"; g.fillRect(seed ? 3 : 14, 4, 4, 4); return c;
  }
  async function demoFrame() {
    if (!demo) return;
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720; const g = c.getContext("2d")!;
    g.fillStyle = "#0d1929"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#152d38"; g.fillRect(40, 40, 520, 520);
    g.strokeStyle = "#ffffff09";
    for (let n = 0; n <= 48; n++) { g.beginPath(); g.moveTo(40 + n * 520 / 48, 40); g.lineTo(40 + n * 520 / 48, 560); g.stroke(); g.beginPath(); g.moveTo(40, 40 + n * 520 / 48); g.lineTo(560, 40 + n * 520 / 48); g.stroke(); }
    g.fillStyle = "#426073";
    for (const cell of config.grid.blocked) g.fillRect(40 + cell % 48 * 520 / 48, 40 + Math.floor(cell / 48) * 520 / 48, 520 / 48, 520 / 48);
    for (const [p, i] of [[demo.own, demo.ownIcon], [demo.target, demo.targetIcon]] as const) g.drawImage(i, Math.round(40 + p.x * 520 - 11), Math.round(40 + p.y * 520 - 11));
    g.fillStyle = "#d7e8f5"; g.font = "bold 34px sans-serif"; g.fillText("视觉跟随 · 演示地图", 630, 180);
    g.fillStyle = "#9db3c6"; g.font = "21px sans-serif";
    ["真实 OpenCV 识别 · A* 寻路", "绿色：自己    紫色：队友", "可涂抹障碍，观察路线变化", "此演示不会连接或操作手机"].forEach((s, i) => g.fillText(s, 630, 245 + i * 44));
    await display({ mime: "image/png", base64: c.toDataURL("image/png").split(",")[1], width: 1280, height: 720 });
  }
  find<HTMLButtonElement>("[data-gf-demo]").onclick = () => void attempt(async () => {
    config = baseConfig(); config.name = "演示地图"; config.map = { x: 40 / 1280, y: 40 / 720, width: 520 / 1280, height: 520 / 720 }; config.selfRotates = false;
    for (let y = 8; y < 39; y++) for (let x = 22; x < 25; x++) config.grid.blocked.push(y * 48 + x);
    demo = { own: { x: .2, y: .5 }, target: { x: .8, y: .5 }, tick: 0, ownIcon: icon(0), targetIcon: icon(1) };
    config.selfTemplate = demo.ownIcon.toDataURL("image/png").split(",")[1]; config.targetTemplate = demo.targetIcon.toDataURL("image/png").split(",")[1];
    settings(); analysis = undefined; frames = []; await demoFrame(); source.textContent = "演示地图 · 不操作手机";
    find<HTMLButtonElement>("[data-gf-replay]").textContent = "开始演示"; status.textContent = "点击开始演示，观察自己绕过墙壁跟随队友";
  });
  async function replay() {
    if (!replaying || closed) return;
    try {
      if (demo) {
        if (analysis?.direction) { demo.own.x += analysis.direction.x * .012; demo.own.y += analysis.direction.y * .012; }
        demo.tick++; demo.target.y = .5 + Math.sin(demo.tick / 40) * .13; await demoFrame();
      } else {
        if (replayIndex >= frames.length) { await stop(); status.textContent = "截图回放结束"; return; }
        await display(frames[replayIndex++]);
      }
      if (replaying && !closed) await analyze();
    } catch (cause) { replaying = false; error(cause); buttons(); }
    if (replaying && !closed) replayTimer = setTimeout(() => void replay(), 180);
  }
  find<HTMLButtonElement>("[data-gf-replay]").onclick = () => {
    if (!ready()) return; readSettings(); replaying = true; replayIndex = 0; buttons(); void replay();
  };
  async function runtime() {
    const state: FollowRuntime = await window.phones.followCommand({ op: "runtime" });
    if (closed) return;
    find<HTMLElement>("[data-gf-runtime]").textContent = state.available ? `本地视觉已就绪 · OpenCV ${state.version}` : state.error;
    find<HTMLButtonElement>("[data-gf-setup]").hidden = state.available;
  }
  find<HTMLButtonElement>("[data-gf-setup]").onclick = () => void attempt(async () => {
    find<HTMLElement>("[data-gf-runtime]").textContent = "正在安装到独立的视觉环境…";
    await window.phones.followCommand({ op: "setup" }); await runtime();
  });
  find<HTMLButtonElement>("[data-gf-close]").onclick = () => dialog.close();
  const pagehide = () => dialog.close();
  window.addEventListener("pagehide", pagehide);
  dialog.addEventListener("close", () => {
    closed = true; resize.disconnect(); window.removeEventListener("pagehide", pagehide);
    void stop().catch(() => {}).finally(() => { dialog.remove(); opened = undefined; });
  });
  buttons();
  await attempt(async () => {
    const saved = await window.phones.followCommand({ op: "load" });
    if (saved && !closed) { config = saved; settings(); status.textContent = "已载入校准方案，请获取对应尺寸的游戏画面"; }
    await runtime();
  });
}
