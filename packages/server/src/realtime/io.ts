import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from '@classroom/shared';
import { MAX_SOCKET_PAYLOAD } from '@classroom/shared';
import { initCtx } from './context';
import type { RealtimeDeps } from './deps';
import { registerRoomHandlers } from './handlers/room';
import { registerRtcHandlers } from './handlers/rtc';
import { registerWbHandlers } from './handlers/wb';
import { isAllowedOrigin } from '../lib/cors';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Socket.IO 与 Fastify 共用同一端口。
 *
 * 注意两点（踩过就知道）：
 *  1. 必须在 `app.ready()` 之后 `new Server(app.server)`，否则 app.server 还没就绪；
 *  2. 不要用 socket.io 的 fastify 插件，直接 attach 到 http server —— 它会自己在
 *     `request` 事件上按 path 拦截 `/socket.io`，Fastify 不会误吃这个路由。
 */
export function createIo(app: FastifyInstance, deps: RealtimeDeps): IO {
  const io: IO = new Server(app.server, {
    path: '/socket.io',
    // 白板全量 sync 可能超过默认 1MB，超了 socket.io 会静默断开，报错极难懂
    maxHttpBufferSize: MAX_SOCKET_PAYLOAD,
    pingInterval: 20_000,
    pingTimeout: 15_000,
    cors: {
      origin(origin, cb) {
        if (isAllowedOrigin(deps.config, origin)) return cb(null, true);
        cb(new Error('origin_not_allowed'), false);
      },
      credentials: false,
    },
  });

  // 握手鉴权：只认 scope='rtc' 的令牌，拒绝后客户端会收到 connect_error
  io.use((socket, next) => {
    const raw = socket.handshake.auth?.token;
    if (typeof raw !== 'string' || raw.length === 0) {
      return next(new Error('unauthorized'));
    }
    try {
      const claims = deps.auth.verifyToken(raw, 'rtc');
      socket.data.user = { id: claims.sub, role: claims.role, displayName: claims.name };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    initCtx(socket);
  });

  // 结束课堂（socket room:end、HTTP 取消课节）共用同一套广播/清场逻辑
  deps.roomService.attachRealtime({
    roomEnded(roomId, by) {
      io.to(roomId).emit('room:ended', { by });
      // 留一点时间把事件送到客户端，再统一退出房间
      setTimeout(() => {
        io.in(roomId).socketsLeave(roomId);
        deps.registry.collectGarbage();
      }, 800);
    },
  });

  io.engine.on('connection_error', (err) => {
    deps.log.warn({ code: err.code, message: err.message }, 'socket connection error');
  });

  registerRoomHandlers(io, deps);
  registerRtcHandlers(io, deps);
  registerWbHandlers(io, deps);

  // 空房间定期回收
  const gcTimer = setInterval(() => {
    const dropped = deps.registry.collectGarbage();
    if (dropped.length > 0) deps.log.debug({ dropped }, 'rooms gc');
  }, 60_000);
  // unref：不要因为这个定时器让进程无法退出
  gcTimer.unref();

  // 注意：不能在 app.ready() 之后再 addHook，Fastify v5 会抛
  // FST_ERR_INSTANCE_ALREADY_LISTENING。关闭顺序交给 index.ts 统一处理。
  return io;
}
