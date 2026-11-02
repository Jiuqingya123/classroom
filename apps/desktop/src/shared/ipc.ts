/** 主进程 ↔ 渲染进程之间的 IPC 契约。两边都从这里导入，避免通道名写错。 */

export const IPC = {
  appInfo: 'desktop:app-info',
  getRefreshToken: 'desktop:get-refresh-token',
  setRefreshToken: 'desktop:set-refresh-token',
  requestMediaAccess: 'desktop:request-media-access',
  screenAccessStatus: 'desktop:screen-access-status',
  openScreenSettings: 'desktop:open-screen-settings',
  openMediaSettings: 'desktop:open-media-settings',
  openExternal: 'desktop:open-external',
  listScreenSources: 'desktop:list-screen-sources',
  pickScreenSource: 'desktop:pick-screen-source',
} as const;

export interface ScreenSource {
  id: string;
  name: string;
  /** 320×180 缩略图的 data URL，用于选择器预览 */
  thumbnail: string | null;
  isScreen: boolean;
}

export interface ScreenSourceList {
  /** macOS 未授予「屏幕录制」权限时，getSources 会返回空列表 */
  hasPermission: boolean;
  platform: string;
  sources: ScreenSource[];
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  /** 默认的服务器地址（来自构建时注入的 VITE_SERVER_URL） */
  serverUrl: string;
  isDev: boolean;
}

export type MediaAccessResult = 'granted' | 'denied' | 'restricted' | 'unknown' | 'unsupported';

/** preload 通过 contextBridge 暴露到 window.desktop 的全部能力 */
export interface DesktopApi {
  readonly platform: string;
  appInfo(): Promise<AppInfo>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string | null): Promise<void>;
  requestMediaAccess(kind: 'camera' | 'microphone'): Promise<MediaAccessResult>;
  screenAccessStatus(): Promise<string>;
  openScreenSettings(): Promise<void>;
  /** 直接跳到系统的相机/麦克风/屏幕录制隐私设置页 */
  openMediaSettings(kind: 'camera' | 'microphone' | 'screen'): Promise<void>;
  openExternal(url: string): Promise<void>;
  listScreenSources(): Promise<ScreenSourceList>;
  /** 指定下一次 getDisplayMedia() 使用哪个源 */
  pickScreenSource(id: string): Promise<void>;
}
