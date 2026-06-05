import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 5177);
const HOST = process.env.HOST || "127.0.0.1";
const APP_TITLE = "Codex Chrome Profile Manager";
const DATA_DIR = process.env.CPM_DATA_DIR || defaultDataDir();
const PROFILES_DIR = path.join(DATA_DIR, "profiles");
const REGISTRY_PATH = path.join(DATA_DIR, "profiles.json");
const STATIC_DIR = path.join(__dirname, "public");

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_TITLE);
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), APP_TITLE);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codex-chrome-profile-manager");
}

async function ensureStore() {
  await fs.mkdir(PROFILES_DIR, { recursive: true });

  try {
    await fs.access(REGISTRY_PATH);
  } catch {
    await saveRegistry({ profiles: [] });
  }
}

async function loadRegistry() {
  await ensureStore();

  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.profiles)) {
      return { profiles: [] };
    }

    return parsed;
  } catch (error) {
    const backup = `${REGISTRY_PATH}.broken-${Date.now()}`;
    try {
      await fs.rename(REGISTRY_PATH, backup);
    } catch {
      // If a backup cannot be written, start clean and let the UI surface state.
    }
    return { profiles: [] };
  }
}

async function saveRegistry(registry) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${REGISTRY_PATH}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, REGISTRY_PATH);
}

function makeSlug(name) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "profile";
}

function publicProfile(profile, runtime) {
  const profilePath = path.join(PROFILES_DIR, profile.dirName);
  const pids = runtime.get(profilePath) || [];

  return {
    id: profile.id,
    name: profile.name,
    dirName: profile.dirName,
    path: profilePath,
    createdAt: profile.createdAt,
    lastLaunchedAt: profile.lastLaunchedAt || null,
    running: pids.length > 0,
    pids
  };
}

async function getRuntimeByPath(profilePaths) {
  const runtime = new Map();

  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      maxBuffer: 1024 * 1024 * 8
    });

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        continue;
      }

      const pid = Number(match[1]);
      const command = match[2];
      for (const profilePath of profilePaths) {
        if (!command.includes("--user-data-dir=") || !command.includes(profilePath)) {
          continue;
        }

        if (!runtime.has(profilePath)) {
          runtime.set(profilePath, []);
        }
        runtime.get(profilePath).push(pid);
      }
    }
  } catch {
    return runtime;
  }

  return runtime;
}

async function getState() {
  const registry = await loadRegistry();
  const profilePaths = registry.profiles.map((profile) => path.join(PROFILES_DIR, profile.dirName));
  const runtime = await getRuntimeByPath(profilePaths);
  const profiles = registry.profiles
    .map((profile) => publicProfile(profile, runtime))
    .sort((a, b) => {
      const aTime = a.lastLaunchedAt || a.createdAt;
      const bTime = b.lastLaunchedAt || b.createdAt;
      return bTime.localeCompare(aTime);
    });

  const runningProfiles = profiles.filter((profile) => profile.running);
  const lastLaunchedProfile = profiles.find((profile) => profile.lastLaunchedAt) || null;

  return {
    appTitle: APP_TITLE,
    dataDir: DATA_DIR,
    profilesDir: PROFILES_DIR,
    profiles,
    runningProfiles,
    currentProfile: runningProfiles[0] || lastLaunchedProfile,
    chromeLauncher: getLauncherLabel()
  };
}

function getLauncherLabel() {
  if (process.env.CHROME_BINARY) {
    return process.env.CHROME_BINARY;
  }

  if (process.platform === "darwin") {
    return process.env.CHROME_APP_NAME || "Google Chrome";
  }

  if (process.platform === "win32") {
    return "chrome";
  }

  return "google-chrome";
}

function findProfile(registry, id) {
  return registry.profiles.find((profile) => profile.id === id) || null;
}

async function createProfile(input) {
  const name = String(input.name || "").trim();
  if (!name || name.length > 80) {
    throw httpError(400, "Profile name must be 1-80 characters.");
  }

  const registry = await loadRegistry();
  const id = randomUUID();
  const dirName = `${makeSlug(name)}-${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  const profile = {
    id,
    name,
    dirName,
    createdAt: now,
    lastLaunchedAt: null
  };

  await fs.mkdir(path.join(PROFILES_DIR, dirName), { recursive: false });
  registry.profiles.push(profile);
  await saveRegistry(registry);

  return profile;
}

async function launchProfile(id) {
  const registry = await loadRegistry();
  const profile = findProfile(registry, id);
  if (!profile) {
    throw httpError(404, "Profile not found.");
  }

  const profilePath = path.join(PROFILES_DIR, profile.dirName);
  await fs.mkdir(profilePath, { recursive: true });

  const args = [`--user-data-dir=${profilePath}`, "--no-first-run"];

  if (process.env.CHROME_BINARY) {
    launchDetached(process.env.CHROME_BINARY, args);
  } else if (process.platform === "darwin") {
    await execFileAsync("open", ["-na", process.env.CHROME_APP_NAME || "Google Chrome", "--args", ...args]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", "chrome", ...args]);
  } else {
    launchDetached("google-chrome", args);
  }

  profile.lastLaunchedAt = new Date().toISOString();
  await saveRegistry(registry);

  return profile;
}

function launchDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function openProfileFolder(id) {
  const registry = await loadRegistry();
  const profile = findProfile(registry, id);
  if (!profile) {
    throw httpError(404, "Profile not found.");
  }

  const profilePath = path.join(PROFILES_DIR, profile.dirName);
  await fs.mkdir(profilePath, { recursive: true });

  if (process.platform === "darwin") {
    await execFileAsync("open", [profilePath]);
  } else if (process.platform === "win32") {
    await execFileAsync("explorer", [profilePath]);
  } else {
    await execFileAsync("xdg-open", [profilePath]);
  }

  return profile;
}

async function deleteProfile(id) {
  const registry = await loadRegistry();
  const profile = findProfile(registry, id);
  if (!profile) {
    throw httpError(404, "Profile not found.");
  }

  const state = await getState();
  const current = state.profiles.find((item) => item.id === id);
  if (current?.running) {
    throw httpError(409, "Close this Chrome profile before deleting it.");
  }

  const profilePath = path.join(PROFILES_DIR, profile.dirName);
  const trashPath = await moveToTrash(profilePath, profile.dirName);
  const nextProfiles = registry.profiles.filter((item) => item.id !== id);
  await saveRegistry({ profiles: nextProfiles });

  return {
    deletedProfile: profile,
    trashPath
  };
}

async function moveToTrash(sourcePath, dirName) {
  try {
    await fs.access(sourcePath);
  } catch {
    return null;
  }

  const trashRoot =
    process.platform === "darwin"
      ? path.join(os.homedir(), ".Trash")
      : path.join(DATA_DIR, "trash");
  await fs.mkdir(trashRoot, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let targetPath = path.join(trashRoot, `${dirName}-${stamp}`);
  let counter = 1;
  while (await exists(targetPath)) {
    targetPath = path.join(trashRoot, `${dirName}-${stamp}-${counter}`);
    counter += 1;
  }

  await fs.rename(sourcePath, targetPath);
  return targetPath;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function parseJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 32) {
      throw httpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON body.");
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

async function sendStatic(request, response, pathname) {
  const staticPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.normalize(path.join(STATIC_DIR, staticPath));

  if (!resolved.startsWith(STATIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    response.writeHead(200, {
      "content-type": contentType(resolved),
      "cache-control": "no-cache"
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, await getState());
    return;
  }

  if (request.method === "POST" && pathname === "/api/profiles") {
    const input = await parseJsonBody(request);
    await createProfile(input);
    sendJson(response, 201, await getState());
    return;
  }

  const profileAction = pathname.match(/^\/api\/profiles\/([^/]+)(?:\/([^/]+))?$/);
  if (profileAction) {
    const id = decodeURIComponent(profileAction[1]);
    const action = profileAction[2];

    if (request.method === "POST" && action === "launch") {
      await launchProfile(id);
      sendJson(response, 200, await getState());
      return;
    }

    if (request.method === "POST" && action === "open-folder") {
      await openProfileFolder(id);
      sendJson(response, 200, await getState());
      return;
    }

    if (request.method === "DELETE" && !action) {
      const result = await deleteProfile(id);
      sendJson(response, 200, { ...result, state: await getState() });
      return;
    }
  }

  if (request.method === "GET") {
    await sendStatic(request, response, pathname);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(response, statusCode, {
      error: error.message || "Internal server error"
    });
  }
});

await ensureStore();

server.listen(PORT, HOST, () => {
  console.log(`${APP_TITLE} running at http://${HOST}:${PORT}`);
  console.log(`Profile data: ${DATA_DIR}`);
});
