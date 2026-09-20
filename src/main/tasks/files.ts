import { realpathSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserTask, TaskAttachment } from "../../shared/tasks";

export function canReadTaskFile(task: BrowserTask, file: string): boolean {
  const canonical = (value: string): string => {
    const resolved = realpathSync(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  try { const target = canonical(file); return [...task.attachments, ...(task.outputs || [])].some(entry => { try { return canonical(entry.path) === target; } catch { return false; } }); }
  catch { return false; }
}
export function taskFile(task: BrowserTask, id: string): TaskAttachment {
  const file = [...task.attachments, ...(task.outputs || [])].find(file => file.id === id);
  if (!file || !canReadTaskFile(task, file.path)) throw new Error("该文件未获当前任务授权，或已经不存在。");
  return file;
}
export function authorizeTaskRead(task: BrowserTask, file: string): { allowed: boolean } {
  if (!canReadTaskFile(task, file)) return { allowed: false };
  // The SDK sends PDFs as Anthropic document blocks, unsupported by some
  // compatible providers. Route every PDF through our paginated local reader.
  return { allowed: !/\.pdf$/i.test(file) && !/\.pdf$/i.test(realpathSync(file)) };
}

export async function readTaskDocument(task: BrowserTask, value: unknown): Promise<{ content: any[] }> {
  const input = z.object({ attachmentId: z.string(), startPage: z.number().int().min(1).default(1), count: z.number().int().min(1).max(3).default(1), images: z.boolean().default(false) }).parse(value);
  const file = taskFile(task, input.attachmentId);
  if (!/\.pdf$/i.test(file.name)) throw new Error("read_document 支持 PDF；表格使用 read_table，图片和文本使用 Read。");
  if (statSync(file.path).size > 50 * 1024 * 1024) throw new Error("PDF 超过 50 MB，请选择较小的文件。");
  const pdfjs: typeof import("pdfjs-dist") = await (new Function("return import('pdfjs-dist/legacy/build/pdf.mjs')")());
  const resourceRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const resourceDirectory = (name: string): string => path.join(resourceRoot, name).replace(/\\/g, "/") + "/";
  const loading = pdfjs.getDocument({ data: new Uint8Array(await readFile(file.path)),
    cMapUrl: resourceDirectory("cmaps"), cMapPacked: true,
    standardFontDataUrl: resourceDirectory("standard_fonts"),
    wasmUrl: resourceDirectory("wasm"),
    useSystemFonts: false, maxImageSize: 16000000, verbosity: 0 });
  try {
    const document = await loading.promise;
    if (input.startPage > document.numPages) throw new Error(`页码超出范围，该 PDF 共 ${document.numPages} 页。`);
    const pages: { page: number; text: string; truncated: boolean; image: boolean }[] = [];
    const images: any[] = [];
    const end = Math.min(document.numPages, input.startPage + input.count - 1);
    for (let index = input.startPage; index <= end; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      const image = input.images || text.length < 20;
      pages.push({ page: index, text: text.slice(0, 16000), truncated: text.length > 16000, image });
      if (image) {
        // Scanned pages become ordinary image blocks; never send a document
        // block. Images stay in memory and are not added to retained artifacts.
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
        const factory = document.canvasFactory as any;
        const surface = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({ canvasContext: surface.context, canvas: surface.canvas, viewport }).promise;
          images.push({ type: "text", text: `PDF 第 ${index} 页` }, { type: "image", mimeType: "image/png", data: surface.canvas.toBuffer("image/png").toString("base64") });
        } finally { factory.destroy(surface); }
      }
      page.cleanup();
    }
    return { content: [{ type: "text", text: JSON.stringify({ name: file.name, totalPages: document.numPages, nextPage: end < document.numPages ? end + 1 : null, pages }) }, ...images] };
  } finally { await loading.destroy(); }
}
export async function readTaskTable(task: BrowserTask, value: unknown): Promise<unknown> {
  const input = z.object({ attachmentId: z.string(), sheet: z.string().default(""), startRow: z.number().int().min(1).default(1), count: z.number().int().min(1).max(100).default(30) }).parse(value);
  const file = taskFile(task, input.attachmentId);
  const Excel = await import("exceljs");
  const workbook = new Excel.Workbook();
  if (/\.xlsx$/i.test(file.name)) await workbook.xlsx.readFile(file.path);
  else if (/\.csv$/i.test(file.name)) await workbook.csv.readFile(file.path);
  else throw new Error("支持 XLSX 和 CSV；PDF 请使用 read_document，图片和文本使用 Read。");
  const sheet = input.sheet ? workbook.getWorksheet(input.sheet) : workbook.worksheets[0];
  if (!sheet) throw new Error("工作表不存在。");
  const rows: string[][] = []; let characters = 0;
  for (let index = input.startRow; index < input.startRow + input.count && index <= sheet.rowCount; index++) {
    const row: string[] = [];
    for (let column = 1; column <= Math.min(sheet.columnCount, 100); column++) row.push(sheet.getRow(index).getCell(column).text.slice(0, 2000));
    const length = JSON.stringify(row).length;
    if (rows.length && characters + length > 50000) break;
    rows.push(row); characters += length;
  }
  const next = input.startRow + rows.length;
  return { sheets: workbook.worksheets.map(sheet => sheet.name), sheet: sheet.name, totalRows: sheet.rowCount,
    totalColumns: sheet.columnCount, includedColumns: Math.min(sheet.columnCount, 100), startRow: input.startRow,
    nextRow: next <= sheet.rowCount ? next : null, rows };
}

export function writeTaskResult(task: BrowserTask, artifactRoot: string, value: unknown): TaskAttachment {
  const input = z.object({ name: z.string().min(1).max(100), format: z.enum(["csv", "json", "markdown"]),
    columns: z.array(z.string().max(500)).max(100).default([]), rows: z.array(z.array(z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()])).max(100)).max(1000).default([]),
    text: z.string().max(1000000).default("") }).parse(value);
  const name = input.name.replace(/[^\p{L}\p{N} _.-]/gu, "_").replace(/[. ]+$/, "") || "result";
  const dir = path.resolve(artifactRoot, task.id);
  if (!dir.startsWith(path.resolve(artifactRoot) + path.sep)) throw new Error("无效的任务目录。");
  let content: string;
  if (input.format === "csv") {
    if (!input.columns.length || input.rows.some(row => row.length !== input.columns.length)) throw new Error("CSV 每行需要与列标题数量一致。");
    // Spreadsheet applications must not interpret page-supplied cells as formulas.
    const cell = (value: unknown): string => { let text = String(value ?? ""); if (/^\s*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    content = "\uFEFF" + [input.columns, ...input.rows].map(row => row.map(cell).join(",")).join("\r\n");
  } else if (input.format === "json") content = JSON.stringify({ columns: input.columns, rows: input.rows, notes: input.text }, null, 2);
  else content = input.text;
  const id = randomUUID(); const extension = input.format === "markdown" ? "md" : input.format;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, `${id}-${name}.${extension}`);
  writeFileSync(destination, content, { encoding: "utf8", mode: 0o600 });
  const file = { id, name: `${name}.${extension}`, path: destination, size: statSync(destination).size };
  (task.outputs ||= []).push(file);
  return file;
}
