/**
 * Capacitor 原生壳的最小桥接。
 *
 * 这里刻意不 import @capacitor/*：同一份渲染代码还要跑在 Electron 和普通浏览器里，
 * 用 window.Capacitor 做运行时探测可以避免把移动端依赖带进桌面构建。
 */

export interface NativePermissionState {
  camera: string;
  microphone: string;
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

export function isNativeApp(): boolean {
  return !!window.Capacitor?.isNativePlatform?.();
}

export function nativePlatform(): string | null {
  return isNativeApp() ? (window.Capacitor?.getPlatform?.() ?? null) : null;
}

export async function requestNativeMediaPermissions(): Promise<NativePermissionState | null> {
  if (!isNativeApp()) return null;
  const plugin = window.Capacitor?.Plugins?.['MediaPermissions'] as
    | { request?: () => Promise<NativePermissionState> }
    | undefined;
  if (!plugin?.request) return null;
  try {
    return await plugin.request();
  } catch {
    return null;
  }
}

/** 状态栏配色跟应用主题保持一致；Android 15 强制边到边时失败也不影响页面 */
export function initNativeChrome(): void {
  if (!isNativeApp()) return;
  const statusBar = window.Capacitor?.Plugins?.['StatusBar'] as
    | {
        setStyle?: (o: { style: string }) => Promise<void>;
        setBackgroundColor?: (o: { color: string }) => Promise<void>;
        setOverlaysWebView?: (o: { overlay: boolean }) => Promise<void>;
      }
    | undefined;
  if (!statusBar) return;
  const ignore = (p?: Promise<void>): void => {
    void p?.catch(() => undefined);
  };
  ignore(statusBar.setOverlaysWebView?.({ overlay: false }));
  ignore(statusBar.setStyle?.({ style: 'LIGHT' }));
  ignore(statusBar.setBackgroundColor?.({ color: '#ffffff' }));
}
