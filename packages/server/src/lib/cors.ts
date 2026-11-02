import type { Config } from '../config';

/**
 * CORS 判定。
 *
 * Electron 打包后渲染进程 origin 是 `file://`，浏览器会把它发成字面量 `null`；
 * 开发态是 `http://localhost:5173`。没有 Origin 头的请求（curl / 健康检查）一律放行。
 */
export function isAllowedOrigin(config: Config, origin: string | undefined): boolean {
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}
