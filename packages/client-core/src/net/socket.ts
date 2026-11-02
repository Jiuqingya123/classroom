import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@classroom/shared';

/** 客户端侧 socket：listen = 服务端发来的事件，emit = 我发给服务端的事件 */
export type AppClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SocketOptions {
  baseUrl: string;
  /** scope='rtc' 的 2 小时令牌 */
  token: string;
  /** 默认 true；需要先挂监听再连时传 false，然后手动 socket.connect() */
  autoConnect?: boolean;
}

export function createSocket(opts: SocketOptions): AppClientSocket {
  return io(opts.baseUrl, {
    path: '/socket.io',
    auth: { token: opts.token },
    autoConnect: opts.autoConnect ?? true,
    // 默认 polling → upgrade：经 nginx 也能跑通，比强制 websocket 稳
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.4,
    timeout: 8_000,
  });
}

/** socket.io 的 connect_error 消息晦涩，转成人话 */
export function describeSocketError(err: Error | null): string {
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('unauthorized')) return '登录凭证已失效，请重新登录';
  if (msg.includes('xhr') || msg.includes('timeout') || msg.includes('websocket error')) {
    return '连接服务器超时，请检查网络或服务器地址';
  }
  if (msg.includes('origin')) return '服务器拒绝了当前来源（CORS 白名单未包含此地址）';
  return err?.message ?? '连接失败';
}
