import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { LessonDTO } from '@classroom/shared';
import { AppError } from '../lib/errors';
import {
  isAdmin,
  lessonDTOFor,
  loadCourseOrThrow,
  requireCourseManager,
  studentIdsOf,
  type Viewer,
} from '../lib/teachingAccess';
import { requireAuth } from '../plugins/authGuard';

const CreateLessonSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  startsAt: z.number().int().positive(),
  durationMin: z.number().int().min(10).max(240).optional(),
});

const UpdateLessonSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  startsAt: z.number().int().positive().optional(),
  durationMin: z.number().int().min(10).max(240).optional(),
  status: z.enum(['scheduled', 'cancelled']).optional(),
});

function viewerOf(request: { claims: { sub: string; role: Viewer['role'] } | null }): Viewer {
  if (!request.claims) throw AppError.unauthorized();
  return { id: request.claims.sub, role: request.claims.role };
}

function idOf(request: { params: unknown }, key = 'id'): string {
  const v = (request.params as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) {
    throw AppError.badRequest('bad_id', 'ID 不正确');
  }
  return v;
}

async function managerOfLesson(
  app: FastifyInstance,
  lessonId: string,
  viewer: Viewer,
) {
  const lesson = await app.repos.lessons.get(lessonId);
  if (!lesson) throw AppError.notFound('课节不存在');
  const manager = await app.repos.courses.isManager(lesson.courseId, viewer.id, isAdmin(viewer));
  return { lesson, manager };
}

export const lessonRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [requireAuth] }, async (request): Promise<{ lessons: LessonDTO[] }> => {
    const viewer = viewerOf(request);
    const q = z.object({ from: z.coerce.number().int().optional(), limit: z.coerce.number().int().optional() }).safeParse(request.query);
    const from = q.success && q.data.from ? q.data.from : Date.now() - 60 * 60 * 1000;
    const limit = q.success ? q.data.limit ?? 50 : 50;
    const list = await app.repos.lessons.listForUser(viewer.id, isAdmin(viewer), from, limit);
    const out: LessonDTO[] = [];
    for (const l of list) {
      const manager = await app.repos.courses.isManager(l.courseId, viewer.id, isAdmin(viewer));
      out.push(await lessonDTOFor(app.repos, l, viewer, manager));
    }
    return { lessons: out };
  });

  app.get('/history', { preHandler: [requireAuth] }, async (request): Promise<{ lessons: LessonDTO[] }> => {
    const viewer = viewerOf(request);
    const list = await app.repos.lessons.listPastForUser(viewer.id, isAdmin(viewer), Date.now());
    const out: LessonDTO[] = [];
    for (const l of list) {
      const manager = await app.repos.courses.isManager(l.courseId, viewer.id, isAdmin(viewer));
      out.push(await lessonDTOFor(app.repos, l, viewer, manager));
    }
    return { lessons: out };
  });

  app.get('/:id', { preHandler: [requireAuth] }, async (request): Promise<{ lesson: LessonDTO }> => {
    const viewer = viewerOf(request);
    const { lesson, manager } = await managerOfLesson(app, idOf(request), viewer);
    await loadCourseOrThrow(app.repos, lesson.courseId, viewer);
    return { lesson: await lessonDTOFor(app.repos, lesson, viewer, manager) };
  });

  app.post('/:id/enter', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const { lesson, manager } = await managerOfLesson(app, idOf(request), viewer);
    await loadCourseOrThrow(app.repos, lesson.courseId, viewer);

    if (lesson.status === 'cancelled') throw AppError.conflict('cancelled', '这节课已取消');
    if (lesson.status === 'ended' || lesson.roomStatus === 'ended') {
      throw AppError.conflict('ended', '这节课已结束');
    }
    const enterAt = lesson.startsAt - 15 * 60 * 1000;
    if (!manager && Date.now() < enterAt) {
      throw new AppError(403, 'too_early', '距开课 15 分钟时才可进入教室');
    }
    return {
      roomId: lesson.roomId,
      joinCode: lesson.joinCode,
      startsAt: lesson.startsAt,
      joinCodeVisible: manager,
    };
  });

  app.post('/:id/cancel', { preHandler: [requireAuth] }, async (request): Promise<{ ok: true }> => {
    const viewer = viewerOf(request);
    const { lesson, manager } = await managerOfLesson(app, idOf(request), viewer);
    if (!manager) throw AppError.forbidden('只有课程老师或助教可以取消课节');
    if (lesson.status === 'ended') throw AppError.conflict('ended', '课节已结束');
    await app.repos.lessons.update(lesson.id, { status: 'cancelled' });
    // 课节 DB 状态保持 cancelled；教室结束、考勤截断、runtime 更新、room:ended 广播
    // 全部复用结束课堂的服务逻辑。权限已在上面的课程管理者校验中完成。
    await app.roomService.end(lesson.roomId, viewer.id, {
      skipHostCheck: true,
      markLessonEnded: false,
    });
    const at = Date.now();
    for (const userId of await studentIdsOf(app.repos, lesson.courseId)) {
      await app.repos.notifications.create({
        id: randomUUID(),
        userId,
        kind: 'lesson',
        title: `课程取消：${lesson.title}`,
        body: `${lesson.courseTitle} · ${new Date(lesson.startsAt).toLocaleString('zh-CN')}`,
        link: `course:${lesson.courseId}`,
        at,
      });
    }
    return { ok: true };
  });

  /* 以下两个路由挂在 /courses/:id/lessons 下也可以，但课程前缀插件已注册，
     为避免重复实现，允许从课程 ID 创建课节（路径由 index.ts 注册为 /lessons）。 */

  app.patch('/:id', { preHandler: [requireAuth] }, async (request): Promise<{ lesson: LessonDTO }> => {
    const viewer = viewerOf(request);
    const { lesson, manager } = await managerOfLesson(app, idOf(request), viewer);
    if (!manager) throw AppError.forbidden('只有课程老师或助教可以修改课节');
    const body = UpdateLessonSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_lesson', '课节信息不正确');
    if (lesson.status === 'ended') throw AppError.conflict('ended', '课节已结束');

    const startsAt = body.data.startsAt ?? lesson.startsAt;
    const durationMin = body.data.durationMin ?? lesson.durationMin;
    const timeChanged = body.data.startsAt !== undefined || body.data.durationMin !== undefined;
    const course = timeChanged
      ? await app.repos.courses.get(lesson.courseId, viewer.id, isAdmin(viewer), Date.now())
      : null;
    if (
      course &&
      (await app.repos.lessons.hasConflict(course.teacherId, startsAt, durationMin, lesson.id))
    ) {
      throw AppError.conflict('time_conflict', '该时间段已有其他课节');
    }
    const patch = {
      ...body.data,
      startsAt: body.data.startsAt,
    };
    if (timeChanged && course) {
      // 冲突查询 + UPDATE 必须在同一个事务里，否则并发改期会同时通过预检
      const ok = await app.repos.lessons.updateIfNoConflict(
        lesson.id,
        { ...patch, startsAt, durationMin },
        course.teacherId,
      );
      if (!ok) throw AppError.conflict('time_conflict', '该时间段已有其他课节');
    } else {
      await app.repos.lessons.update(lesson.id, patch);
    }
    if (body.data.status === 'cancelled') {
      // 与取消接口一致：结束教室、截断考勤并广播 room:ended，但课节状态保持 cancelled
      await app.roomService.end(lesson.roomId, viewer.id, {
        skipHostCheck: true,
        markLessonEnded: false,
      });
    }
    const fresh = await app.repos.lessons.get(lesson.id);
    if (!fresh) throw AppError.notFound('课节不存在');
    return { lesson: await lessonDTOFor(app.repos, fresh, viewer, manager) };
  });
};

/** 课程下的课节集合：POST /courses/:courseId/lessons、GET /courses/:courseId/lessons */
export const courseLessonRoutes: FastifyPluginAsync = async (app) => {
  app.post('/:courseId/lessons', { preHandler: [requireAuth] }, async (request, reply) => {
    const viewer = viewerOf(request);
    const r = z.object({ courseId: z.string().min(1).max(64) }).safeParse(request.params);
    if (!r.success) throw AppError.badRequest('bad_id', '课程 ID 不正确');
    const course = await requireCourseManager(app.repos, r.data.courseId, viewer);

    const body = CreateLessonSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_lesson', '请填写正确的开课时间');
    const startsAt = body.data.startsAt;
    const durationMin = body.data.durationMin ?? 45;
    if (startsAt < Date.now() - 5 * 60 * 1000) {
      throw AppError.badRequest('bad_time', '开课时间不能早于当前时间');
    }
    if (await app.repos.lessons.hasConflict(course.teacherId, startsAt, durationMin)) {
      throw AppError.conflict('time_conflict', '该时间段已有其他课节');
    }

    const title = body.data.title ?? `${course.title} · 第 ${course.lessonCount + 1} 节`;
    const room = await app.roomService.create(course.teacherId, title, { courseId: course.id });
    const lessonId = randomUUID();
    // 上面的 hasConflict 只是为了尽早失败；并发创建时真正兜底的是事务内的复查
    const created = await app.repos.lessons.insertIfNoConflict(
      {
        id: lessonId,
        courseId: course.id,
        title,
        startsAt,
        durationMin,
        roomId: room.id,
        status: 'scheduled',
        createdAt: Date.now(),
      },
      course.teacherId,
    );
    if (!created) {
      // 竞争失败时刚建的房间还没有任何课节/成员，直接结束以免留下可加入的孤儿教室
      await app.repos.rooms.setStatus(room.id, 'ended', Date.now());
      throw AppError.conflict('time_conflict', '该时间段已有其他课节');
    }
    await app.repos.rooms.bindLesson(room.id, lessonId);

    const at = Date.now();
    for (const userId of await studentIdsOf(app.repos, course.id)) {
      await app.repos.notifications.create({
        id: randomUUID(),
        userId,
        kind: 'lesson',
        title: `新课程安排：${title}`,
        body: `${course.title} · ${new Date(startsAt).toLocaleString('zh-CN')}`,
        link: `course:${course.id}`,
        at,
      });
    }

    const fresh = await app.repos.lessons.get(lessonId);
    if (!fresh) throw new AppError(500, 'internal', '课节创建失败');
    reply.code(201);
    return { lesson: await lessonDTOFor(app.repos, fresh, viewer, true) };
  });

  app.get('/:courseId/lessons', { preHandler: [requireAuth] }, async (request): Promise<{ lessons: LessonDTO[] }> => {
    const viewer = viewerOf(request);
    const r = z.object({ courseId: z.string().min(1).max(64) }).safeParse(request.params);
    if (!r.success) throw AppError.badRequest('bad_id', '课程 ID 不正确');
    await loadCourseOrThrow(app.repos, r.data.courseId, viewer);
    const manager = await app.repos.courses.isManager(r.data.courseId, viewer.id, isAdmin(viewer));
    const list = await app.repos.lessons.listByCourse(r.data.courseId);
    const out: LessonDTO[] = [];
    for (const l of list) out.push(await lessonDTOFor(app.repos, l, viewer, manager));
    return { lessons: out };
  });
};
