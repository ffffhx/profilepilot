import { phoneActive, type PhoneDevice } from "./phones";

export interface PhoneDeviceGroup { device: PhoneDevice; routes: PhoneDevice[]; }

function priority(device: PhoneDevice): number {
  if (device.connection !== "device") return device.connection === "unauthorized" ? 1 : 0;
  if (device.companion !== "ready") return 2;
  return 3;
}

/** Presentation only: commands continue to address an explicit transport ID. */
export function groupPhoneDevices(devices: PhoneDevice[], preferredId = ""): PhoneDeviceGroup[] {
  const hardwareByInstance = new Map<string, Set<string>>();
  for (const device of devices) {
    if (!device.hardwareId || !device.state?.instanceId) continue;
    const ids = hardwareByInstance.get(device.state.instanceId) || new Set<string>();
    ids.add(device.hardwareId); hardwareByInstance.set(device.state.instanceId, ids);
  }
  const groups = new Map<string, PhoneDevice[]>();
  for (const device of devices) {
    const instance = device.state?.instanceId;
    const hardware = instance ? hardwareByInstance.get(instance) : undefined;
    const identity = device.hardwareId || (hardware?.size === 1 ? [...hardware][0] : undefined);
    // Names/models are not identities. Conflicting hardware IDs stay separate.
    const key = identity ? `hardware:${identity}` : instance ? `instance:${instance}` : `route:${device.id}`;
    const routes = groups.get(key) || []; routes.push(device); groups.set(key, routes);
  }
  return [...groups.values()].map(routes => ({ routes, device: [...routes].sort((a, b) => {
    const rank = priority(b) - priority(a);
    if (rank) return rank;
    if (a.connection === "device" && a.companion === "ready" && b.companion === "ready" && a.state?.instanceId === b.state?.instanceId) {
      const generation = (b.state?.generation || 0) - (a.state?.generation || 0);
      if (generation) return generation;
    }
    const occupied = (device: PhoneDevice) => phoneActive(device) || device.connection === "device" && device.companion === "ready" && device.state?.phase === "paused";
    if (occupied(a) !== occupied(b)) return Number(occupied(b)) - Number(occupied(a));
    return Number(b.id === preferredId) - Number(a.id === preferredId);
  })[0] }));
}
