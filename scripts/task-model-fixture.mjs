import http from "node:http";

// A scripted API fixture, never a claim about real model quality.
export async function startModelFixture(nextBlock) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":100}'); return; }
    if (!req.url?.includes("messages")) { res.setHeader("content-type", "application/json"); res.end('{}'); return; }
    try {
      const body = JSON.parse(text); requests.push(body);
      const block = await nextBlock(body, requests.length - 1);
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const message = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
      if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
      send("message_stop", {}); res.end();
    } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "api_error", message: String(error) } })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export function lastObservation(body) {
  const observations = [];
  function visit(value) {
    if (typeof value === "string") { try { visit(JSON.parse(value)); } catch {} }
    else if (value && typeof value === "object") {
      if (value.snapshot && value.version) observations.push(value);
      else for (const child of Object.values(value)) visit(child);
    }
  }
  visit(body.messages);
  return observations.at(-1);
}
export function pageRef(observation, label) {
  if (!observation) throw new Error("No observation received");
  const line = observation.snapshot.split("\n").find(line => line.includes(label) && /@e\d+|ref=e\d+/.test(line));
  if (!line) throw new Error(`No element for ${label}`);
  return line.match(/@e\d+/)?.[0] || "@" + line.match(/ref=(e\d+)/)[1];
}
