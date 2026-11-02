import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

const isMac = process.platform === 'darwin';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f172a',
    ...(isMac
      ? // macOS：隐藏标题栏，红绿灯内嵌到自定义顶栏里（顶栏 CSS 留了 92px 让位）
        { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 20 } }
      : // Windows/Linux：用系统原生标题栏。
        // 不用 titleBarStyle:'hidden' + titleBarOverlay，是因为窗口控件会压在房间顶栏的
        // 「视频/白板/⏱/退出」按钮上，而这两个页面顶栏配色不一样，overlay 无法同时匹配
        { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Windows 上 F10/Alt 仍可能唤出菜单栏，直接隐藏
  if (!isMac) win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => win.show());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}
