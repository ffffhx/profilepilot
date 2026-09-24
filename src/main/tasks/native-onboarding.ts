import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { InstallProgress, NativeInstallDriver } from "./native-installer";

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export class NativeOnboarding {
  private tickets = new Map<string, { code: string; profileName: string; profileId: string; url: string; expiresAt: number; delivered: boolean; progress: InstallProgress; controller?: AbortController; timer?: NodeJS.Timeout }>();
  private driver?: NativeInstallDriver;
  private changed = () => {};
  constructor(private extensionId: string) {}
  configure(driver: NativeInstallDriver, changed: () => void): void { this.driver = driver; this.changed = changed; }
  pending(profileId: string): { url: string; expiresAt: string } | undefined {
    const ticket = [...this.tickets.values()].find(t => t.profileId === profileId && t.expiresAt > Date.now() && !["connected", "cancelled"].includes(t.progress.stage));
    return ticket && { url: ticket.url, expiresAt: new Date(ticket.expiresAt).toISOString() };
  }
  states() { return [...this.tickets.values()].map(t => ({ profileId: t.profileId, ...(t.expiresAt <= Date.now() && !["connected", "cancelled"].includes(t.progress.stage) ? { stage: "failed" as const, message: "连接请求已过期，请返回 ProfilePilot 重新点击授权并连接。" } : t.progress) })); }
  create(port: number, code: string, profileName: string, expiresAt: string, profileId = ""): string {
    for (const [id, item] of this.tickets) if (item.expiresAt <= Date.now() || (profileId && item.profileId === profileId)) {
      item.controller?.abort(); clearTimeout(item.timer); this.tickets.delete(id);
    }
    if ([...this.tickets.values()].some(t => !["connected", "failed", "cancelled", "confirm-tab"].includes(t.progress.stage))) throw new Error("另一个系统 Profile 正在连接，请先完成或取消该连接。");
    const id = randomBytes(24).toString("hex");
    const url = `http://127.0.0.1:${port}/profilepilot-connect/${id}`;
    this.tickets.set(id, { code, profileName, profileId, url, expiresAt: Date.parse(expiresAt), delivered: false, progress: { stage: "preparing", message: "正在准备扩展文件并检测已有连接…" } });
    return url;
  }
  start(url: string, install = false): void {
    const ticket = [...this.tickets.values()].find(t => t.url === url);
    if (!ticket || !this.driver || ticket.delivered || ticket.progress.stage === "connected" || ticket.expiresAt <= Date.now()) return;
    if (ticket.controller && !ticket.controller.signal.aborted && !["failed", "cancelled"].includes(ticket.progress.stage)) return;
    if (!install && ticket.controller) return;
    ticket.controller?.abort(); clearTimeout(ticket.timer);
    const controller = new AbortController(); ticket.controller = controller;
    const report = (progress: InstallProgress) => { if (ticket.controller === controller && !controller.signal.aborted) { ticket.progress = progress; this.changed(); } };
    ticket.timer = setTimeout(() => {
      report({ stage: "failed", message: "连接请求已过期，请返回 ProfilePilot 重新点击授权并连接。" }); controller.abort();
    }, Math.max(0, ticket.expiresAt - Date.now())); ticket.timer.unref();
    report({ stage: "preparing", message: "正在准备扩展文件并检测已有连接…" });
    if (!install) {
      // Slow service-worker startup is not evidence that the extension is absent.
      // Never open a permission-producing CDP connection as a detection fallback.
      clearTimeout(ticket.timer);
      ticket.timer = setTimeout(() => report({ stage: "failed", message: "尚未收到扩展连接。已有扩展会继续自动重连；若尚未安装或 Chrome 重启后扩展已移除，请点击“安装或修复扩展”。此操作会请求一次 Chrome 调试许可。" }), 10000);
      ticket.timer.unref();
      return;
    }
    void this.driver.install({ url, profileId: ticket.profileId, signal: controller.signal, report }).catch(error => {
      report({ stage: "failed", message: error instanceof Error ? error.message : "安装未完成，请重试。" });
    });
  }
  connected(profileId: string): void {
    let changed = false;
    for (const t of this.tickets.values()) if (t.profileId === profileId && t.expiresAt > Date.now() && !["connected", "cancelled"].includes(t.progress.stage)) {
      t.controller?.abort(); clearTimeout(t.timer);
      t.progress = { stage: "connected", message: "连接成功，可以返回 ProfilePilot 开始任务。" };
      changed = true;
    }
    if (changed) this.changed();
  }
  close(): void { for (const t of this.tickets.values()) { t.controller?.abort(); clearTimeout(t.timer); } }
  handle(req: IncomingMessage, res: ServerResponse, port: number): void {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const match = /^\/profilepilot-connect\/([a-f0-9]{48})(\/(?:pair|status|open-debugging|retry|cancel))?$/.exec(req.url || "");
    if (req.headers.host !== `127.0.0.1:${port}` || !match) { res.writeHead(403); res.end(); return; }
    const ticket = this.tickets.get(match[1]);
    if (!ticket || ticket.expiresAt <= Date.now()) { res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" }); res.end("连接请求已过期，请返回 ProfilePilot 再次点击授权并连接。"); return; }
    const action = match[2];
    if (["/open-debugging", "/retry", "/cancel"].includes(action)) {
      if (req.method !== "POST" || req.headers.origin !== `http://127.0.0.1:${port}` || req.headers["x-profilepilot-onboarding"] !== "1" || !this.driver || ticket.delivered) { res.writeHead(403); res.end(); return; }
      void (async () => {
        if (action === "/cancel") { ticket.controller?.abort(); clearTimeout(ticket.timer); ticket.progress = { stage: "cancelled", message: "连接已取消。返回应用可重新开始。" }; }
        else if (action === "/retry") {
          if (!["failed", "cancelled"].includes(ticket.progress.stage)) throw new Error("连接正在进行，请勿重复请求。");
          this.start(ticket.url, true);
        } else await this.driver!.openSettings(ticket.profileId);
        this.changed(); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
      })().catch(error => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
      return;
    }
    if (req.method !== "GET" && !(action === "/pair" && req.method === "POST")) { res.writeHead(403); res.end(); return; }
    if (action === "/status") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(ticket.progress)); return; }
    if (action === "/pair") {
      if (req.headers.origin !== `chrome-extension://${this.extensionId}` || ticket.delivered || ticket.progress.stage === "connected") { res.writeHead(403); res.end(); return; }
      if (ticket.progress.stage === "cancelled") { res.writeHead(410); res.end(); return; }
      ticket.delivered = true;
      ticket.controller?.abort();
      ticket.progress = { stage: "confirm-tab", message: "扩展已就绪，请在 Chrome 中确认允许操作的标签页。" }; this.changed();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: ticket.code, profileName: ticket.profileName, expiresAt: ticket.expiresAt })); return;
    }
    const configured = process.env.PROFILEPILOT_EXTENSION_STORE_URL || "";
    const storeUrl = new RegExp(`^https://chromewebstore\\.google\\.com/detail/(?:[a-zA-Z0-9-]+/)?${this.extensionId}$`).test(configured) ? configured : "";
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接系统 Chrome · ProfilePilot</title><style>
      :root{color-scheme:dark}*{box-sizing:border-box}body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#1c1c1c;color:#ececec;margin:0}main{max-width:660px;margin:10vh auto;padding:32px}header{font-size:13px;color:#a7a7a7;letter-spacing:.04em}h1{font-size:28px;line-height:1.4;font-weight:600;margin:30px 0 12px}p,small{color:#aaa}ol{padding:0;list-style:none;margin:36px 0}li{display:flex;align-items:center;gap:14px;padding:16px 0;border-bottom:1px solid #333;color:#999}li b{display:grid;place-items:center;width:27px;height:27px;border:1px solid #555;border-radius:50%;font-size:12px;font-weight:500}li.active{color:#eee}li.done b{color:#8bc7b2;border-color:#49685e}#status{min-height:52px;color:#dedede}button,a{font:inherit}button{border:1px solid #484848;border-radius:9px;background:#272727;color:#eee;padding:10px 16px;cursor:pointer}button:first-child{background:#ececec;color:#181818;border-color:#ececec}button:disabled{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible{outline:2px solid #a9d8ca;outline-offset:4px}.actions{display:flex;gap:10px;flex-wrap:wrap}details{margin-top:28px;color:#999}summary{cursor:pointer}a{color:#ddd}small{display:block;margin-top:24px;font-size:12px}[hidden]{display:none!important}@media(max-width:540px){main{margin:4vh auto;padding:24px}h1{font-size:24px}}
      </style></head><body><main><header>ProfilePilot / 浏览器连接</header><h1>连接 ${escape(ticket.profileName)}</h1><p>保留当前 Chrome 的账号和登录状态。扩展由应用自动准备并安装。</p><ol><li id="step-files"><b>1</b><span>准备扩展文件</span></li><li id="step-install"><b>2</b><span>允许 Chrome 连接并自动安装</span></li><li id="step-pair"><b>3</b><span>确认连接当前 Profile</span></li></ol><p id="status" role="status" aria-live="polite">${escape(ticket.progress.message)}</p><div class="actions"><button id="settings" data-action="open-debugging">打开 Chrome 授权设置 ↗</button><button id="retry" data-action="retry" hidden>重试连接</button><button id="cancel" data-action="cancel">取消</button></div><details><summary>首次连接需要做什么？</summary><p>在 Chrome 设置中开启“允许对此浏览器进行远程调试”，再确认 Chrome 弹出的“允许”请求。之后会自动安装扩展并打开 Profile 连接确认页面；任务会自动新开标签页。</p><p>自动安装需要 Chrome 149 或更新版本。完成安装后会断开本次调试连接；后续任务通过扩展连接。</p>${storeUrl ? `<p><a href="${escape(storeUrl)}" target="_blank" rel="noreferrer">也可从 Chrome Web Store 安装 ↗</a></p>` : '<p>当前安装应用自带的本地版本，无需等待商店发布。Chrome 重启后会移除此版本，再次点击“授权并连接”即可自动补装。若浏览器策略禁止安装，可返回应用设置查看手动安装入口。</p>'}</details><small>请求在五分钟后过期。点击“取消”可停止连接，不会关闭你的 Chrome。</small></main><script nonce="${nonce}">
      const status=document.querySelector('#status');let stopped=false;
      async function poll(){try{const r=await fetch(location.pathname+'/status');if(r.status===410){status.textContent='连接请求已过期，请返回 ProfilePilot 重新连接。';stopped=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);return}if(!r.ok)throw Error();const s=await r.json();status.textContent=s.message;const failed=['failed','cancelled'].includes(s.stage);document.querySelector('#retry').hidden=!failed;document.querySelector('#settings').hidden=!['preparing','enable-debugging','failed'].includes(s.stage);document.querySelector('#cancel').hidden=['cancelled','connected','confirm-tab'].includes(s.stage);const index=s.stage==='preparing'?0:['enable-debugging','authorizing','installing','failed','cancelled'].includes(s.stage)?1:2;['files','install','pair'].forEach((name,i)=>{const el=document.querySelector('#step-'+name);el.className=i<index?'done':i===index?'active':'';el.querySelector('b').textContent=i<index?'✓':String(i+1)})}catch{status.textContent='无法连接 ProfilePilot。请确认应用仍在运行。'}finally{if(!stopped)setTimeout(poll,1000)}}
      document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await fetch(location.pathname+'/'+b.dataset.action,{method:'POST',headers:{'X-ProfilePilot-Onboarding':'1'}});if(!r.ok){const s=await r.json();throw Error(s.error||'请求未完成，请返回应用重新连接。')}}catch(e){status.textContent=e.message}finally{b.disabled=false}});poll();
      </script></body></html>`);
  }
}
