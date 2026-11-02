import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData } from '@classroom/shared';
import { SIGNAL_RATE, WB_OP_RATE } from '@classroom/shared';
import { createBucket, type Bucket } from '../lib/bucket';

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** 只存在于进程内的 per-socket 状态，不放进 socket.data（那里只放可广播的身份信息） */
export interface SocketCtx {
  wbOp: Bucket;
  /** 全量重同步会序列化整页元素，必须限流，避免被当成放大攻击入口 */
  wbSync: Bucket;
  /** 绘制中的预览笔迹 + 光标共用，频率远高于正式 op，必须单独限流 */
  wbLive: Bucket;
  signal: Bucket;
  chat: Bucket;
  /** 当前所在房间，与 socket.data.roomId 保持一致，便于同步读取 */
  roomId: string | null;
}

const CTX = new WeakMap<AppSocket, SocketCtx>();

export function initCtx(socket: AppSocket): SocketCtx {
  const ctx: SocketCtx = {
    wbOp: createBucket(WB_OP_RATE, WB_OP_RATE),
    wbSync: createBucket(1, 3),
    wbLive: createBucket(45, 60),
    signal: createBucket(SIGNAL_RATE, SIGNAL_RATE),
    chat: createBucket(3, 5),
    roomId: null,
  };
  CTX.set(socket, ctx);
  return ctx;
}

export function ctxOf(socket: AppSocket): SocketCtx {
  return CTX.get(socket) ?? initCtx(socket);
}
