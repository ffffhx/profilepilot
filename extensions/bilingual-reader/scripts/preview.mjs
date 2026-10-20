import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { root } from "./build.mjs";
const artifacts = path.join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
await build({ entryPoints: [path.join(root, "src/demo-data.ts")], bundle: true, outfile: path.join(artifacts, "demo-data.mjs"), format: "esm", platform: "node" });
const { SAMPLES } = await import(pathToFileURL(path.join(artifacts, "demo-data.mjs")).href);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".json": "application/json", ".zip": "application/zip" };
let requests = 0;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  try {
    if (pathname === "/health") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ app: "bilingual-reader-preview", pid: process.pid, requests })); return; }
    // Deliberately deterministic integration fixture, never a general translation service.
    if (pathname === "/v1/chat/completions") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.end(); return; }
      let input = "";
      for await (const chunk of req) { input += chunk; if (input.length > 100000) throw new Error("Request too large"); }
      const payload = JSON.parse(input);
      const message = JSON.parse(payload.messages.at(-1).content);
      const translations = message.segments.map(segment => {
        const text = SAMPLES[segment.text];
        if (!text) throw new Error("Fixture has no translation for this text");
        return { id: segment.id, text };
      });
      requests++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] })); return;
    }
    const name = pathname === "/" ? "/options.html" : pathname;
    if (name === "/fixture.html") {
      const html = (await readFile(path.join(root, "dist/demo.html"), "utf8"))
        .replace('<script src="demo.js" type="module"></script>', '<script src="/fixture.js"></script>')
        .replace("交互示例 · 预置示例译文", "扩展集成测试页面")
        .replace('id="demo-toggle"', 'id="fixture-toggle" disabled');
      res.setHeader("Content-Type", types[".html"]); res.end(html); return;
    }
    if (name === "/fixture.js") {
      res.setHeader("Content-Type", types[".js"]);
      res.end(`document.querySelector("#add-paragraph").onclick=()=>{const p=document.createElement("p");p.textContent="New ideas arrive when we make room for them. Keep reading, and keep wondering.";document.querySelector("#dynamic-content").append(p);};`); return;
    }
    const file = name.endsWith(".zip") ? path.join(root, path.basename(name)) : path.resolve(root, "dist", "." + decodeURIComponent(name));
    const allowed = name.endsWith(".zip") ? file === path.join(root, "bilingual-reader-0.1.0.zip") : file.startsWith(path.join(root, "dist") + path.sep);
    if (!allowed) { res.writeHead(403); res.end(); return; }
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end("Not found"); }
});
server.listen(Number(process.env.BILINGUAL_READER_PORT || 43821), "127.0.0.1", async () => {
  const address = server.address();
  const info = { pid: process.pid, port: address.port, url: `http://127.0.0.1:${address.port}`, started: new Date().toISOString() };
  await writeFile(path.join(artifacts, "preview.json"), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
});
