import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { TaskSkillDefinition, TaskSkillRun, TaskSkillSelection } from "../../shared/task-skills";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const taskSkillSelectionSchema = z.object({ id: identifier, parameters: z.record(z.string().max(80), z.string().max(6000)).refine(value => Object.keys(value).length <= 30, "Skill 参数过多") }).strict();
const definitionSchema = z.object({
  schemaVersion: z.literal(1), id: identifier, version: z.string().max(60).regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
  title: z.string().min(1).max(100), description: z.string().min(1).max(600), goal: z.string().min(1).max(6000),
  inputs: z.array(z.object({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), label: z.string().min(1).max(100), type: z.enum(["text", "textarea", "select"]), required: z.boolean().optional(), placeholder: z.string().max(500).optional(), default: z.string().max(6000).optional(), options: z.array(z.string().min(1).max(200)).min(1).max(30).optional() }).strict()).max(30)
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const field of value.inputs) {
    if (keys.has(field.key) || (field.type === "select" && (!field.options || (field.default !== undefined && !field.options.includes(field.default))))) context.addIssue({ code: "custom", message: "重复参数或无效选项" });
    keys.add(field.key);
  }
});

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
export function taskSkillRoots(): string[] {
  if (process.env.PROFILEPILOT_SKILL_ROOTS) return process.env.PROFILEPILOT_SKILL_ROOTS.split(path.delimiter).filter(Boolean).map(value => path.resolve(value));
  return [path.join(os.homedir(), ".agents", "skills"), path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills"), path.join(os.homedir(), ".claude", "skills")];
}
type Entry = { definition: TaskSkillDefinition; root: string };
function discover(roots = taskSkillRoots()): { entries: Entry[]; issues: string[] } {
  const entries: Entry[] = [], issues: string[] = [], seenRoots = new Set<string>(), ids = new Set<string>();
  for (const directory of roots) {
    if (!existsSync(directory)) continue;
    let names: string[];
    try { names = readdirSync(directory).sort(); } catch { issues.push(`无法读取 Skill 目录：${directory}`); continue; }
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (!existsSync(path.join(candidate, "agents", "profilepilot.json"))) continue;
      try {
        const root = realpathSync(candidate), key = process.platform === "win32" ? root.toLowerCase() : root;
        if (seenRoots.has(key)) continue;
        seenRoots.add(key);
        const manifest = realpathSync(path.join(root, "agents", "profilepilot.json"));
        const instructions = realpathSync(path.join(root, "SKILL.md"));
        if (!within(root, manifest) || !within(root, instructions) || statSync(manifest).size > 64000 || statSync(instructions).size > 64000) throw new Error("入口文件超出目录或体积限制");
        const definition = definitionSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
        const markdown = readFileSync(instructions, "utf8");
        const skillName = markdown.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m)?.[1];
        if (!markdown.startsWith("---") || skillName !== definition.id || definition.id !== name) throw new Error("目录、SKILL.md 和表单的名称不一致");
        if (ids.has(definition.id)) { issues.push(`同名 Skill ${definition.id} 使用较优先目录中的版本：${candidate} 未加载。`); continue; }
        ids.add(definition.id); entries.push({ definition, root });
      } catch (error) { issues.push(`${name} 未加载：${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return { entries, issues };
}
export function taskSkillCatalog(roots?: string[]): { skills: TaskSkillDefinition[]; issues: string[] } {
  const result = discover(roots);
  return { skills: result.entries.map(entry => entry.definition), issues: result.issues };
}

/** Capture the selected version before queueing. Running tasks do not read mutable global skill files. */
export function captureTaskSkill(selection: TaskSkillSelection, storeRoot: string, roots?: string[]): TaskSkillRun {
  const parsed = taskSkillSelectionSchema.parse(selection);
  const entry = discover(roots).entries.find(item => item.definition.id === parsed.id);
  if (!entry) throw new Error(`Skill ${parsed.id} 不可用，请刷新模板或重新安装。`);
  const parameters: Record<string, string> = {};
  for (const key of Object.keys(parsed.parameters)) if (!entry.definition.inputs.some(field => field.key === key)) throw new Error(`未知 Skill 参数：${key}`);
  for (const field of entry.definition.inputs) {
    const value = parsed.parameters[field.key] ?? field.default ?? "";
    if (field.required && !value.trim()) throw new Error(`请填写「${field.label}」。`);
    if (field.type === "select" && value && !field.options?.includes(value)) throw new Error(`「${field.label}」的选项无效。`);
    parameters[field.key] = value;
  }
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  let size = 0;
  const visit = (relative: string) => {
    const file = realpathSync(path.join(entry.root, relative));
    if (!within(entry.root, file)) throw new Error("Skill 资源链接指向目录之外");
    const stat = statSync(file);
    if (stat.isDirectory()) {
      if (directories.has(file)) throw new Error("Skill 资源目录包含循环或重复链接");
      directories.add(file);
      for (const name of readdirSync(file).sort()) {
        if (name.startsWith(".") || name === "__pycache__" || name === "node_modules") continue;
        if (path.relative(entry.root, file).split(path.sep).length > 8) throw new Error("Skill 资源目录过深");
        visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      size += stat.size;
      if (files.size >= 200 || size > 2 * 1024 * 1024) throw new Error("Skill 资源超过 200 个文件或 2 MB，请将运行数据放在任务目录。");
      files.set(relative, readFileSync(file));
    } else throw new Error("Skill 包含不支持的资源类型");
  };
  for (const file of ["SKILL.md", "agents", "references", "scripts", "assets", "requirements.txt"]) if (existsSync(path.join(entry.root, file))) visit(file);
  const hash = createHash("sha256");
  for (const [file, bytes] of files) hash.update(file.split(path.sep).join("/")).update("\0").update(bytes).update("\0");
  const digest = hash.digest("hex"), root = path.join(storeRoot, "skill-snapshots", `${parsed.id}-${digest}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of files) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!existsSync(target)) writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    else if (!readFileSync(target).equals(bytes)) throw new Error("Skill 快照内容已改变，请保留现场并检查任务存储。");
  }
  return { id: parsed.id, title: entry.definition.title, version: entry.definition.version, parameters, digest, root, instructions: files.get("SKILL.md")!.toString("utf8") };
}

export function canReadTaskSkill(skill: TaskSkillRun | undefined, file: string): boolean {
  if (!skill) return false;
  try { return within(realpathSync(skill.root), realpathSync(file)) && statSync(file).isFile(); } catch { return false; }
}
