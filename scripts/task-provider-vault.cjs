// Run only as an Electron helper; credentials travel over private child IPC.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setName("ProfilePilot");
app.whenReady().then(() => {
  try {
    if (!process.send) throw new Error("The provider helper requires private IPC.");
    const root = process.env.PP_TASK_PROVIDER_ROOT || path.join(require("../dist/main/fs-util").defaultDataDir(), "browser-tasks");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("System credential protection unavailable.");
    const settings = JSON.parse(fs.readFileSync(path.join(root, "tasks.json"), "utf8")).settings;
    const apiKey = safeStorage.decryptString(fs.readFileSync(path.join(root, "credentials.bin")));
    const credentials = { settings, apiKey };
    if (process.env.PP_TASK_PROVIDER_INCLUDE_JEV === "1") {
      const provider = settings.jevProvider || (settings.hasJevApiKey ? "vercel" : "typesafe");
      const vault = path.join(root, provider === "typesafe" ? "jev-typesafe-credentials.bin" : "jev-credentials.bin");
      if (fs.existsSync(vault)) credentials.jevApiKey = safeStorage.decryptString(fs.readFileSync(vault));
    }
    process.send(credentials, () => app.quit());
  } catch (error) { process.send?.({ error: error.message }, () => app.quit()); }
});
