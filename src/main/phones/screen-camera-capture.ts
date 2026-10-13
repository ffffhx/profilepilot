import { desktopCapturer, systemPreferences } from "electron";
import type { CameraCapture } from "./screen-camera";

export function desktopCameraCapture(): CameraCapture {
  const get = async () => {
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
      throw new Error("请在 macOS 系统设置 → 隐私与安全性 → 屏幕录制中允许 ProfilePilot，再重新打开应用");
    }
    return desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 1920, height: 1920 }, fetchWindowIcons: false });
  };
  return {
    async sources() {
      return (await get()).filter(source => !source.thumbnail.isEmpty()).map(source => ({ id: source.id, name: source.name,
        thumbnail: source.thumbnail.resize({ width: 480 }).toDataURL() }));
    },
    async capture(id, crop) {
      const source = (await get()).find(source => source.id === id);
      if (!source || source.thumbnail.isEmpty()) throw new Error("选定的电脑窗口已关闭或无法采集，请重新选择画面");
      let image = source.thumbnail;
      if (crop) {
        const size = image.getSize();
        const x = Math.floor(crop.x * size.width), y = Math.floor(crop.y * size.height);
        const width = Math.min(size.width - x, Math.max(1, Math.round(crop.width * size.width)));
        const height = Math.min(size.height - y, Math.max(1, Math.round(crop.height * size.height)));
        image = image.crop({ x, y, width, height });
      }
      if (Math.max(image.getSize().width, image.getSize().height) > 1600) image = image.resize(image.getSize().width > image.getSize().height ? { width: 1600 } : { height: 1600 });
      return image.toJPEG(92).toString("base64");
    }
  };
}
