import type { PhoneDevice } from "./phones";

export interface DefaultProfile { id: string; name: string; }
export interface DefaultPhone extends DefaultProfile { hardwareId?: string; statusDeviceId?: string; udid?: string; }
export interface DefaultPhoneStatus { saved: DefaultPhone | null; deviceId: string | null; available: boolean; }

export function phoneMatchesDefault(device: PhoneDevice, saved: DefaultPhone | null | undefined): boolean {
  if (!saved) return false;
  // Stable identities take precedence over a transport address that may be reused.
  if (saved.hardwareId) return device.hardwareId === saved.hardwareId;
  if (saved.udid) return device.iphone?.udid === saved.udid;
  if (saved.statusDeviceId) return (device.state?.statusDeviceId || device.registration?.deviceId || device.cloud?.report?.deviceId) === saved.statusDeviceId;
  return device.id === saved.id;
}

export function defaultPhoneStatus(devices: PhoneDevice[], saved: DefaultPhone | null): DefaultPhoneStatus {
  const matches = devices.filter(device => phoneMatchesDefault(device, saved));
  const device = matches.find(item => item.id === saved?.id && item.connection === "device")
    || matches.find(item => item.connection === "device") || matches.find(item => item.id === saved?.id) || matches[0];
  return { saved, deviceId: device?.id || null, available: device?.connection === "device" };
}
