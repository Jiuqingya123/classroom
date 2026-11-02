import { app, BrowserWindow, Menu, session } from 'electron';
import { registerIpc } from './ipc';
import { registerDisplayMediaHandler } from './screen';
import { hardenSession } from './security';
import { createMainWindow } from './window';

/**
 * 默认连本机服务端，验收时先启动 server 即可开箱使用。
 * 部署到公网/局域网时用 CLASSROOM_SERVER_URL 覆盖，或构建时设置 MAIN_VITE_SERVER_URL。
 */
const DEFAULT_SERVER =
  (import.meta.env.MAIN_VITE_SERVER_URL as string | undefined)?.trim() || 'http://localhost:8080';
const SERVER_URL = (process.env['CLASSROOM_SERVER_URL'] ?? DEFAULT_SERVER).replace(/\/+$/, '');
const IS_DEV = !app.isPackaged;

app.setName('ClassRoom');

// Windows 任务栏分组、通知归属都靠这个 id，必须和 electron-builder 的 appId 一致
if (process.platform === 'win32') app.setAppUserModelId('com.hcf.classroom');

/**
 * 直连，不走系统代理。
 *
 * 客户端只需要访问我们自己那台服务器，但 Chromium 默认会读系统代理设置。
 * 用户开着 Clash / v2ray 之类的代理时，发往服务器 IP 的请求会被塞进代理，
 * 代理连不上就把上游失败包装成「502 Bad Gateway」返回 —— 界面上表现为
 * 「请求失败（502）」，而服务端日志里一条记录都没有，极难排查。
 */
app.commandLine.appendSwitch('no-proxy-server');

function bootstrap(): void {
  // Windows/Linux 不需要 Electron 默认菜单（Edit/View/Window），留着只是干扰
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  const extraOrigins = [SERVER_URL];
  if (process.env['ELECTRON_RENDERER_URL']) extraOrigins.push(process.env['ELECTRON_RENDERER_URL']);

  hardenSession(session.defaultSession, extraOrigins, SERVER_URL, IS_DEV);
  registerDisplayMediaHandler(session.defaultSession);
  registerIpc({ serverUrl: SERVER_URL, isDev: IS_DEV });
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

// 单实例：第二次启动直接把已有窗口叫到前面，避免同一账号开出两条 Mesh 连接
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(bootstrap);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
