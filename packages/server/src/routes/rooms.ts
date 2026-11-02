import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ReportParticipant, RoomDTO, RoomReportDTO } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { requireAuth, requireTeacher } from '../plugins/authGuard';

const CreateSchema = z.object({ title: z.string().min(1).max(60) });
const JoinSchema = z.object({ code: z.string().regex(/^\d{6}$/, '入会码是 6 位数字') });
const IdSchema = z.object({ id: z.string().min(1) });

export const roomRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/',
    { preHandler: [requireAuth, requireTeacher] },
    async (request): Promise<{ room: RoomDTO }> => {
      const claims = request.claims;
      if (!claims) throw AppError.unauthorized();
      const r = CreateSchema.safeParse(request.body);
      if (!r.success) throw AppError.badRequest('bad_title', '请填写课堂名称（1~60 字）');
      const room = await app.roomService.create(claims.sub, r.data.title);
      return { room };
    },
  );

  app.get('/', { preHandler: [requireAuth] }, async (request): Promise<{ rooms: RoomDTO[] }> => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    return { rooms: await app.roomService.listForUser(claims.sub) };
  });

  app.post('/join', { preHandler: [requireAuth] }, async (request): Promise<{ room: RoomDTO }> => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const r = JoinSchema.safeParse(request.body);
    if (!r.success) throw AppError.badRequest('bad_code', '入会码是 6 位数字');
    return { room: await app.roomService.joinByCode(r.data.code, claims.sub) };
  });

  app.get('/:id', { preHandler: [requireAuth] }, async (request): Promise<{ room: RoomDTO }> => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const r = IdSchema.safeParse(request.params);
    if (!r.success) throw AppError.badRequest('bad_id', '课堂 ID 不正确');
    return { room: await app.roomService.getById(r.data.id, claims.sub) };
  });

  /**
   * 课堂记录。老师看全班，学生只看自己 —— 其他同学的进出时间属于个人信息，
   * 不能因为同在一个课堂就互相可见。
   *
   * 时长按「每人实际进出」累加，而不是「最后一次离开 - 第一次进入」——
   * 中途断线重进的人，后者会把中间的空白也算进去。
   */
  app.get(
    '/:id/report',
    { preHandler: [requireAuth] },
    async (request): Promise<RoomReportDTO> => {
      const claims = request.claims;
      if (!claims) throw AppError.unauthorized();
      const r = IdSchema.safeParse(request.params);
      if (!r.success) throw AppError.badRequest('bad_id', '课堂 ID 不正确');

      const roomId = r.data.id;
      const row = await app.repos.rooms.findById(roomId);
      if (!row) throw AppError.notFound('课堂不存在');

      const isHost = row.hostId === claims.sub;
      if (!isHost && !(await app.repos.participants.hasJoined(roomId, claims.sub))) {
        throw AppError.forbidden('你没有参加过这个课堂');
      }

      const records = await app.repos.participants.listByRoom(roomId);
      const now = Date.now();

      // 同一用户可能进出多次，按用户归并
      const agg = new Map<string, ReportParticipant>();
      for (const rec of records) {
        const withName = rec as unknown as { displayName?: string };
        const end = rec.leftAt ?? now;
        const span = Math.max(0, end - rec.joinedAt);
        const cur = agg.get(rec.userId);
        if (cur) {
          cur.totalMs += span;
          cur.leftAt = rec.leftAt ?? cur.leftAt;
        } else {
          agg.set(rec.userId, {
            userId: rec.userId,
            displayName: withName.displayName ?? '未知用户',
            role: rec.role,
            joinedAt: rec.joinedAt,
            leftAt: rec.leftAt,
            totalMs: span,
          });
        }
      }

      // 内存里有实时 doc 就用它，否则读落库快照
      const runtime = app.registry.get(roomId);
      let pageCount = 0;
      let elementCount = 0;
      if (runtime) {
        pageCount = runtime.doc.pages.length;
        elementCount = runtime.doc.elements.size;
      } else {
        try {
          const parsed = JSON.parse(row.docJson ?? '{}') as {
            pages?: unknown[];
            elements?: unknown[];
          };
          pageCount = parsed.pages?.length ?? 0;
          elementCount = parsed.elements?.length ?? 0;
        } catch {
          /* 快照损坏时按 0 处理，不影响其他字段 */
        }
      }

      const durationMs =
        row.startedAt === null ? 0 : Math.max(0, (row.endedAt ?? now) - row.startedAt);

      const participants = [...agg.values()].sort((a, b) => a.joinedAt - b.joinedAt);
      return {
        roomId,
        title: row.title,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMs,
        participants: isHost ? participants : participants.filter((p) => p.userId === claims.sub),
        messageCount: await app.repos.messages.countByRoom(roomId),
        pageCount,
        elementCount,
      };
    },
  );
};
