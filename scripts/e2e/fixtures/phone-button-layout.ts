import { openPhoneWireless } from "../../../src/renderer/phone-wireless";
import { openPhoneEmulator } from "../../../src/renderer/phone-emulator";
import { openIphoneAdd } from "../../../src/renderer/iphone";
Object.assign(window, { phoneButtonLayout: {
  wireless: (id?: string) => openPhoneWireless(() => {}, id),
  emulator: (mode: "connect" | "create") => openPhoneEmulator(() => {}, mode),
  iphone: () => openIphoneAdd(() => {})
} });
