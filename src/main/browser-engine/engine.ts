import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator, type Dialog } from "playwright-core";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EngineError, type EngineCommand, required, option, has, positiveNumber, splitCommand, parseEngineCommand } from "./arguments";
import { EngineReferences } from "./snapshot";
import { EngineTransport } from "./transport";
import { parseCommonBrowserAction } from "../../shared/browser-contract";
import { BrowserDebugSession } from '../browser-debug/session';
import { parseDebugArgs } from '../browser-debug/arguments';

export class BrowserEngine {
  connectionStage = "disconnected";
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private frame?: Frame;
  private endpoint?: string;
  private tabSequence = 0;
  private tabs = new Map<Page, { id: string; targetId?: string; label?: string }>();
  private selectedTargetId?: string;
  private references = new EngineReferences();
  private dialogs = new Map<Page, Dialog>();
  private noAutoDialog = false;
  private timeout = 15000;
  private transport?: EngineTransport;
  private artifactsDir?: string;
  private debug?: BrowserDebugSession;
  private debugSessionId?: string;
  private debugTarget?: string;
  private debugAllowed = true;
  invalidateReferences(): void { this.references.clear(); this.debugAllowed=false;this.debug?.suspend('control-changed'); }

  async disconnect(): Promise<void> {
    this.connectionStage = "disconnected";
    this.debug?.suspend('disconnected');this.debug=undefined;this.debugSessionId=undefined;this.debugTarget=undefined;this.debugAllowed=false;
    const browser = this.browser;
    this.browser = undefined; this.context = undefined; this.page = undefined; this.frame = undefined;
    this.references.clear(); this.tabs.clear(); this.dialogs.clear();
    // connectOverCDP close disconnects this client; it does not close the user's Chrome.
    this.transport?.close(); this.transport = undefined;
    await browser?.close();
    const artifacts = this.artifactsDir; this.artifactsDir = undefined;
    if (artifacts && path.dirname(artifacts) === path.resolve(os.tmpdir()) && path.basename(artifacts).startsWith("profilepilot-browser-")) await rm(artifacts, { recursive: true, force: true }).catch(() => {});
  }
  async connect(endpoint: string): Promise<unknown> {
    if (this.browser?.isConnected() && this.endpoint === endpoint) return { connected: true };
    await this.disconnect();
    if (/^\d+$/.test(endpoint)) endpoint = `http://127.0.0.1:${endpoint}`;
    const url = new URL(endpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new EngineError("Invalid CDP endpoint", "BROWSER_INVALID_ARGUMENTS");
    this.connectionStage = "opening Gateway transport";
    const transport = await EngineTransport.connect(endpoint);
    this.transport = transport;
    transport.onEvent(event=>this.debug?.event(event));
    this.artifactsDir = await mkdtemp(path.join(os.tmpdir(), "profilepilot-browser-"));
    let browser: Browser;
    this.connectionStage = "initializing browser";
    try { browser = await chromium.connectOverCDP(transport, { timeout: 20000, noDefaults: true, artifactsDir: this.artifactsDir }); }
    catch (error) { transport.close(); this.transport = undefined; throw error; }
    this.browser = browser; this.endpoint = endpoint;
    browser.on("disconnected", () => { if (this.browser === browser) { this.page = undefined; this.references.clear();this.debugAllowed=false;this.debug?.suspend('disconnected'); } });
    const context = browser.contexts()[0];
    if (!context) { await this.disconnect(); throw new EngineError("Browser did not expose its default context"); }
    this.context = context;
    context.setDefaultTimeout(this.timeout);
    context.setDefaultNavigationTimeout(30000);
    for (const page of context.pages()) this.register(page);
    context.on("page", page => this.register(page));
    let selected: Page | undefined;
    if (this.selectedTargetId) {
      for (const page of context.pages()) {
        const targetId = await this.identifyPage(page);
        this.tabs.get(page)!.targetId = targetId;
        if (targetId === this.selectedTargetId) selected = page;
      }
      if (!selected) {
        this.connectionStage = "connected";
        return { connected: true, selectionRequired: true, message: "The previously selected tab was closed. Use tab list, then select a tab explicitly." };
      }
    } else selected = context.pages().find(page => !/^(?:chrome|devtools|chrome-extension):/.test(page.url())) || context.pages()[0];
    if (!selected) throw new EngineError("Browser has no available tab. Open a tab in the managed browser before reconnecting.", "BROWSER_NO_TABS");
    await this.select(selected);
    this.connectionStage = "reading selected tab";
    await selected.evaluate(() => document.readyState);
    this.connectionStage = "connected";
    return { connected: true, url: selected.url(), title: await selected.title() };
  }
  private register(page: Page): void {
    if (this.tabs.has(page)) return;
    this.tabs.set(page, { id: `t${++this.tabSequence}` });
    page.on("framenavigated", () => { if (this.page === page) this.references.clear(); });
    page.on("framedetached", () => { if (this.page === page) this.references.clear(); });
    page.on("close", () => {
      this.tabs.delete(page); this.dialogs.delete(page);
      if (this.page === page) { this.page = undefined; this.frame = undefined; this.references.clear(); }
    });
    page.on("dialog", dialog => {
      if (this.noAutoDialog) this.dialogs.set(page, dialog);
      else void dialog.dismiss().catch(() => {});
    });

  }
  private identifyPage(page: Page): Promise<string> {
    const marker = `profilepilot_target_${randomUUID()}`;
    return this.transport!.identifyTarget(marker, () => page.evaluate(`/* ${marker} */ 0`));
  }
  private async select(page: Page): Promise<void> {
    if(this.page && this.page!==page)await this.detachDebug();
    this.register(page); this.page = page; this.frame = page.mainFrame(); this.references.clear();
    this.selectedTargetId = await this.identifyPage(page);
    this.tabs.get(page)!.targetId = this.selectedTargetId;
  }
  private async detachDebug():Promise<void>{
    this.debug?.suspend('target-changed');
    const id=this.debugSessionId;this.debugSessionId=undefined;this.debugTarget=undefined;
    if(id)await this.transport?.request('Target.detachFromTarget',{sessionId:id});
  }
  private async debugCommand(method:string,args:string[]):Promise<any>{
    const params=parseDebugArgs(method,args);
    this.current();this.debugAllowed=true;
    if(this.debugTarget!==this.selectedTargetId)await this.detachDebug();
    if(!this.debug){
      const check=()=>{this.current();if(!this.debugAllowed)throw new EngineError('Debug capture stopped after control changed','BROWSER_USER_IN_CONTROL');};
      this.debug=new BrowserDebugSession({check,send:(method,params,session)=>{check();return this.transport!.request(method,params,session);}},path.resolve('browser-debug-artifacts'));
    }
    if(!this.debugSessionId){this.debugSessionId=await this.transport!.attachDebug(this.selectedTargetId!);this.debugTarget=this.selectedTargetId;}
    this.debug.bindTarget(this.selectedTargetId!,this.debugSessionId);
    return this.debug.command(method,params);
  }
  private current(): { page: Page; frame: Frame; context: BrowserContext } {
    if (!this.browser?.isConnected() || !this.context) throw new EngineError("Browser session is disconnected. Reconnect through ProfilePilot Gateway.", "BROWSER_DISCONNECTED");
    if (!this.page || this.page.isClosed()) throw new EngineError("Selected tab was closed. Select a tab explicitly.", "BROWSER_TAB_CLOSED");
    if (!this.frame || this.frame.isDetached()) throw new EngineError("Selected frame was detached. Select frame main and observe again.", "BROWSER_FRAME_DETACHED");
    return { page: this.page, frame: this.frame, context: this.context };
  }
  private locator(selector: string): Locator {
    const { page, frame } = this.current();
    return this.references.locator(page, frame, selector);
  }
  async execute(command: EngineCommand): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = command.args[0] === "connect" ? Math.max(35000, command.timeout) : command.timeout;
    try {
      return await Promise.race([this.executeCommand(command), new Promise((_, reject) => {
        timer = setTimeout(() => {
          const stage = this.connectionStage;
          // Cancel pending CDP actions before allowing another queued command.
          // A timeout has an unknown outcome and is never automatically replayed.
          const fail = () => reject(new EngineError(`Browser command timed out (${stage}); inspect state before continuing.`, "BROWSER_COMMAND_TIMEOUT"));
          void this.disconnect().then(fail, fail);
        }, timeout);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async executeCommand(command: EngineCommand): Promise<any> {
    this.timeout = command.timeout;
    this.context?.setDefaultTimeout(this.timeout);
    if (command.noAutoDialog !== undefined) this.noAutoDialog = command.noAutoDialog;
    const [verb, ...args] = command.args;
    if (verb === "connect") return this.connect(required(args[0], "CDP endpoint"));
    if (verb === "close" || verb === "quit" || verb === "exit") { await this.disconnect(); return { closed: true }; }
    if (command.endpoint && !this.browser?.isConnected()) await this.connect(command.endpoint);
    // Cached operations (frame main, request logs, etc.) must still prove that
    // this service reaches the guarded connection. Works with a pending dialog.
    if (!this.browser?.isConnected() || !this.context || !this.transport) throw new EngineError("Browser session is disconnected. Reconnect through ProfilePilot Gateway.", "BROWSER_DISCONNECTED");
    await this.transport!.request("Browser.getVersion");
    // These commands recover deliberately after a tab/frame closes. Never
    // silently switch the target of a pending input command.
    if (verb === "tab" || verb === "tabs") return this.tab(args);
    if (verb === "frame" && (!args[0] || args[0] === "main") && this.page && !this.page.isClosed()) {
      this.frame = this.page.mainFrame(); this.references.clear(); return { frame: "main" };
    }
    const { page, frame, context } = this.current();
    const arg = (i: number, label: string) => required(args[i], label);
    switch (verb) {
      case "observe": return this.observeCommon(args);
      case "action": return this.actionCommon(args);
      case "open": case "goto": case "navigate": {
        const url = arg(0, "URL");
        await frame.goto(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`, { waitUntil: "domcontentloaded" });
        return { url: page.url(), title: await page.title() };
      }
      case "back": await page.goBack({ waitUntil: "domcontentloaded" }); return { url: page.url() };
      case "forward": await page.goForward({ waitUntil: "domcontentloaded" }); return { url: page.url() };
      case "reload": await page.reload({ waitUntil: "domcontentloaded" }); return { url: page.url() };
      case "snapshot": return this.references.snapshot(page, frame, args);
      case "read": return { url: frame.url(), text: await frame.locator("body").innerText() };
      case "eval": return { result: await frame.evaluate(arg(0, "JavaScript")) };
      case "click": case "dblclick": case "hover": case "focus": case "fill": case "type":
      case "check": case "uncheck": case "select": case "scrollintoview": case "scrollinto": case "upload":
        return this.interact(this.locator(arg(0, "selector")), verb, args.slice(1));
      case "press": case "key": await page.keyboard.press(arg(0, "key")); return { pressed: args[0] };
      case "keydown": await page.keyboard.down(arg(0, "key")); return {};
      case "keyup": await page.keyboard.up(arg(0, "key")); return {};
      case "keyboard":
        if (args[0] === "type") await page.keyboard.type(arg(1, "text"));
        else if (args[0] === "inserttext") await page.keyboard.insertText(arg(1, "text"));
        else throw new EngineError("keyboard expects type or inserttext", "BROWSER_INVALID_ARGUMENTS");
        return {};
      case "mouse": return this.mouse(args);
      case "scroll": return this.scroll(args);
      case "drag": await this.locator(arg(0, "source")).dragTo(this.locator(arg(1, "target"))); return {};
      case "get": return this.get(args);
      case "is": {
        const locator = this.locator(arg(1, "selector"));
        if (args[0] === "visible") return { visible: await locator.isVisible() };
        if (args[0] === "enabled") return { enabled: await locator.isEnabled() };
        if (args[0] === "checked") return { checked: await locator.isChecked() };
        throw new EngineError("is expects visible, enabled or checked", "BROWSER_INVALID_ARGUMENTS");
      }
      case "find": return this.find(args);
      case "wait": return this.wait(args);
      case "tab": case "tabs": return this.tab(args);
      case "window":
        if (args[0] !== "new") throw new EngineError("window expects new", "BROWSER_INVALID_ARGUMENTS");
        {
          const [next, result] = await Promise.all([context.waitForEvent("page"), this.transport!.request("Target.createTarget", { url: args[1] || "about:blank", newWindow: true })]);
          await this.select(next);
          return { targetId: result.targetId, ...this.tabs.get(next) };
        }
      case "frame":
        if (args[0] === "main" || !args[0]) { this.frame = page.mainFrame(); this.references.clear(); return { frame: "main" }; }
        {
          const element = await this.locator(args[0]).elementHandle();
          const selected = await element?.contentFrame();
          if (!selected) throw new EngineError("Selector does not identify an iframe");
          this.frame = selected; this.references.clear(); return { frame: selected.name(), url: selected.url() };
        }
      case "screenshot": return this.screenshot(args);
      case "pdf": {
        const destination = path.resolve(arg(0, "PDF path")); await mkdir(path.dirname(destination), { recursive: true });
        await page.pdf({ path: destination, printBackground: true }); return { path: destination };
      }
      case "download": return this.download(arg(0, "selector"), path.resolve(arg(1, "download path")));
      case "cookies": return this.cookies(args);
      case "storage": return this.storage(args);
      case "network": case "debug": case "profiler": return this.debugCommand(verb,args);
      case "dialog": {
        const dialog = this.dialogs.get(page);
        if (!dialog) throw new EngineError("No pending dialog");
        if (args[0] === "accept") await dialog.accept(args[1]); else if (args[0] === "dismiss") await dialog.dismiss();
        else throw new EngineError("dialog expects accept or dismiss", "BROWSER_INVALID_ARGUMENTS");
        this.dialogs.delete(page); return {};
      }
      case "set": return this.settings(args);
      case "state": return this.state(args);
      case "console": case "errors": return this.debugCommand(verb,args);
      case "trace":
        if (args[0] === "start") { await context.tracing.start({ screenshots: true, snapshots: true }); return {}; }
        if (args[0] === "stop") { const destination = path.resolve(args[1] || `trace-${Date.now()}.zip`); await context.tracing.stop({ path: destination }); return { path: destination }; }
        throw new EngineError("trace expects start or stop", "BROWSER_INVALID_ARGUMENTS");
      case "batch": {
        const json = option(args, "--commands-json");
        const values: unknown = json === undefined ? args.filter(value => value !== "--bail").map(splitCommand) : JSON.parse(json);
        if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(row => !Array.isArray(row) || row.some(value => typeof value !== "string"))) throw new EngineError("Batch expects 1–100 command arrays", "BROWSER_INVALID_ARGUMENTS");
        const commands = values.map(row => parseEngineCommand(["--session", command.session, "--timeout", String(command.timeout), ...row]));
        if (commands.some(item => item.session !== command.session || item.endpoint || ["connect", "close", "quit", "exit", "batch"].includes(item.args[0])))
          throw new EngineError("Batch cannot switch connections, sessions or lifecycle; use the guarded CLI commands.", "BROWSER_INVALID_ARGUMENTS");
        const results = [];
        for (const item of commands) {
          try { results.push({ command: item.args[0], success: true, data: await this.execute(item) }); }
          catch (error) {
            results.push({ command: item.args[0], success: false, error: error instanceof Error ? error.message : String(error) });
            if (has(args, "--bail")) break;
          }
        }
        return { results, failed: results.some(result => !result.success) };
      }
      case "clipboard":
        if (args[0] === "read") return { text: await frame.evaluate(() => navigator.clipboard.readText()) };
        if (args[0] === "write") { await frame.evaluate(text => navigator.clipboard.writeText(text), arg(1, "text")); return {}; }
        if (["copy", "paste"].includes(args[0])) { await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+${args[0] === "copy" ? "c" : "v"}`); return {}; }
        throw new EngineError("Invalid clipboard command", "BROWSER_INVALID_ARGUMENTS");
      default: throw new EngineError(`Unknown browser command: ${verb}`, "BROWSER_INVALID_ARGUMENTS");
    }
  }
  private async observeCommon(args: string[]) {
    const { page, frame } = this.current();
    const input = JSON.parse(option(args, "--params") || "{}");
    const output = option(args, "--output");
    let image: Buffer | undefined, capturedAt: string | undefined, imageError: string | undefined;
    if (input.screenshot === true || output) {
      try { image = await page.screenshot({ type: "png" }); capturedAt = new Date().toISOString(); }
      catch (error) {
        // Check the same guarded connection before returning a DOM-only result.
        await this.transport!.request("Browser.getVersion");
        imageError = error instanceof Error ? error.message : String(error);
      }
    }
    const observed = await this.references.snapshot(page, frame, []);
    const at = new Date().toISOString();
    if (output && image) await writeFile(output, image, { mode: 0o600 });
    const observation = { version: observed.version, at, url: frame.url(), title: await page.title(), snapshot: observed.snapshot,
      fast: { candidates: Object.entries(observed.refs).map(([ref, item]) => ({ ref, role: item.role, label: item.name,
        kind: ["textbox", "searchbox", "spinbutton"].includes(item.role) ? "fill" : item.role === "combobox" ? "select" : "click" })) },
      availability: { dom: { status: "available", observedAt: at },
        screenshot: { status: image ? "available" : input.screenshot || output ? "unavailable" : "not-requested", capturedAt, reason: imageError },
        coordinates: { status: "unavailable", reason: "通过本次元素引用操作；独立截图不作为坐标授权。" } },
      ...(image ? output ? { screenshotPath: path.resolve(output) } : { screenshotDataUrl: `data:image/png;base64,${image.toString("base64")}` } : {}) };
    if (output && !image) throw Object.assign(new EngineError("截图不可用；partialResult 包含本次 DOM，不使用已有的输出文件。", "BROWSER_RENDER_UNAVAILABLE"), { partialResult: observation });
    return observation;
  }
  private async actionCommon(args: string[]) {
    const action = parseCommonBrowserAction(JSON.parse(required(option(args, "--params"), "--params")));
    if (!this.references.version || action.version !== this.references.version) throw new EngineError("动作未执行：version 已失效，请重新 observe。", "BROWSER_STALE_REF");
    const { page, frame } = this.current();
    try {
      const locator = action.ref ? this.references.locator(page, frame, action.ref) : undefined;
      if (action.kind === "press") {
        if (locator) await locator.press(action.value!); else await page.keyboard.press(action.value!);
      } else if (action.kind === "scroll") {
        const direction = action.value || "down";
        const delta = { up: [0, -600], down: [0, 600], left: [-600, 0], right: [600, 0] }[direction]!;
        if (locator) await locator.evaluate((el, [left, top]) => el.scrollBy({ left, top, behavior: "instant" }), delta);
        else await frame.evaluate(([left, top]) => window.scrollBy({ left, top, behavior: "instant" }), delta);
      } else {
        if (action.kind === "upload") for (const file of action.files!) {
          if (!path.isAbsolute(file) || !(await stat(file).catch(() => undefined))?.isFile()) throw new EngineError("upload.files 必须指向已有的绝对文件路径。", "BROWSER_INVALID_ARGUMENTS");
        }
        await this.interact(locator!, action.kind, action.kind === "upload" ? action.files! : action.value !== undefined ? [action.value] : []);
      }
      return { action: action.kind, actionOutcome: "completed", nextStep: "reobserve" };
    } finally { this.references.clear(); }
  }
  private async interact(locator: Locator, verb: string, args: string[]): Promise<any> {
    switch (verb) {
      case "click":
        if (has(args, "--new-tab")) {
          const [popup] = await Promise.all([this.current().context.waitForEvent("page"), locator.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] })]);
          await this.select(popup); return { url: popup.url() };
        }
        await locator.click(); break;
      case "dblclick": await locator.dblclick(); break;
      case "hover": await locator.hover(); break;
      case "focus": await locator.focus(); break;
      case "fill": await locator.fill(required(args[0], "text")); break;
      case "type": await locator.pressSequentially(required(args[0], "text")); break;
      case "check": await locator.check(); break;
      case "uncheck": await locator.uncheck(); break;
      case "select": {
        const values = args.length ? args : [required(undefined, "value")];
        const options = await locator.evaluate(el => Array.from((el as HTMLSelectElement).options).map(o => ({ value: o.value, label: o.label })));
        await locator.selectOption(values.map(value => options.some(o => o.value === value) ? { value } : { label: value })); break;
      }
      case "scrollinto": case "scrollintoview": await locator.scrollIntoViewIfNeeded(); break;
      case "upload": if (!args.length) throw new EngineError("Missing upload files"); await locator.setInputFiles(args.map(file => path.resolve(file))); break;
      case "text": return { text: await locator.innerText() };
      default: throw new EngineError(`Unsupported element action: ${verb}`, "BROWSER_INVALID_ARGUMENTS");
    }
    return { action: verb };
  }
  private async get(args: string[]): Promise<any> {
    const { page, frame } = this.current();
    if (args[0] === "url") return { url: await frame.evaluate(() => location.href) };
    if (args[0] === "title") return { title: await page.title() };
    const locator = this.locator(required(args[1], "selector"));
    switch (args[0]) {
      case "text": return { text: await locator.innerText() };
      case "html": return { html: await locator.innerHTML() };
      case "value": return { value: await locator.inputValue() };
      case "attr": return { value: await locator.getAttribute(required(args[2], "attribute")) };
      case "count": return { count: await locator.count() };
      case "box": return { box: await locator.boundingBox() };
      case "styles": return { styles: await locator.evaluate(el => Object.fromEntries(Array.from(getComputedStyle(el)).map(name => [name, getComputedStyle(el).getPropertyValue(name)]))) };
      default: throw new EngineError("Unknown get operation", "BROWSER_INVALID_ARGUMENTS");
    }
  }
  private async find(args: string[]): Promise<any> {
    const { frame } = this.current();
    const [kind, query] = args;
    const exact = has(args, "--exact");
    let locator: Locator, actionIndex = 2;
    switch (kind) {
      case "role": locator = frame.getByRole(required(query, "role") as Parameters<Frame["getByRole"]>[0], { name: option(args, "--name"), exact }); break;
      case "text": locator = frame.getByText(required(query, "text"), { exact }); break;
      case "label": locator = frame.getByLabel(required(query, "label"), { exact }); break;
      case "placeholder": locator = frame.getByPlaceholder(required(query, "placeholder"), { exact }); break;
      case "alt": locator = frame.getByAltText(required(query, "alt"), { exact }); break;
      case "title": locator = frame.getByTitle(required(query, "title"), { exact }); break;
      case "testid": locator = frame.getByTestId(required(query, "test id")); break;
      case "first": locator = this.locator(required(query, "selector")).first(); break;
      case "last": locator = this.locator(required(query, "selector")).last(); break;
      case "nth":
        if (!/^\d+$/.test(query || "")) throw new EngineError("Invalid element index", "BROWSER_INVALID_ARGUMENTS");
        locator = this.locator(required(args[2], "selector")).nth(Number(query)); actionIndex = 3; break;
      default: throw new EngineError("Unknown find operation", "BROWSER_INVALID_ARGUMENTS");
    }
    return this.interact(locator, required(args[actionIndex], "action"), args.slice(actionIndex + 1));
  }
  private async mouse(args: string[]): Promise<any> {
    const { page } = this.current();
    const number = (i: number) => {
      const n = Number(required(args[i], "coordinate"));
      if (!Number.isFinite(n)) throw new EngineError("Invalid pointer coordinate", "BROWSER_INVALID_ARGUMENTS");
      return n;
    };
    if (args[0] === "move") await page.mouse.move(number(1), number(2));
    else if (args[0] === "wheel") await page.mouse.wheel(args[2] === undefined ? 0 : number(2), number(1));
    else if (args[0] === "down" || args[0] === "up") {
      const button = args[1] || "left";
      if (!["left", "right", "middle"].includes(button)) throw new EngineError("Invalid mouse button", "BROWSER_INVALID_ARGUMENTS");
      await page.mouse[args[0]]({ button: button as "left" | "right" | "middle" });
    } else throw new EngineError("Unknown mouse command", "BROWSER_INVALID_ARGUMENTS");
    return {};
  }
  private async scroll(args: string[]): Promise<any> {
    const direction = required(args[0], "scroll direction");
    if (!["up", "down", "left", "right"].includes(direction)) throw new EngineError("Invalid scroll direction", "BROWSER_INVALID_ARGUMENTS");
    const amount = args[1] && !args[1].startsWith("-") ? positiveNumber(args[1], "scroll distance") : 600;
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    const selector = option(args, "--selector");
    if (selector) await this.locator(selector).evaluate((el, delta) => el.scrollBy(delta.dx, delta.dy), { dx, dy });
    else await this.current().page.mouse.wheel(dx, dy);
    return { scrolled: direction, pixels: amount };
  }
  private async wait(args: string[]): Promise<any> {
    const { page, frame } = this.current();
    const text = option(args, "--text"), url = option(args, "--url"), load = option(args, "--load"), fn = option(args, "--fn");
    if (text !== undefined) await frame.getByText(text).first().waitFor({ state: "visible" });
    else if (url !== undefined) await frame.waitForURL(url, { timeout: this.timeout });
    else if (load !== undefined) {
      if (!["load", "domcontentloaded", "networkidle"].includes(load)) throw new EngineError("Invalid load state");
      await frame.waitForLoadState(load as "load", { timeout: this.timeout });
    } else if (fn !== undefined) { const handle = await frame.waitForFunction(fn, undefined, { timeout: this.timeout }); await handle.dispose(); }
    else if (/^\d+$/.test(args[0] || "")) await page.waitForTimeout(Math.min(Number(args[0]), 300000));
    else {
      const state = option(args, "--state") || "visible";
      if (!["attached", "detached", "visible", "hidden"].includes(state)) throw new EngineError("Invalid wait state");
      await this.locator(required(args[0], "selector")).waitFor({ state: state as "visible" });
    }
    return { waited: true };
  }
  private async tab(args: string[]): Promise<any> {
    const context = this.context!, page = this.page;
    if (!args.length || args[0] === "list") {
      // Touch the selected page so Gateway observes the operation, not only cached metadata.
      if (page && !page.isClosed()) await page.title();
      return { tabs: await Promise.all([...this.tabs].map(async ([p, info]) => ({ ...info, active: p === this.page, url: p.url(), title: await p.title().catch(() => "") }))) };
    }
    if (args[0] === "new") {
      const next = await context.newPage(); await this.select(next);
      const label = option(args, "--label"); if (label) this.tabs.get(next)!.label = label;
      if (args[1] && !args[1].startsWith("--")) await next.goto(args[1], { waitUntil: "domcontentloaded" });
      return { ...this.tabs.get(next), url: next.url() };
    }
    const target = args[0] === "close" ? args[1] : args[0];
    const selected = target ? [...this.tabs].find(([, info]) => info.id === target || info.targetId === target || info.label === target)?.[0] : page;
    if (!selected) throw new EngineError(`Unknown tab: ${target}`, "BROWSER_INVALID_ARGUMENTS");
    if (args[0] === "close") { const id = this.tabs.get(selected)?.id; await selected.close(); return { closed: id }; }
    await this.select(selected);
    await selected.evaluate(() => document.title);
    return { ...this.tabs.get(selected), url: selected.url(), title: await selected.title() };
  }
  private async screenshot(args: string[]): Promise<any> {
    const { page, frame } = this.current();
    const destination = path.resolve(option(args, "--output") || (args[0] && !args[0].startsWith("-") ? args[0] : path.join(option(args, "--screenshot-dir") || os.tmpdir(), `profilepilot-${randomUUID()}.png`)));
    await mkdir(path.dirname(destination), { recursive: true });
    const quality = option(args, "--screenshot-quality", "--quality");
    const type = option(args, "--screenshot-format") || (/\.jpe?g$/i.test(destination) ? "jpeg" : "png");
    if (!["png", "jpeg"].includes(type)) throw new EngineError("Invalid screenshot format");
    const overlayId = `profilepilot-screenshot-${randomUUID()}`;
    let snapshot: Awaited<ReturnType<EngineReferences["snapshot"]>> | undefined;
    if (has(args, "--annotate")) {
      snapshot = await this.references.snapshot(page, frame, []);
      const boxes = await this.references.boxes(page);
      await page.evaluate(({ id, boxes }) => {
        const root = document.createElement("div"); root.id = id; root.dataset.profilepilotOverlay = "screenshot";
        root.style.cssText = "position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none";
        for (const box of boxes) {
          const item = document.createElement("div");
          item.style.cssText = `position:absolute;left:${box.x + scrollX}px;top:${box.y + scrollY}px;width:${box.width}px;height:${box.height}px;border:2px solid #e11d48;box-sizing:border-box`;
          const label = document.createElement("span"); label.textContent = "@" + box.ref;
          label.style.cssText = "position:absolute;left:0;top:0;font:12px sans-serif;background:#e11d48;color:white;padding:2px";
          item.append(label); root.append(item);
        }
        document.documentElement.append(root);
      }, { id: overlayId, boxes });
    }
    try {
      await page.screenshot({ path: destination, type: type as "png" | "jpeg", quality: type === "jpeg" && quality ? Number(quality) : undefined, fullPage: has(args, "--full", "--full-page") });
    } finally {
      if (snapshot) await page.evaluate(id => document.getElementById(id)?.remove(), overlayId).catch(() => {});
    }
    return { path: destination, capturedAt: new Date().toISOString(), coordinateObservation: false, ...(snapshot ? { refs: snapshot.refs, snapshot: snapshot.snapshot } : {}) };
  }
  private async download(selector: string, destination: string): Promise<any> {
    const { page } = this.current();
    await mkdir(path.dirname(destination), { recursive: true });
    await this.transport!.request("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.artifactsDir!, eventsEnabled: true });
    try {
      const [download] = await Promise.all([page.waitForEvent("download"), this.locator(selector).click()]);
      await download.saveAs(destination);
      const error = await download.failure();
      if (error) throw new EngineError(`Download failed: ${error}`);
      return { path: destination, suggestedFilename: download.suggestedFilename() };
    } finally {
      await this.transport?.request("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false }).catch(() => {});
    }
  }
  private async cookies(args: string[]): Promise<any> {
    const { context, page } = this.current();
    if (!args.length || args[0] === "get") return { cookies: await context.cookies() };
    if (args[0] === "clear") { await context.clearCookies(); return {}; }
    if (args[0] === "set") {
      const domain = option(args, "--domain"), cookiePath = option(args, "--path") || "/";
      await context.addCookies([{ name: required(args[1], "cookie name"), value: required(args[2], "cookie value"),
        ...(domain ? { domain, path: cookiePath } : { url: page.url() }), secure: has(args, "--secure"), httpOnly: has(args, "--http-only") }]);
      return {};
    }
    throw new EngineError("Unknown cookies operation", "BROWSER_INVALID_ARGUMENTS");
  }
  private async storage(args: string[]): Promise<any> {
    const kind = args[0];
    if (kind !== "local" && kind !== "session") throw new EngineError("storage expects local or session", "BROWSER_INVALID_ARGUMENTS");
    if (args[1] === "set") { required(args[2], "storage key"); required(args[3], "storage value"); }
    return this.current().frame.evaluate(({ kind, op, key, value }) => {
      const store = kind === "local" ? localStorage : sessionStorage;
      if (op === "set") { store.setItem(key!, value!); return {}; }
      if (op === "clear") { store.clear(); return {}; }
      if (op) return { value: store.getItem(op) };
      return { storage: Object.fromEntries(Array.from({ length: store.length }, (_, i) => { const k = store.key(i)!; return [k, store.getItem(k)]; })) };
    }, { kind, op: args[1], key: args[2], value: args[3] });
  }
  private async settings(args: string[]): Promise<any> {
    const { page, context } = this.current();
    const number = (i: number) => { const n = Number(required(args[i], "setting value")); if (!Number.isFinite(n)) throw new EngineError("Invalid numeric setting"); return n; };
    switch (args[0]) {
      case "viewport": await page.setViewportSize({ width: number(1), height: number(2) }); break;
      case "geo": await context.setGeolocation({ latitude: number(1), longitude: number(2) }); await context.grantPermissions(["geolocation"], { origin: new URL(page.url()).origin }); break;
      case "offline": await context.setOffline(args[1] !== "off"); break;
      case "headers": await context.setExtraHTTPHeaders(JSON.parse(required(args[1], "headers JSON"))); break;
      case "credentials": await context.setHTTPCredentials({ username: required(args[1], "username"), password: required(args[2], "password") }); break;
      case "media":
        if (!["dark", "light", "no-preference"].includes(args[1])) throw new EngineError("Invalid color scheme");
        await page.emulateMedia({ colorScheme: args[1] as "dark" }); break;
      default: throw new EngineError("Unknown browser setting", "BROWSER_INVALID_ARGUMENTS");
    }
    return {};
  }
  private async state(args: string[]): Promise<any> {
    const { context } = this.current();
    const destination = path.resolve(required(args[1], "state path"));
    if (args[0] === "save") {
      await mkdir(path.dirname(destination), { recursive: true });
      const state = await context.storageState();
      await writeFile(destination, JSON.stringify(state), { mode: 0o600 }); return { path: destination };
    }
    if (args[0] === "load") {
      const state = JSON.parse(await readFile(destination, "utf8"));
      if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new EngineError("Invalid browser state");
      await context.setStorageState(state);
      return { loaded: true };
    }
    throw new EngineError("state expects save or load", "BROWSER_INVALID_ARGUMENTS");
  }
}
