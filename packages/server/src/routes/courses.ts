import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type {
  CourseDTO,
  CourseDetailDTO,
  CourseMemberDTO,
  CoursewareDTO,
  QuestionDTO,
  QuestionOption,
} from '@classroom/shared';
import { AppError } from '../lib/errors';
import { signFileUrl } from '../lib/fileToken';
import {
  isAdmin,
  lessonDTOFor,
  loadCourseOrThrow,
  requireCourseManager,
  studentIdsOf,
  type Viewer,
} from '../lib/teachingAccess';
import { requireAuth, requireTeacher } from '../plugins/authGuard';

const FILE_URL_TTL_MS = 12 * 60 * 60 * 1000;

const CreateCourseSchema = z.object({
  title: z.string().trim().min(1).max(60),
  subject: z.string().trim().max(40).optional(),
  description: z.string().trim().max(1000).optional(),
  cover: z.string().trim().max(200).optional(),
});

const UpdateCourseSchema = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  subject: z.string().trim().max(40).optional(),
  description: z.string().trim().max(1000).optional(),
  cover: z.string().trim().max(200).optional(),
  archived: z.boolean().optional(),
});

const AddMembersSchema = z.object({
  emails: z.array(z.string().trim().email()).min(1).max(100),
  role: z.enum(['student', 'assistant']).optional(),
});

const CoursewareSchema = z.object({
  fileId: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
});

const QuestionSchema = z.object({
  type: z.enum(['single', 'multiple', 'judge']),
  stem: z.string().trim().min(1).max(1000),
  options: z
    .array(z.object({ key: z.string().trim().min(1).max(4), text: z.string().trim().min(1).max(300) }))
    .max(8)
    .optional(),
  answer: z.array(z.string().trim().min(1).max(4)).min(1).max(8),
  analysis: z.string().trim().max(1000).optional(),
});

const AssignmentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  dueAt: z.number().int().positive(),
  lessonId: z.string().min(1).max(64).optional(),
  maxScore: z.number().int().min(1).max(1000).optional(),
});

function viewerOf(request: { claims: { sub: string; role: Viewer['role'] } | null }): Viewer {
  if (!request.claims) throw AppError.unauthorized();
  return { id: request.claims.sub, role: request.claims.role };
}

function idOf(request: { params: unknown }): string {
  const r = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
  if (!r.success) throw AppError.badRequest('bad_id', 'ID 不正确');
  return r.data.id;
}

function signCoursewareList(
  list: Array<{
    id: string;
    courseId: string;
    fileId: string;
    title: string;
    mime: string;
    size: number;
    createdAt: number;
  }>,
  secret: string,
): CoursewareDTO[] {
  return list.map((c) => {
    const signed = signFileUrl(secret, c.fileId, FILE_URL_TTL_MS);
    return { ...c, url: signed.url, expiresAt: signed.expiresAt };
  });
}

export const courseRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [requireAuth] }, async (request): Promise<{ courses: CourseDTO[] }> => {
    const viewer = viewerOf(request);
    return { courses: await app.repos.courses.listForUser(viewer.id, isAdmin(viewer), Date.now()) };
  });

  app.post(
    '/',
    { preHandler: [requireAuth, requireTeacher] },
    async (request, reply): Promise<{ course: CourseDTO }> => {
      const viewer = viewerOf(request);
      const body = CreateCourseSchema.safeParse(request.body);
      if (!body.success) throw AppError.badRequest('bad_course', '请填写课程名称（1~60 字）');
      const id = randomUUID();
      await app.repos.courses.create({
        id,
        title: body.data.title,
        subject: body.data.subject ?? '',
        description: body.data.description ?? '',
        teacherId: viewer.id,
        cover: body.data.cover ?? '#3b82f6',
        createdAt: Date.now(),
      });
      const course = await app.repos.courses.get(id, viewer.id, isAdmin(viewer), Date.now());
      if (!course) throw new AppError(500, 'internal', '课程创建失败');
      reply.code(201);
      return { course };
    },
  );

  app.get('/:id', { preHandler: [requireAuth] }, async (request): Promise<CourseDetailDTO> => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    const course = await loadCourseOrThrow(app.repos, courseId, viewer);
    const manager = await app.repos.courses.isManager(courseId, viewer.id, isAdmin(viewer));

    const members = await app.repos.courses.listMembers(courseId);
    const teacher = await app.repos.users.findById(course.teacherId);
    const allMembers: CourseMemberDTO[] = teacher
      ? [
          {
            userId: teacher.id,
            email: teacher.email,
            displayName: teacher.displayName,
            role: teacher.role,
            memberRole: 'teacher',
            joinedAt: course.createdAt,
          },
          ...members,
        ]
      : members;

    const lessons = await app.repos.lessons.listByCourse(courseId);
    const lessonDTOs = await Promise.all(
      lessons.map((l) => lessonDTOFor(app.repos, l, viewer, manager)),
    );

    const courseware = signCoursewareList(
      await app.repos.courseware.listByCourse(courseId),
      app.appConfig.jwtSecret,
    );
    const questions = manager ? await app.repos.questions.listByCourse(courseId) : [];

    return { course, members: allMembers, lessons: lessonDTOs, courseware, questions };
  });

  app.patch('/:id', { preHandler: [requireAuth] }, async (request): Promise<{ course: CourseDTO }> => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const body = UpdateCourseSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_course', '课程信息不正确');
    await app.repos.courses.update(courseId, body.data);
    return { course: await loadCourseOrThrow(app.repos, courseId, viewer) };
  });

  app.delete('/:id', { preHandler: [requireAuth] }, async (request): Promise<{ ok: true }> => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    await app.repos.courses.remove(courseId);
    return { ok: true };
  });

  app.post('/:id/members', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const body = AddMembersSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_members', '请提供正确的邮箱列表');

    const added: CourseMemberDTO[] = [];
    const missing: string[] = [];
    const role = body.data.role ?? 'student';
    const now = Date.now();
    for (const email of [...new Set(body.data.emails.map((e) => e.toLowerCase()))]) {
      const user = await app.repos.courses.findUserByEmail(email);
      if (!user) {
        missing.push(email);
        continue;
      }
      if (user.id === viewer.id || user.role === 'admin') continue;
      const isNew = await app.repos.courses.addMember(courseId, user.id, role);
      if (!isNew) continue;
      added.push({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role as CourseMemberDTO['role'],
        memberRole: role,
        joinedAt: now,
      });
      await app.repos.notifications.create({
        id: randomUUID(),
        userId: user.id,
        kind: 'course',
        title: role === 'assistant' ? '你被添加为课程助教' : '你已加入课程',
        body: `课程「${(await loadCourseOrThrow(app.repos, courseId, viewer)).title}」`,
        link: `course:${courseId}`,
        at: now,
      });
    }
    return { added, missing };
  });

  app.delete('/:id/members/:userId', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const p = z.object({ userId: z.string().min(1).max(64) }).safeParse(request.params);
    if (!p.success) throw AppError.badRequest('bad_id', '用户 ID 不正确');
    await app.repos.courses.removeMember(courseId, p.data.userId);
    return { ok: true };
  });

  /* ── 课件库 ── */

  app.post('/:id/courseware', { preHandler: [requireAuth] }, async (request, reply) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const body = CoursewareSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_courseware', '课件信息不正确');

    const file = await app.repos.files.getById(body.data.fileId);
    if (!file || file.courseId !== courseId || file.purpose !== 'courseware') {
      throw AppError.badRequest('bad_file', '文件不存在或不属于该课程');
    }
    const row = {
      id: randomUUID(),
      courseId,
      fileId: file.id,
      title: body.data.title,
      mime: file.mime,
      size: file.size,
      createdBy: viewer.id,
      createdAt: Date.now(),
    };
    await app.repos.courseware.insert(row);
    reply.code(201);
    return { courseware: signCoursewareList([row], app.appConfig.jwtSecret)[0] };
  });

  app.delete('/:id/courseware/:cwId', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const p = z.object({ cwId: z.string().min(1).max(64) }).safeParse(request.params);
    if (!p.success) throw AppError.badRequest('bad_id', '课件 ID 不正确');
    const cw = await app.repos.courseware.get(p.data.cwId);
    if (!cw || cw.courseId !== courseId) throw AppError.notFound('课件不存在');
    await app.repos.courseware.remove(cw.id);
    return { ok: true };
  });

  /* ── 题库 ── */

  app.get('/:id/questions', { preHandler: [requireAuth] }, async (request): Promise<{ questions: QuestionDTO[] }> => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    return { questions: await app.repos.questions.listByCourse(courseId) };
  });

  app.post('/:id/questions', { preHandler: [requireAuth] }, async (request, reply) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const body = QuestionSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_question', '题目信息不完整');

    const input = body.data;
    let options: QuestionOption[] = input.options ?? [];
    if (input.type === 'judge') {
      options = [
        { key: 'T', text: '正确' },
        { key: 'F', text: '错误' },
      ];
    }
    if (input.type !== 'judge' && options.length < 2) {
      throw AppError.badRequest('bad_question', '选择题至少需要两个选项');
    }
    const keys = new Set(options.map((o) => o.key));
    if (keys.size !== options.length) throw AppError.badRequest('bad_question', '选项编号不能重复');
    if (input.answer.some((a) => !keys.has(a))) {
      throw AppError.badRequest('bad_question', '正确答案不在选项里');
    }
    if (input.type !== 'multiple' && input.answer.length !== 1) {
      throw AppError.badRequest('bad_question', '单选题只能有一个正确答案');
    }

    const row = {
      id: randomUUID(),
      courseId,
      createdBy: viewer.id,
      type: input.type,
      stem: input.stem,
      options,
      answer: input.answer,
      analysis: input.analysis ?? '',
      createdAt: Date.now(),
    };
    await app.repos.questions.insert(row);
    reply.code(201);
    return { question: { ...row } as QuestionDTO };
  });

  app.delete('/:id/questions/:qId', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await requireCourseManager(app.repos, courseId, viewer);
    const p = z.object({ qId: z.string().min(1).max(64) }).safeParse(request.params);
    if (!p.success) throw AppError.badRequest('bad_id', '题目 ID 不正确');
    const q = await app.repos.questions.get(p.data.qId);
    if (!q || q.courseId !== courseId) throw AppError.notFound('题目不存在');
    await app.repos.questions.remove(q.id);
    return { ok: true };
  });

  /* ── 作业（课程维度） ── */

  app.get('/:id/assignments', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    await loadCourseOrThrow(app.repos, courseId, viewer);
    const list = await app.repos.homework.listByCourse(courseId);
    const out = [];
    for (const a of list) {
      const detail = await app.repos.homework.getAssignment(a.id);
      const mine = await app.repos.homework.getSubmission(a.id, viewer.id);
      out.push({
        ...a,
        mySubmission: mine
          ? {
              ...mine,
              fileIds: await app.repos.homework.fileIdsForSubmission(mine.id),
            }
          : null,
        submissionCount: detail?.submissionCount ?? 0,
        gradedCount: detail?.gradedCount ?? 0,
      });
    }
    return { assignments: out };
  });

  app.post('/:id/assignments', { preHandler: [requireAuth] }, async (request, reply) => {
    const viewer = viewerOf(request);
    const courseId = idOf(request);
    const course = await requireCourseManager(app.repos, courseId, viewer);
    const body = AssignmentSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_assignment', '作业信息不完整');
    if (body.data.dueAt <= Date.now()) throw AppError.badRequest('bad_due', '截止时间必须晚于现在');

    const row = {
      id: randomUUID(),
      courseId,
      lessonId: body.data.lessonId ?? null,
      title: body.data.title,
      description: body.data.description ?? '',
      dueAt: body.data.dueAt,
      maxScore: body.data.maxScore ?? 100,
      createdBy: viewer.id,
      createdAt: Date.now(),
    };
    await app.repos.homework.insertAssignment(row);

    const at = Date.now();
    for (const userId of await studentIdsOf(app.repos, courseId)) {
      await app.repos.notifications.create({
        id: randomUUID(),
        userId,
        kind: 'assignment',
        title: `新作业：${row.title}`,
        body: `${course.title} · 截止 ${new Date(row.dueAt).toLocaleString('zh-CN')}`,
        link: `assignment:${row.id}`,
        at,
      });
    }
    reply.code(201);
    return { assignment: row };
  });
};
