import { rmSync } from "node:fs";
import net from "node:net";
import { app, nativeImage, type BrowserWindow, type InputEvent, type Rectangle } from "electron";

type E2eWindowTarget = "main" | "mini";

interface E2eDriverOptions {
  socketPath: string;
  mode: "background" | "desktop";
  getWindow: (target: E2eWindowTarget) => BrowserWindow | null;
  getWindowSnapshot: () => unknown;
  triggerMiniHotkeyHandler: () => Promise<void>;
}

interface E2eDriverRequest {
  id?: string | number;
  command?: string;
  target?: E2eWindowTarget;
  selector?: string;
  index?: number;
  text?: string;
  keyCode?: string;
  modifiers?: string[];
  toX?: number;
  toY?: number;
  expression?: string;
  eventType?: string;
  eventInit?: Record<string, unknown>;
  value?: string;
  checked?: boolean;
  baselinePngBase64?: string;
  channelTolerance?: number;
  maxDifferentPixelRatio?: number;
}

const BACKGROUND_COMMANDS = new Set([
  "ping",
  "windows",
  "query",
  "evaluate",
  "domClick",
  "domInput",
  "dispatch",
  "screenshot",
  "compareScreenshot",
  "quit"
]);

interface ElementSnapshot {
  count: number;
  exists: boolean;
  text: string | null;
  value: string | null;
  checked: boolean | null;
  disabled: boolean | null;
  rect: Rectangle | null;
  attributes: Record<string, string>;
  hitTag: string | null;
  hitText: string | null;
  hitMatches: boolean;
  activeTag?: string | null;
  activeId?: string | null;
}

export function startE2eDriver(options: E2eDriverOptions): () => void {
  rmSync(options.socketPath, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let pending = "";

    socket.on("data", (chunk) => {
      pending += chunk;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        void handleLine(socket, line, options);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  server.listen(options.socketPath);

  const stop = (): void => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close();
    rmSync(options.socketPath, { force: true });
  };
  app.once("will-quit", stop);
  return stop;
}

async function handleLine(socket: net.Socket, line: string, options: E2eDriverOptions): Promise<void> {
  let request: E2eDriverRequest;
  try {
    request = JSON.parse(line) as E2eDriverRequest;
  } catch (error) {
    writeResponse(socket, null, false, null, `Invalid JSON: ${formatError(error)}`);
    return;
  }

  const id = request.id ?? null;
  try {
    const result = await executeRequest(request, options);
    writeResponse(socket, id, true, result, null);
  } catch (error) {
    writeResponse(socket, id, false, null, formatError(error));
  }
}

async function executeRequest(request: E2eDriverRequest, options: E2eDriverOptions): Promise<unknown> {
  if (options.mode === "background" && !BACKGROUND_COMMANDS.has(request.command || "")) {
    throw new Error(
      `Background E2E only supports DOM/read commands; ${String(request.command)} is a real desktop input command.`
    );
  }

  switch (request.command) {
    case "ping":
      return { pid: process.pid };
    case "windows":
      return options.getWindowSnapshot();
    case "triggerMiniHotkeyHandler":
      await options.triggerMiniHotkeyHandler();
      return options.getWindowSnapshot();
    case "activate": {
      const windowRef = requireWindow(options, request.target);
      if (!windowRef.isVisible()) windowRef.show();
      app.focus({ steal: true });
      windowRef.moveTop();
      windowRef.focus();
      windowRef.webContents.focus();
      return options.getWindowSnapshot();
    }
    case "query":
      return queryElement(requireWindow(options, request.target), requireSelector(request), request.index ?? 0);
    case "evaluate":
      return evaluateExpression(requireWindow(options, request.target), request.expression);
    case "domClick":
      return domClickElement(requireWindow(options, request.target), requireSelector(request), request.index ?? 0);
    case "domInput":
      return domInputElement(
        requireWindow(options, request.target),
        requireSelector(request),
        request.index ?? 0,
        request.value,
        request.checked
      );
    case "dispatch":
      return dispatchElementEvent(
        requireWindow(options, request.target),
        requireSelector(request),
        request.index ?? 0,
        request.eventType,
        request.eventInit
      );
    case "click":
      return clickElement(requireWindow(options, request.target), requireSelector(request), request.index ?? 0);
    case "fill":
      return fillElement(
        requireWindow(options, request.target),
        requireSelector(request),
        request.index ?? 0,
        String(request.text ?? "")
      );
    case "focus":
      return focusElement(requireWindow(options, request.target), requireSelector(request), request.index ?? 0);
    case "press":
      return pressKey(
        requireWindow(options, request.target),
        request.keyCode || "Enter",
        Array.isArray(request.modifiers) ? request.modifiers : []
      );
    case "drag":
      return dragElement(
        requireWindow(options, request.target),
        requireSelector(request),
        request.index ?? 0,
        Number(request.toX),
        Number(request.toY)
      );
    case "screenshot": {
      const image = await requireWindow(options, request.target).capturePage();
      return { pngBase64: image.toPNG().toString("base64"), size: image.getSize() };
    }
    case "compareScreenshot":
      return compareScreenshot(requireWindow(options, request.target), request);
    case "quit":
      setImmediate(() => app.quit());
      return { quitting: true };
    default:
      throw new Error(`Unsupported E2E driver command: ${String(request.command)}`);
  }
}

function requireWindow(options: E2eDriverOptions, target: E2eWindowTarget | undefined): BrowserWindow {
  const resolvedTarget = target === "mini" ? "mini" : "main";
  const windowRef = options.getWindow(resolvedTarget);
  if (!windowRef || windowRef.isDestroyed()) {
    throw new Error(`${resolvedTarget} window is not available`);
  }
  return windowRef;
}

function requireSelector(request: E2eDriverRequest): string {
  if (!request.selector) throw new Error("selector is required");
  return request.selector;
}

function requireExpression(request: E2eDriverRequest): string {
  if (!request.expression) throw new Error("expression is required");
  return request.expression;
}

function requireEventType(request: E2eDriverRequest): string {
  if (!request.eventType) throw new Error("eventType is required");
  return request.eventType;
}

async function evaluateExpression(windowRef: BrowserWindow, expression: string | undefined): Promise<unknown> {
  return windowRef.webContents.executeJavaScript(requireExpression({ expression }), true);
}

async function domClickElement(windowRef: BrowserWindow, selector: string, index: number): Promise<ElementSnapshot> {
  await windowRef.webContents.executeJavaScript(
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}];
      if (!(element instanceof HTMLElement)) throw new Error("Element is not clickable: " + ${JSON.stringify(selector)});
      if (element instanceof HTMLButtonElement && element.disabled) throw new Error("Element is disabled: " + ${JSON.stringify(selector)});
      element.click();
      return true;
    })()`,
    true
  );
  await shortDelay();
  return queryElement(windowRef, selector, index);
}

async function domInputElement(
  windowRef: BrowserWindow,
  selector: string,
  index: number,
  value: string | undefined,
  checked: boolean | undefined
): Promise<ElementSnapshot> {
  await windowRef.webContents.executeJavaScript(
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}];
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
        throw new Error("Element is not a form control: " + ${JSON.stringify(selector)});
      }
      if (${JSON.stringify(value)} !== undefined && "value" in element) {
        const prototype = element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLSelectElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, ${JSON.stringify(value)});
        else element.value = ${JSON.stringify(value)};
      }
      if (${JSON.stringify(checked)} !== undefined && element instanceof HTMLInputElement) {
        element.checked = Boolean(${JSON.stringify(checked)});
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    true
  );
  await shortDelay();
  return queryElement(windowRef, selector, index);
}

async function dispatchElementEvent(
  windowRef: BrowserWindow,
  selector: string,
  index: number,
  eventType: string | undefined,
  eventInit: Record<string, unknown> | undefined
): Promise<ElementSnapshot> {
  const type = requireEventType({ eventType });
  await windowRef.webContents.executeJavaScript(
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}];
      if (!(element instanceof Element)) throw new Error("Element is not available: " + ${JSON.stringify(selector)});
      const init = ${JSON.stringify(eventInit || {})};
      const event = ${JSON.stringify(type)}.startsWith("key")
        ? new KeyboardEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, ...init })
        : new Event(${JSON.stringify(type)}, { bubbles: true, cancelable: true, ...init });
      element.dispatchEvent(event);
      return true;
    })()`,
    true
  );
  await shortDelay();
  return queryElement(windowRef, selector, index);
}

async function queryElement(windowRef: BrowserWindow, selector: string, index: number): Promise<ElementSnapshot> {
  return windowRef.webContents.executeJavaScript(
    `(() => {
      const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const element = items[${JSON.stringify(index)}];
      if (!(element instanceof Element)) {
        return { count: items.length, exists: false, text: null, value: null, checked: null, disabled: null, rect: null, attributes: {}, hitTag: null, hitText: null, hitMatches: false };
      }
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        count: items.length,
        exists: true,
        text: element.textContent?.trim() || null,
        value: "value" in element ? String(element.value ?? "") : null,
        checked: "checked" in element ? Boolean(element.checked) : null,
        disabled: "disabled" in element ? Boolean(element.disabled) : null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
        hitTag: hit?.tagName || null,
        hitText: hit?.textContent?.trim() || null,
        hitMatches: Boolean(hit && (hit === element || element.contains(hit))),
        activeTag: document.activeElement?.tagName || null,
        activeId: document.activeElement?.id || null
      };
    })()`,
    true
  ) as Promise<ElementSnapshot>;
}

async function clickElement(windowRef: BrowserWindow, selector: string, index: number): Promise<ElementSnapshot> {
  if (!windowRef.isVisible()) windowRef.show();
  windowRef.focus();
  windowRef.webContents.focus();
  await windowRef.webContents.executeJavaScript(
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}];
      if (element instanceof Element) element.scrollIntoView({ block: "center", inline: "center" });
      return true;
    })()`,
    true
  );
  // Chromium updates compositor hit-test data on the next frame after scrollIntoView.
  // Sending input immediately can target the element's old off-screen position.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const snapshot = await queryElement(windowRef, selector, index);
  if (!snapshot.exists || !snapshot.rect || snapshot.rect.width <= 0 || snapshot.rect.height <= 0) {
    throw new Error(`Element is not clickable: ${selector}[${index}]`);
  }
  const x = Math.round(snapshot.rect.x + snapshot.rect.width / 2);
  const y = Math.round(snapshot.rect.y + snapshot.rect.height / 2);
  await sendMouse(windowRef, "mouseMove", x, y);
  await shortDelay();
  await sendMouse(windowRef, "mouseDown", x, y);
  await shortDelay();
  await sendMouse(windowRef, "mouseUp", x, y);
  await shortDelay();
  return snapshot;
}

async function fillElement(windowRef: BrowserWindow, selector: string, index: number, text: string): Promise<ElementSnapshot> {
  const snapshot = await clickElement(windowRef, selector, index);
  await focusElement(windowRef, selector, index);
  await assertFocused(windowRef, selector, index, "before typing");
  await pressKey(windowRef, "End", []);
  for (let cursor = 0; cursor < (snapshot.value?.length || 0); cursor += 1) {
    await pressKey(windowRef, "Backspace", []);
  }
  await assertFocused(windowRef, selector, index, "after clearing existing value");
  for (const character of text) {
    windowRef.webContents.sendInputEvent({ type: "char", keyCode: character });
  }
  await assertFocused(windowRef, selector, index, "after character input");
  await shortDelay();
  const finalSnapshot = await queryElement(windowRef, selector, index);
  if (finalSnapshot.value !== text) {
    throw new Error(`External keyboard input did not set ${selector}[${index}]: ${JSON.stringify(finalSnapshot)}`);
  }
  return finalSnapshot;
}

async function focusElement(windowRef: BrowserWindow, selector: string, index: number): Promise<ElementSnapshot> {
  if (!windowRef.isVisible()) windowRef.show();
  windowRef.focus();
  windowRef.webContents.focus();
  const snapshot = await queryElement(windowRef, selector, index);
  if (!snapshot.exists) throw new Error(`Element is not focusable: ${selector}[${index}]`);
  const focused = await windowRef.webContents.executeJavaScript(
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}];
      if (!(element instanceof HTMLElement)) return false;
      element.focus({ preventScroll: false });
      return document.activeElement === element;
    })()`,
    true
  );
  if (!focused) throw new Error(`Element did not retain DOM focus: ${selector}[${index}]`);
  return snapshot;
}

async function pressKey(windowRef: BrowserWindow, keyCode: string, modifiers: string[]): Promise<{ keyCode: string }> {
  const inputModifiers = modifiers as NonNullable<InputEvent["modifiers"]>;
  windowRef.focus();
  windowRef.webContents.focus();
  windowRef.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: inputModifiers });
  windowRef.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: inputModifiers });
  return { keyCode };
}

async function dragElement(
  windowRef: BrowserWindow,
  selector: string,
  index: number,
  toX: number,
  toY: number
): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) throw new Error("drag requires finite toX/toY viewport coordinates");
  if (!windowRef.isVisible()) windowRef.show();
  windowRef.focus();
  windowRef.webContents.focus();
  const snapshot = await queryElement(windowRef, selector, index);
  if (!snapshot.exists || !snapshot.rect) throw new Error(`Element is not draggable: ${selector}[${index}]`);
  const fromX = Math.round(snapshot.rect.x + snapshot.rect.width / 2);
  const fromY = Math.round(snapshot.rect.y + snapshot.rect.height / 2);
  await sendMouse(windowRef, "mouseMove", fromX, fromY);
  await sendMouse(windowRef, "mouseDown", fromX, fromY);
  for (let step = 1; step <= 6; step += 1) {
    await sendMouse(
      windowRef,
      "mouseMove",
      Math.round(fromX + ((toX - fromX) * step) / 6),
      Math.round(fromY + ((toY - fromY) * step) / 6)
    );
  }
  await sendMouse(windowRef, "mouseUp", Math.round(toX), Math.round(toY));
  return { from: { x: fromX, y: fromY }, to: { x: Math.round(toX), y: Math.round(toY) } };
}

async function sendMouse(
  windowRef: BrowserWindow,
  type: "mouseMove" | "mouseDown" | "mouseUp",
  x: number,
  y: number
): Promise<void> {
  const bounds = windowRef.getBounds();
  windowRef.webContents.sendInputEvent({
    type,
    x,
    y,
    globalX: bounds.x + x,
    globalY: bounds.y + y,
    button: "left",
    clickCount: 1
  });
}

function writeResponse(socket: net.Socket, id: string | number | null, ok: boolean, result: unknown, error: string | null): void {
  socket.write(`${JSON.stringify({ id, ok, result, error })}\n`);
}

async function compareScreenshot(windowRef: BrowserWindow, request: E2eDriverRequest): Promise<Record<string, number | boolean>> {
  if (!request.baselinePngBase64) throw new Error("baselinePngBase64 is required");
  const current = await windowRef.capturePage();
  const baseline = nativeImage.createFromBuffer(Buffer.from(request.baselinePngBase64, "base64"));
  const currentSize = current.getSize();
  const baselineSize = baseline.getSize();
  if (currentSize.width !== baselineSize.width || currentSize.height !== baselineSize.height) {
    throw new Error(
      `Screenshot size changed: current=${currentSize.width}x${currentSize.height} baseline=${baselineSize.width}x${baselineSize.height}`
    );
  }

  const currentBitmap = current.toBitmap();
  const baselineBitmap = baseline.toBitmap();
  const tolerance = Number.isFinite(request.channelTolerance) ? Math.max(0, Number(request.channelTolerance)) : 12;
  let differentPixels = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < currentBitmap.length; offset += 4) {
    let pixelDifferent = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(currentBitmap[offset + channel] - baselineBitmap[offset + channel]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (delta > tolerance) pixelDifferent = true;
    }
    if (pixelDifferent) differentPixels += 1;
  }
  const totalPixels = currentSize.width * currentSize.height;
  const differentPixelRatio = totalPixels ? differentPixels / totalPixels : 0;
  const allowedRatio = Number.isFinite(request.maxDifferentPixelRatio)
    ? Math.max(0, Number(request.maxDifferentPixelRatio))
    : 0.002;
  return {
    width: currentSize.width,
    height: currentSize.height,
    differentPixels,
    totalPixels,
    differentPixelRatio,
    maxChannelDelta,
    passed: differentPixelRatio <= allowedRatio
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertFocused(windowRef: BrowserWindow, selector: string, index: number, phase: string): Promise<void> {
  const focused = await windowRef.webContents.executeJavaScript(
    `document.activeElement === Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}]`,
    true
  );
  if (!focused) throw new Error(`Element lost DOM focus ${phase}: ${selector}[${index}]`);
}

function shortDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16));
}
