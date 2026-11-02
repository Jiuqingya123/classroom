import { ApiClient } from '@classroom/client-core';
import { runtime } from './config';

/**
 * access token 的持有者与刷新回调。
 * 单独放一个可变对象，避免 api.ts 与 store 互相 import 形成环。
 */
export const tokenHolder: {
  access: string | null;
  refresh: (() => Promise<string | null>) | null;
  onAuthLost: (() => void) | null;
} = {
  access: null,
  refresh: null,
  onAuthLost: null,
};

let client: ApiClient | null = null;

export function getApi(): ApiClient {
  if (!client) {
    client = new ApiClient({
      baseUrl: runtime.serverUrl,
      getAccessToken: () => tokenHolder.access,
      refreshAccessToken: async () => {
        if (!tokenHolder.refresh) return null;
        const next = await tokenHolder.refresh();
        if (!next) tokenHolder.onAuthLost?.();
        return next;
      },
    });
  }
  return client;
}

/** 服务器地址变化时（切换环境）需要重建客户端 */
export function resetApi(): void {
  client = null;
}
