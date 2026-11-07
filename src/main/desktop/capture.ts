import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopImage, DesktopWindow } from '../../shared/desktop';
import { desktopError } from './worker';

// PrintWindow cannot reliably render Chromium's accelerated content when covered.
// Compositor images are useful for inspection, but their invisible border crop
// differs across Windows versions. Never treat that crop as GDI input coordinates.
export async function captureDesktopWindow(window: DesktopWindow, native: DesktopImage): Promise<DesktopImage> {
  // The native WGC backend captures a specific HWND without foregrounding it.
  // Preserve its own geometry and coordinate qualification, including false.
  if (native.source === 'windows-graphics-capture') return native;
  if (!window.className.startsWith('Chrome_WidgetWin') || !window.nativeHandle) return { ...native, coordinateInputAvailable: native.coordinateInputAvailable === true, source: 'native-window', captureRect: { x: 0, y: 0, width: native.windowWidth, height: native.windowHeight } };
  const owned = BrowserWindow.getAllWindows().find(candidate => {
    const handle = candidate.getNativeWindowHandle();
    return (handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE())) === window.nativeHandle;
  });
  let image, captureRect: DesktopImage['captureRect'];
  if (owned) {
    try { image = await owned.capturePage(undefined, { stayHidden: true, stayAwake: true }); }
    catch { await delay(200); image = await owned.capturePage(undefined, { stayHidden: true, stayAwake: true }); }
    const rect = screen.dipToScreenRect(owned, owned.getContentBounds());
    // Coordinate qualification needs both physical native geometry and a crop
    // proven by this owned Electron window. A false PrintWindow coordinate flag
    // alone cannot distinguish unsupported DPI from unreliable Chromium pixels.
    if (native.physicalPixelsAvailable === true && native.windowX !== undefined && native.windowY !== undefined) {
      const x = rect.x - native.windowX, y = rect.y - native.windowY;
      if ([x, y, rect.width, rect.height].every(Number.isFinite) && x >= 0 && y >= 0 && rect.width > 0 && rect.height > 0 && x + rect.width <= native.windowWidth && y + rect.height <= native.windowHeight) captureRect = { x, y, width: rect.width, height: rect.height };
    }
  }
  else {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1600 }, fetchWindowIcons: false });
    image = sources.find(source => source.id.split(':')[1] === window.nativeHandle)?.thumbnail;
  }
  if (!image || image.isEmpty()) throw desktopError('DESKTOP_SCREENSHOT_UNAVAILABLE', '当前窗口无法生成画面，请检查窗口状态。');
  if (Math.max(image.getSize().width, image.getSize().height) > 1600) image = image.resize(image.getSize().width > image.getSize().height ? { width: 1600 } : { height: 1600 });
  return { ...native, ...image.getSize(), data: image.toJPEG(90).toString('base64'), mimeType: 'image/jpeg', captureRect, coordinateInputAvailable: Boolean(captureRect), source: 'compositor' };
}
