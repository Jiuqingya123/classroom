/**
 * 渲染进程 CSP。单独抽成纯函数，便于在没有 Electron 的环境里做回归测试。
 */
export function buildCsp(serverUrl: string, isDev: boolean): string {
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  const connect = ["'self'", serverUrl, wsUrl];
  if (isDev) {
    connect.push('ws://localhost:*', 'http://localhost:*');
  }

  const script = isDev ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'"];

  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    // 不再放行任意 https/wss：渲染进程只需要连自己的服务器和 WebSocket
    `connect-src ${connect.join(' ')}`,
    // 课件背景图/白板图片走带签名的服务器 URL，不放行就只剩空白页
    `img-src 'self' data: blob: ${serverUrl}`,
    "media-src 'self' blob: mediastream:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
  ].join('; ');
}
