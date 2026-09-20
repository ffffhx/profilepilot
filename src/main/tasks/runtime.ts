import { existsSync } from "node:fs";

export function sdkExecutable(command: string, runtime = process.execPath, exists: (file: string) => boolean = existsSync): string {
  if (command === "node") return runtime;
  // OS process launch cannot traverse Electron's virtual ASAR filesystem.
  // electron-builder unpacks native SDK binaries, but module resolution still
  // returns the virtual path. Resolve the corresponding physical executable.
  const unpacked = command.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  return unpacked !== command && exists(unpacked) ? unpacked : command;
}
