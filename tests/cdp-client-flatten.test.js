const assert = require("node:assert/strict");
const test = require("node:test");

const { CdpBrowserClient } = require("../dist/main/cdp-client.js");

test("CdpBrowserClient routes flatten session commands and events", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      sockets.push(this);
      setImmediate(() => {
        this.readyState = 1;
        this.dispatch("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      this.listeners.set(
        type,
        listeners.filter((item) => item !== listener)
      );
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.dispatch("close", {});
    }

    emitMessage(message) {
      this.dispatch("message", { data: JSON.stringify(message) });
    }

    dispatch(type, event) {
      for (const listener of this.listeners.get(type) || []) {
        listener(event);
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    const client = await CdpBrowserClient.connect("ws://127.0.0.1/devtools/browser/test", 1000);
    const socket = sockets[0];
    assert.ok(socket);

    const evaluate = client.send("Runtime.evaluate", { expression: "1 + 1" }, 1000, "page-session-1");
    assert.deepEqual(socket.sent[0], {
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "1 + 1" },
      sessionId: "page-session-1"
    });

    socket.emitMessage({ id: 1, sessionId: "page-session-1", result: { ok: true } });
    assert.deepEqual(await evaluate, { ok: true });

    const events = [];
    client.onEvent = (method, params, sessionId) => {
      events.push({ method, params, sessionId });
    };

    socket.emitMessage({
      method: "Runtime.bindingCalled",
      sessionId: "page-session-2",
      params: { name: "__ppAgentOverlaySignal", payload: "{\"action\":\"hide\"}" }
    });
    socket.emitMessage({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "page-session-3",
        targetInfo: { targetId: "target-3", type: "page", url: "https://example.test/" }
      }
    });

    assert.deepEqual(events, [
      {
        method: "Runtime.bindingCalled",
        params: { name: "__ppAgentOverlaySignal", payload: "{\"action\":\"hide\"}" },
        sessionId: "page-session-2"
      },
      {
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-session-3",
          targetInfo: { targetId: "target-3", type: "page", url: "https://example.test/" }
        },
        sessionId: undefined
      }
    ]);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
