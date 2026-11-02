const envUrl = import.meta.env['VITE_SERVER_URL'] as string | undefined;

const SERVER_KEY = 'classroom.serverUrl';
const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const isElectron = typeof window !== 'undefined' && !!window.desktop;
const isAndroid = !isElectron && /Android/i.test(ua);

function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function readStoredServerUrl(): string | null {
  try {
    return localStorage.getItem(SERVER_KEY);
  } catch {
    return null;
  }
}

/**
 * 运行时可改的配置。
 * 桌面端由主进程下发服务器地址；浏览器/Android 端用 localStorage，
 * 默认值优先取构建时注入的 VITE_SERVER_URL。
 * Android 模拟器访问宿主机要用 10.0.2.2，真机需在登录页改成电脑局域网 IP。
 */
export const runtime: {
  serverUrl: string;
  isElectron: boolean;
  isAndroid: boolean;
} = {
  serverUrl: normalizeServerUrl(
    readStoredServerUrl() ?? envUrl ?? (isAndroid ? 'http://10.0.2.2:8080' : 'http://localhost:8080'),
  ),
  isElectron,
  isAndroid,
};

export function saveServerUrl(raw: string): string {
  const url = normalizeServerUrl(raw);
  if (!/^https?:\/\/[^\s/]+/i.test(url)) {
    throw new Error('服务器地址需以 http:// 或 https:// 开头');
  }
  runtime.serverUrl = url;
  try {
    localStorage.setItem(SERVER_KEY, url);
  } catch {
    /* 隐私模式下写入失败，本次运行仍然生效 */
  }
  return url;
}

export async function initRuntime(): Promise<void> {
  if (!window.desktop) return;
  try {
    const info = await window.desktop.appInfo();
    if (info.serverUrl) runtime.serverUrl = normalizeServerUrl(info.serverUrl);
  } catch {
    /* 用默认值 */
  }
}
