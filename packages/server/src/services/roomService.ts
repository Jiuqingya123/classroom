import { randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH, type RoomDTO, type RoomStatus } from '@classroom/shared';
import type { Config } from '../config';
import type { Repos } from '../db/repos';
import type { RoomListRow } from '../db/repos/rooms';
import { AppError } from '../lib/errors';
import type { RoomRegistry } from '../realtime/RoomRegistry';

/**
 * Socket.IO 层注入的实时能力。HTTP-only 环境（例如测试里只 buildServer）
 * 可以不注入，此时结束课堂仍会写库并关闭考勤，只是没有在线广播。
 */
export interface RoomRealtime {
  /** 广播 room:ended，并让该房间内的在线 socket 离开 */
  roomEnded(roomId: string, by: string): void;
}

export interface EndRoomOptions {
  isAdmin?: boolean;
  /** 调用方已完成授权（例如课程管理者取消课节），跳过房主校验 */
  skipHostCheck?: boolean;
  /** 是否把绑定课节标记为 ended；取消课节时必须传 false */
  markLessonEnded?: boolean;
}

export interface RoomService {
  create(
    hostId: string,
    title: string,
    opts?: { courseId?: string | null; lessonId?: string | null },
  ): Promise<RoomDTO>;
  listForUser(userId: string): Promise<RoomDTO[]>;
  getById(roomId: string, viewerId: string): Promise<RoomDTO>;
  joinByCode(code: string, viewerId: string): Promise<RoomDTO>;
  findForSocket(roomId: string): Promise<RoomListRow>;
  attachRealtime(realtime: RoomRealtime): void;
  end(roomId: string, byUserId: string, opts?: EndRoomOptions): Promise<void>;
  start(roomId: string): Promise<void>;
}

const CODE_TRIES = 12;

function emptyDoc(): string {
  return JSON.stringify({
    seq: 0,
    pages: [
      {
        id: randomUUID(),
        index: 0,
        name: '第 1 页',
        width: DEFAULT_PAGE_WIDTH,
        height: DEFAULT_PAGE_HEIGHT,
        background: null,
      },
    ],
    elements: [],
  });
}

export function createRoomService(deps: {
  config: Config;
  repos: Repos;
  registry?: RoomRegistry;
}): RoomService {
  const { repos } = deps;
  let realtime: RoomRealtime | null = null;

  async function freshCode(): Promise<string> {
    for (let i = 0; i < CODE_TRIES; i++) {
      const code = String(randomInt(100_000, 1_000_000));
      if (!(await repos.rooms.codeTaken(code))) return code;
    }
    throw new AppError(503, 'code_exhausted', '入会码生成失败，请重试');
  }

  function toDTO(room: RoomListRow, viewerId: string, hasJoined: boolean): RoomDTO {
    const canSeeCode = room.hostId === viewerId || hasJoined;
    return {
      id: room.id,
      title: room.title,
      hostId: room.hostId,
      hostName: room.hostName,
      joinCode: canSeeCode ? room.joinCode : '******',
      status: room.status,
      createdAt: room.createdAt,
      startedAt: room.startedAt,
      endedAt: room.endedAt,
      participantCount: room.activeCount,
      courseId: room.courseId,
      lessonId: room.lessonId,
      courseTitle: room.courseTitle,
      lessonTitle: room.lessonTitle,
    };
  }

  return {
    async create(hostId, title, opts) {
      const clean = title.trim() || '未命名课堂';
      if (clean.length > 60) throw AppError.badRequest('bad_title', '课堂名称不能超过 60 字');

      const record = {
        id: randomUUID(),
        title: clean,
        hostId,
        joinCode: await freshCode(),
        status: 'open' as RoomStatus,
        docJson: emptyDoc(),
        lastSeq: 0,
        createdAt: Date.now(),
        startedAt: null,
        endedAt: null,
        courseId: opts?.courseId ?? null,
        lessonId: opts?.lessonId ?? null,
      };
      await repos.rooms.insert(record);
      return toDTO(
        { ...record, hostName: '', activeCount: 0, courseTitle: null, lessonTitle: null },
        hostId,
        true,
      );
    },

    async listForUser(userId) {
      const rows = await repos.rooms.listForUser(userId);
      const out: RoomDTO[] = [];
      for (const r of rows) {
        const joined = r.hostId === userId || (await repos.participants.hasJoined(r.id, userId));
        out.push(toDTO(r, userId, joined));
      }
      return out;
    },

    async getById(roomId, viewerId) {
      const room = await repos.rooms.findById(roomId);
      if (!room) throw AppError.notFound('课堂不存在');
      const joined = room.hostId === viewerId || (await repos.participants.hasJoined(roomId, viewerId));
      return toDTO(room, viewerId, joined);
    },

    async joinByCode(code, viewerId) {
      const clean = code.trim();
      if (!/^\d{6}$/.test(clean)) throw AppError.badRequest('bad_code', '请输入 6 位数字入会码');
      const room = await repos.rooms.findByCode(clean);
      if (!room) throw AppError.notFound('入会码无效或课堂已结束');
      if (room.status === 'ended') throw AppError.conflict('ended', '课堂已结束');
      // 学生已经手里有这个码，回显无信息泄露
      return toDTO(room, viewerId, true);
    },

    async findForSocket(roomId) {
      const room = await repos.rooms.findById(roomId);
      if (!room) throw AppError.notFound('课堂不存在');
      return room;
    },

    async start(roomId) {
      await repos.rooms.setStatus(roomId, 'live', Date.now());
    },

    attachRealtime(rt) {
      realtime = rt;
    },

    async end(roomId, byUserId, opts) {
      const room = await repos.rooms.findById(roomId);
      if (!room) throw AppError.notFound('课堂不存在');
      if (!opts?.skipHostCheck && room.hostId !== byUserId && !opts?.isAdmin) {
        throw AppError.forbidden('只有老师可以结束课堂');
      }
      const now = Date.now();
      await repos.rooms.setStatus(roomId, 'ended', now);
      // 结束时统一关闭所有未离开的参与记录，考勤按实际结束时间截断
      await repos.participants.closeAll(roomId, now);

      const runtime = deps.registry?.get(roomId);
      if (runtime) {
        runtime.status = 'ended';
        runtime.endedAt = now;
      }
      // 取消课节时调用方传 markLessonEnded: false，避免把 cancelled 改成 ended
      if (opts?.markLessonEnded !== false) {
        await repos.lessons.markEndedByRoom(roomId).catch(() => {});
      }
      // 广播 + 让在线 socket 离开由 Socket.IO 层注入；HTTP-only 环境没有也安全
      realtime?.roomEnded(roomId, byUserId);
    },
  };
}
