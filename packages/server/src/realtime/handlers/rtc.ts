import type { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SignalPayload,
  SocketData,
} from '@classroom/shared';
import type { AppSocket } from '../context';
import { ctxOf } from '../context';
import type { RealtimeDeps } from '../deps';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** SDP 正常几 KB，超过这个长度一定是异常或恶意的 */
const MAX_SDP_LEN = 64 * 1024;

function isValidPayload(p: SignalPayload): boolean {
  if (!p || typeof p !== 'object') return false;
  if (p.type === 'offer' || p.type === 'answer') {
    return typeof p.sdp === 'string' && p.sdp.length > 0 && p.sdp.length <= MAX_SDP_LEN;
  }
  if (p.type === 'candidate') {
    // candidate 为 null 表示候选收集结束，是合法值
    if (p.candidate === null) return true;
    return typeof p.candidate?.candidate === 'string' && p.candidate.candidate.length <= 2048;
  }
  return false;
}

/**
 * 信令中转。服务端**不解析 SDP 内容**，只做三件事：
 *  1. 限流（Mesh 下 N 个 peer 会放大消息量）
 *  2. 校验收发双方确实在同一个房间，防止跨课堂串流
 *  3. 按 userId 找到目标 socket 转发
 *
 * 这也是为什么不能把信令做成「广播给房间所有人」—— 那样 5 人课堂的信令量会变成 O(N²) 且
 * 每个客户端都要丢弃不属于自己的消息。
 */
export function registerRtcHandlers(io: IO, deps: RealtimeDeps): void {
  io.on('connection', (socket: AppSocket) => {
    socket.on('rtc:signal', (packet) => {
      if (!packet || typeof packet.to !== 'string' || packet.to.length === 0) return;

      const ctx = ctxOf(socket);
      if (!ctx.signal.take()) return;

      const roomId = socket.data.roomId;
      if (!roomId) return;

      const room = deps.registry.get(roomId);
      if (!room) return;

      const selfId = socket.data.user.id;
      // 发送方必须仍在房间内（可能已被踢或已离开）
      if (!room.members.has(selfId)) return;

      const target = room.members.get(packet.to);
      if (!target) return;

      if (!isValidPayload(packet.payload)) {
        deps.log.warn({ from: selfId, type: packet.payload?.type }, 'invalid rtc signal payload');
        return;
      }

      io.to(target.socketId).emit('rtc:signal', { from: selfId, payload: packet.payload });
    });
  });
}
