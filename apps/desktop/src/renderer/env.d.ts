/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    /** 仅在 Electron 中存在；纯浏览器调试时为 undefined */
    desktop?: DesktopApi;
    /** Capacitor 原生壳注入；WebView 之外不存在 */
    Capacitor?: {
      isNativePlatform?: () => boolean;
      getPlatform?: () => string;
      Plugins?: Record<string, unknown>;
    };
  }
}

export {};
