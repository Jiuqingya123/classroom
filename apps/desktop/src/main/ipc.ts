import { app, ipcMain, shell, systemPreferences } from 'electron';
import { IPC, type AppInfo, type MediaAccessResult, type ScreenSourceList } from '../shared/ipc';
import { listScreenSources, setPendingScreenSource } from './screen';
import { loadRefreshToken, saveRefreshToken } from './store';

/** 各平台的隐私设置深链。Windows 的设置页 URI 不能带查询串，点到为止 */
async function openSettingsPage(kind: 'camera' | 'microphone' | 'screen'): Promise<void> {
  const macUri: Record<typeof kind, string> = {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  };
  const winUri: Record<typeof kind, string> = {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone',
    screen: 'ms-settings:privacy-broadcastglobalsettings',
  };

  try {
    if (process.platform === 'darwin') await shell.openExternal(macUri[kind]);
    else if (process.platform === 'win32') await shell.openExternal(winUri[kind]);
  } catch {
    /* 设置页打不开不是致命错误，用户可以自己去找 */
  }
}

export function registerIpc(opts: { serverUrl: string; isDev: boolean }): void {
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      // 打包后没有 npm_package_version，用 app.getVersion() 读 package.json 的 version
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      serverUrl: opts.serverUrl,
      isDev: opts.isDev,
    }),
  );

  ipcMain.handle(IPC.getRefreshToken, () => loadRefreshToken());

  ipcMain.handle(IPC.setRefreshToken, (_e, token: string | null) => {
    saveRefreshToken(typeof token === 'string' && token.length > 0 ? token : null);
  });

  ipcMain.handle(IPC.requestMediaAccess, async (_e, kind: 'camera' | 'microphone'): Promise<MediaAccessResult> => {
    if (process.platform !== 'darwin') return 'unsupported';
    const media = kind === 'camera' ? 'camera' : 'microphone';
    const status = systemPreferences.getMediaAccessStatus(media);
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    if (status === 'restricted') return 'restricted';
    const granted = await systemPreferences.askForMediaAccess(media);
    return granted ? 'granted' : 'denied';
  });

  // 屏幕录制权限：macOS 15+ 授权后必须重启 App 才真正生效
  ipcMain.handle(IPC.screenAccessStatus, () => {
    if (process.platform !== 'darwin') return 'unsupported';
    return systemPreferences.getMediaAccessStatus('screen');
  });

  ipcMain.handle(IPC.openScreenSettings, async () => {
    await openSettingsPage('screen');
  });

  ipcMain.handle(IPC.openMediaSettings, async (_e, kind: 'camera' | 'microphone' | 'screen') => {
    await openSettingsPage(kind);
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    // 只放行 http(s) 与系统设置协议，避免被渲染进程当成万能执行器
    if (/^https?:\/\//.test(url) || url.startsWith('x-apple.systempreferences:') || url.startsWith('ms-settings:')) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(IPC.listScreenSources, (): Promise<ScreenSourceList> => listScreenSources());

  ipcMain.handle(IPC.pickScreenSource, (_e, id: string) => {
    setPendingScreenSource(String(id));
  });
}
