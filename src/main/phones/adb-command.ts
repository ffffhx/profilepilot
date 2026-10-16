/** Device commands from AOSP client/commandline.cpp. Server/transport changes
 * are dispatched separately; no caller can override the lease's selected device. */
export const adbDeviceCommands = new Set([
  "shell", "exec-in", "exec-out", "push", "pull", "sync", "install", "install-multiple", "install-multi-package", "uninstall",
  "logcat", "bugreport", "jdwp", "track-jdwp", "track-app", "forward", "reverse", "get-state", "get-serialno", "get-devpath", "features",
  "reboot", "root", "unroot", "remount", "disable-verity", "enable-verity", "sideload", "usb", "tcpip", "reconnect", "attach", "detach", "emu"
]);
export function adbCommand(args: string[]): { args: string[]; mode: "view" | "control"; connectionChange: boolean } {
  if (!args.length || args.length > 512 || args.some(a => typeof a !== "string" || a.includes("\0") || a.length > 32768)
      || args.reduce((n, a) => n + Buffer.byteLength(a), 0) > 131072) throw new Error("ADB 命令参数无效或过长。");
  const [command, ...tail] = args;
  if (command === "reconnect" && !(tail.length === 0 || tail.length === 1 && tail[0] === "device"))
    throw new Error("reconnect offline 会影响共享服务器，请使用 phone host。");
  if (!adbDeviceCommands.has(command) && !/^wait-for(?:(?:-usb|-local|-any))?-(?:device|recovery|rescue|sideload|bootloader|disconnect)(?:-(?:device|recovery|rescue|sideload|bootloader|disconnect))*$/.test(command))
    throw new Error("此命令不属于设备操作；服务器与连接管理请使用 ppilot phone 的专用入口。");
  let read = ["get-state", "get-serialno", "get-devpath", "features", "jdwp", "track-jdwp", "track-app", "pull", "bugreport"].includes(command) || command.startsWith("wait-for-");
  if (command === "logcat") read = tail.every(a => /^[A-Za-z0-9_./:@%+*=,\[\]-]+$/.test(a) && !["-c", "--clear", "-G", "--buffer-size", "-P", "--prune", "-f", "--file"].includes(a)
    && !/^(-[cGPf].+|--(?:clear|buffer-size|prune|file)=)/.test(a));
  if (["forward", "reverse"].includes(command)) read = tail.length === 1 && tail[0] === "--list";
  if (["shell", "exec-out"].includes(command)) {
    // Classification only. Execution retains the original argv and ADB shell
    // semantics. Unknown syntax always needs control, never a guessed read lease.
    const words = tail.length === 1 ? tail[0].trim().split(/\s+/) : tail;
    const literal = words.every(a => /^[A-Za-z0-9_./:@%+*=,\[\]-]+$/.test(a));
    const [op, ...rest] = words;
    read = literal && (
      op === "getprop" && rest.length <= 1 ||
      ["id", "uname", "ps", "pidof", "ls", "stat", "cat", "df", "du", "uptime"].includes(op) ||
      op === "date" && rest.every(a => ["-u", "+%s", "+%Y-%m-%d"].includes(a)) ||
      op === "wm" && rest.length === 1 && ["size", "density"].includes(rest[0]) ||
      op === "settings" && ["get", "list"].includes(rest[0]) && ["global", "secure", "system"].includes(rest[1]) && rest.length === (rest[0] === "get" ? 3 : 2) ||
      op === "pm" && (rest[0] === "path" && rest.length === 2 || rest[0] === "list" && ["packages", "features", "libraries", "users", "permissions"].includes(rest[1])) ||
      op === "service" && rest.join(" ") === "list" ||
      op === "dumpsys" && (rest[0] === "package" && rest.length === 2 && /^(?:android|[A-Za-z][\w]*(?:\.[\w]+)+)$/.test(rest[1]) || rest[0] === "window" && (rest.length === 1 || rest.length === 2 && rest[1] === "windows")) ||
      op === "screencap" && rest.join(" ") === "-p"
    );
  }
  return { args: [...args], mode: read ? "view" : "control", connectionChange: ["reboot", "root", "unroot", "usb", "tcpip", "reconnect", "detach", "sideload"].includes(command) || command === "remount" && tail.includes("-R") };
}
