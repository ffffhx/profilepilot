import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function extractReleaseNotes(content, tag) {
  const version = tag === "latest" ? "Unreleased" : String(tag || "").replace(/^v/, "");
  if (!version) throw new Error("Release tag is required.");
  const lines = content.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+.+)?\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(`CHANGELOG.md does not contain a section for ${tag}.`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \[.+\](?:\s+-\s+.+)?\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  const body = section.replace(/^## /, "# ");
  if (!/^###\s+/m.test(body)) {
    throw new Error(`CHANGELOG.md section for ${tag} has no categorized release notes.`);
  }
  return `${body}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const [, , tag, outputPath = "release-notes.md"] = process.argv;
  if (!tag) {
    console.error("Usage: node scripts/extract-release-notes.mjs <tag|latest> [output-file]");
    process.exitCode = 2;
    return;
  }
  const changelogPath = path.resolve("CHANGELOG.md");
  const notes = extractReleaseNotes(await readFile(changelogPath, "utf8"), tag);
  await writeFile(path.resolve(outputPath), notes, "utf8");
  console.log(`Prepared release notes for ${tag} from ${changelogPath}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
