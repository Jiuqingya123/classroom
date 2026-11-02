import { app, shell, type Session } from 'electron';
import { buildCsp } from './csp';

/**
 * 权限白名单。
 *
 * ⚠️ 必须包含 `display-capture`：Electron 45 里屏幕共享走的是这个名字，
 * 只放行 `media` 会导致共享请求被静默拒绝（表现为"点了共享完全没反应"）。
 */
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'fullscreen',
  'clipboard-sanitized-write',
  'notifications',
]);

export function hardenSession(ses: Session, extraOrigins: string[], serverUrl: string, isDev: boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  // CSP 走响应头而不是 <meta>：dev 与 prod 需要不同策略，注入式写法能一处集中管理
  const csp = buildCsp(serverUrl, isDev);
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });

  const allowed = new Set(extraOrigins);

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      const ok =
        url.startsWith('file://') ||
        [...allowed].some((o) => url.startsWith(o)) ||
        url.startsWith('devtools://');
      if (!ok) {
        event.preventDefault();
        if (/^https?:/.test(url)) void shell.openExternal(url);
      }
    });

    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}
