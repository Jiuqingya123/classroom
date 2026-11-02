import type { Server } from 'socket.io';
import {
  applyOp,
  visibleElements,
  WB_PERSIST_DEBOUNCE_MS,
  type ClientToServerEvents,
  type InterServerEvents,
  type ReduceContext,
  type ServerToClientEvents,
  type SocketData,
  type WbOp,
  type WbRejectReason,
  type WbSyncPayload,
  type WhiteboardElement,
} from '@classroom/shared';
import type { AppSocket } from '../context';
import { ctxOf } from '../context';
import type { RealtimeDeps } from '../deps';
import type { RoomRuntime } from '../RoomRegistry';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** 拒绝时回拉给发起者的权威元素数量上限，防止误发整页 */
const MAX_REJECT_ELEMENTS = 200;

/**
 * 白板事件。
 *
 * 核心是把所有写操作收进 `applyOp`（shared 里的纯函数），服务端只负责
 * 「限流 → 调 reducer → 加 seq → 广播 → 延迟落库」这一条流水线。
 * 任何校验规则都写在 reducer 里，保证客户端能跑同一份逻辑。
 */
export function registerWbHandlers(io: IO, deps: RealtimeDeps): void {
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const persisting = new Set<string>();
  const PERSIST_RETRY_MS = 2000;

  /** 落库 debounce：手写笔一笔接一笔，每笔都写盘会把 SQLite 打满 */
  function persistSoon(roomId: string, immediate = false): void {
    const pending = persistTimers.get(roomId);
    if (pending) clearTimeout(pending);

    const run = (): void => {
      persistTimers.delete(roomId);
      const room = deps.registry.get(roomId);
      // 同一房间的写盘串行化：并发写可能让较旧的快照后落库，覆盖较新的状态
      if (!room || !room.dirty || persisting.has(roomId)) return;

      room.dirty = false;
      const doc = deps.registry.serializeDoc(room);
      const seq = room.seq;
      persisting.add(roomId);
      void deps.repos.rooms
        .saveDoc(room.id, doc, seq)
        .then(() => {
          persisting.delete(roomId);
          // 写盘期间又产生了新 op：再排一次，不能停在旧快照
          if (deps.registry.get(roomId) === room && room.dirty) persistSoon(roomId);
        })
        .catch((err: unknown) => {
          persisting.delete(roomId);
          deps.log.error({ err, roomId }, 'whiteboard persist failed');
          if (deps.registry.get(roomId) !== room) return;
          // 失败不能把 dirty 提前清掉，否则最后一笔永远丢；退避后重试
          room.dirty = true;
          const t = setTimeout(() => persistSoon(roomId, true), PERSIST_RETRY_MS);
          t.unref?.();
          persistTimers.set(roomId, t);
        });
    };

    if (immediate) {
      run();
      return;
    }
    const t = setTimeout(run, WB_PERSIST_DEBOUNCE_MS);
    t.unref?.();
    persistTimers.set(roomId, t);
  }

  /** 页可能被老师删掉，activePageId 不能指向不存在的页，否则新加入者会白屏 */
  function ensureActivePage(room: RoomRuntime): string {
    if (room.doc.pages.some((p) => p.id === room.activePageId)) return room.activePageId;
    room.activePageId = room.doc.pages[0]?.id ?? '';
    return room.activePageId;
  }

  function syncPayload(room: RoomRuntime, pageId: string): WbSyncPayload {
    return {
      pageId,
      seq: room.seq,
      pages: room.doc.pages,
      elements: visibleElements(room.doc, pageId),
      studentsCanDraw: room.studentsCanDraw,
    };
  }

  /** 收集被拒绝那批 op 涉及元素的权威值，方便客户端就地回拉 */
  function authoritativeFor(room: RoomRuntime, ops: WbOp[]): WhiteboardElement[] {
    const ids = new Set<string>();
    for (const op of ops) {
      if (op.kind === 'patch' || op.kind === 'remove') ids.add(op.id);
      if (op.kind === 'add') ids.add(op.el?.id ?? '');
    }
    const out: WhiteboardElement[] = [];
    for (const id of ids) {
      const el = room.doc.elements.get(id);
      if (el) out.push(el);
      if (out.length >= MAX_REJECT_ELEMENTS) break;
    }
    return out;
  }

  io.on('connection', (socket: AppSocket) => {
    const user = socket.data.user;

    socket.on('wb:op', (payload, ack) => {
      const reply = (r: { ok: boolean; seq?: number; error?: WbRejectReason }): void => {
        if (typeof ack === 'function') ack(r);
      };

      const roomId = socket.data.roomId;
      if (!roomId) return reply({ ok: false, error: 'bad_op' });
      const room = deps.registry.get(roomId);
      if (!room) return reply({ ok: false, error: 'bad_op' });

      const ctx = ctxOf(socket);
      if (!ctx.wbOp.take()) return reply({ ok: false, error: 'rate_limited' });

      const ops = Array.isArray(payload?.ops) ? payload.ops : [];
      if (ops.length === 0) return reply({ ok: false, error: 'bad_op' });
      if (!room.doc.pages.some((p) => p.id === payload.pageId)) {
        return reply({ ok: false, error: 'bad_op' });
      }

      // 白板权限跟随当前房间身份：全局老师如果只是凭码旁听，不能改动别人的板书
      const me = room.members.get(user.id);
      const reduceCtx: ReduceContext = {
        by: user.id,
        role: me?.staff ? 'teacher' : 'student',
        studentsCanDraw: room.studentsCanDraw,
        now: Date.now(),
      };

      const accepted: WbOp[] = [];
      const revs: Record<string, number> = {};
      let firstError: WbRejectReason | null = null;

      for (const op of ops) {
        const out = applyOp(room.doc, op, reduceCtx);
        if (!out.ok) {
          // 一批里某条失败不影响已成功的：白板的每条 op 本就是独立的，
          // 让它们照常广播，doc 与客户端才不会分叉。
          firstError ??= out.reason ?? 'bad_op';
          continue;
        }
        if (out.op) accepted.push(out.op);
        Object.assign(revs, out.revs);
      }

      let seq: number | undefined;
      if (accepted.length > 0) {
        room.seq += 1;
        seq = room.seq;
        io.to(roomId).emit('wb:op', {
          pageId: payload.pageId,
          seq,
          by: user.id,
          opId: payload.opId,
          ops: accepted,
          revs,
        });

        // 删除的正好是当前页：把权威 activePageId 落到第一页并广播，
        // 否则之后 resync 的客户端会拿到一个已经不存在的页
        const before = room.activePageId;
        const after = ensureActivePage(room);
        if (after !== before) {
          io.to(roomId).emit('wb:page', { pageId: after, pages: room.doc.pages });
        }

        deps.registry.markDirty(room);
        persistSoon(roomId);
      }

      if (firstError) {
        socket.emit('wb:op:reject', {
          opId: payload.opId,
          reason: firstError,
          elements: authoritativeFor(room, ops),
        });
        return reply({ ok: false, error: firstError });
      }

      reply({ ok: true, seq });
    });

    /** 全量重同步。永不做增量 —— 增量补丁在丢消息时的边界条件太多。 */
    socket.on('wb:resync', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      if (!ctxOf(socket).wbSync.take()) return;
      const room = deps.registry.get(roomId);
      if (!room) return;

      // 页面以服务端为准：客户端可能带着掉线前的旧页来重同步，
      // 若照单全收，学生端会被永久钉在一页老师早就不在的课件上
      const pageId = ensureActivePage(room);
      socket.emit('wb:sync', syncPayload(room, pageId));
    });

    /** 绘制中的预览笔迹：无状态、不入 seq、不落库，只是为了「笔迹跟着手出来」 */
    socket.on('wb:preview', (payload) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const ctx = ctxOf(socket);
      if (!ctx.wbLive.take()) return;

      const room = deps.registry.get(roomId);
      if (!room) return;
      if (!room.members.get(user.id)?.staff && !room.studentsCanDraw) return;
      if (!Array.isArray(payload?.points) || payload.points.length < 2) return;
      if (payload.points.length > 8000) return;

      // 压感是可选的附加信息：长度对不上或含非法值就当没有，别把脏数据转给对端
      const raw = payload.pressures;
      const pressures =
        Array.isArray(raw) && raw.length === payload.points.length / 2
          ? raw.map((n: unknown) =>
              typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1,
            )
          : undefined;

      socket.to(roomId).emit('wb:preview', {
        ...payload,
        ...(pressures ? { pressures } : { pressures: undefined }),
        userId: user.id,
        done: !!payload.done,
      });
    });

    socket.on('wb:presence', (payload) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const ctx = ctxOf(socket);
      if (!ctx.wbLive.take()) return;

      const room = deps.registry.get(roomId);
      if (!room) return;

      // 坐标为 null 表示鼠标离开画布，广播出去让对端把光标移除
      const x = typeof payload?.x === 'number' ? payload.x : null;
      const y = typeof payload?.y === 'number' ? payload.y : null;

      socket.to(roomId).emit('wb:presence', {
        cursors: [
          {
            userId: user.id,
            pageId: payload?.pageId ?? ensureActivePage(room),
            x: x ?? 0,
            y: y ?? 0,
            tool: x === null ? '' : String(payload?.tool ?? ''),
            ts: x === null ? 0 : Date.now(),
          },
        ],
      });
    });

    /** 老师冻结/解冻学生绘制 */
    socket.on('wb:lock', (payload, ack) => {
      const reply = (r: { ok: boolean; error?: string }): void => {
        if (typeof ack === 'function') ack(r);
      };
      const roomId = socket.data.roomId;
      if (!roomId) return reply({ ok: false, error: 'not_in_room' });
      const room = deps.registry.get(roomId);
      if (!room) return reply({ ok: false, error: 'not_found' });
      if (room.hostId !== user.id) return reply({ ok: false, error: 'forbidden' });

      room.studentsCanDraw = !!payload?.studentsCanDraw;
      deps.registry.markDirty(room);
      persistSoon(roomId);
      io.to(roomId).emit('wb:lock', { studentsCanDraw: room.studentsCanDraw, by: user.id });
      reply({ ok: true });
    });

    /** 老师翻页 —— 全员跟随，白板在老师手里是「同一本书」 */
    socket.on('wb:page', (payload) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = deps.registry.get(roomId);
      if (!room) return;
      if (room.hostId !== user.id) return;

      const pageId = typeof payload?.pageId === 'string' ? payload.pageId : '';
      if (!room.doc.pages.some((p) => p.id === pageId)) return;

      room.activePageId = pageId;
      deps.registry.markDirty(room);
      persistSoon(roomId);

      io.to(roomId).emit('wb:page', { pageId, pages: room.doc.pages });
    });
  });
}
