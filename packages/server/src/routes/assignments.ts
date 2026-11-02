import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AssignmentDTO, SubmissionDTO } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { isAdmin, loadCourseOrThrow, type Viewer } from '../lib/teachingAccess';
import { requireAuth } from '../plugins/authGuard';

const SubmitSchema = z.object({
  content: z.string().trim().max(5000).optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(20).optional(),
});

const GradeSchema = z.object({
  score: z.number().int().min(0).max(1000),
  feedback: z.string().trim().max(2000).optional(),
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

function submissionDTO(
  s: {
    id: string;
    assignmentId: string;
    studentId: string;
    studentName: string;
    content: string;
    status: 'submitted' | 'graded';
    score: number | null;
    feedback: string;
    submittedAt: number;
    gradedAt: number | null;
  },
  fileIds: string[],
): SubmissionDTO {
  return { ...s, fileIds };
}

export const assignmentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [requireAuth] }, async (request): Promise<{ assignments: AssignmentDTO[] }> => {
    const viewer = viewerOf(request);
    const list = await app.repos.homework.listForUser(viewer.id, isAdmin(viewer));
    const out: AssignmentDTO[] = [];
    for (const a of list) {
      const detail = await app.repos.homework.getAssignment(a.id);
      const mine = await app.repos.homework.getSubmission(a.id, viewer.id);
      out.push({
        ...a,
        mySubmission: mine
          ? submissionDTO(mine, await app.repos.homework.fileIdsForSubmission(mine.id))
          : null,
        submissionCount: detail?.submissionCount ?? 0,
        gradedCount: detail?.gradedCount ?? 0,
      });
    }
    return { assignments: out };
  });

  app.get('/:id', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const id = idOf(request);
    const row = await app.repos.homework.getAssignment(id);
    if (!row) throw AppError.notFound('作业不存在');
    await loadCourseOrThrow(app.repos, row.assignment.courseId, viewer);
    const manager = await app.repos.courses.isManager(
      row.assignment.courseId,
      viewer.id,
      isAdmin(viewer),
    );

    const mine = await app.repos.homework.getSubmission(id, viewer.id);
    const submissions = manager
      ? await Promise.all(
          (await app.repos.homework.listSubmissions(id)).map(async (s) =>
            submissionDTO(s, await app.repos.homework.fileIdsForSubmission(s.id)),
          ),
        )
      : [];

    return {
      assignment: {
        ...row.assignment,
        mySubmission: mine
          ? submissionDTO(mine, await app.repos.homework.fileIdsForSubmission(mine.id))
          : null,
        submissionCount: row.submissionCount,
        gradedCount: row.gradedCount,
      } satisfies AssignmentDTO,
      submissions,
      canManage: manager,
    };
  });

  app.post('/:id/submit', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const id = idOf(request);
    const row = await app.repos.homework.getAssignment(id);
    if (!row) throw AppError.notFound('作业不存在');
    await loadCourseOrThrow(app.repos, row.assignment.courseId, viewer);
    if (await app.repos.courses.isManager(row.assignment.courseId, viewer.id, isAdmin(viewer))) {
      throw AppError.badRequest('teacher_cannot_submit', '老师无需提交作业');
    }

    // 已批改的提交是终态：学生不能靠重交把分数/评语冲掉
    const existing = await app.repos.homework.getSubmission(id, viewer.id);
    if (
      existing &&
      (existing.status === 'graded' || existing.score !== null || existing.gradedAt !== null)
    ) {
      throw AppError.conflict('graded', '作业已批改，不能再修改提交');
    }

    // 逾期后不再接受提交或修改（提前提交过的也一样，避免用重交绕过截止时间）
    const now = Date.now();
    if (now > row.assignment.dueAt) {
      throw AppError.conflict('late', '已超过截止时间，无法提交作业');
    }

    const body = SubmitSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_submission', '提交内容不正确');
    const content = body.data.content ?? '';
    const fileIds = body.data.fileIds ?? [];
    if (!content && fileIds.length === 0) {
      throw AppError.badRequest('empty_submission', '请填写答案或上传附件');
    }

    for (const fileId of fileIds) {
      const file = await app.repos.files.getById(fileId);
      if (
        !file ||
        file.ownerId !== viewer.id ||
        file.purpose !== 'homework' ||
        file.courseId !== row.assignment.courseId
      ) {
        throw AppError.badRequest('bad_file', '附件不存在或不属于本次作业');
      }
    }

    await app.repos.homework.upsertSubmission({
      id: randomUUID(),
      assignmentId: id,
      studentId: viewer.id,
      content,
      submittedAt: now,
      fileIds,
    });
    const saved = await app.repos.homework.getSubmission(id, viewer.id);
    if (!saved) throw new AppError(500, 'internal', '提交失败');

    await app.repos.notifications.create({
      id: randomUUID(),
      userId: row.assignment.createdBy,
      kind: 'assignment',
      title: `${viewer.role === 'student' ? '学生' : '用户'}提交了作业：${row.assignment.title}`,
      body: row.assignment.courseTitle,
      link: `assignment:${id}`,
      at: now,
    });

    return { submission: submissionDTO(saved, await app.repos.homework.fileIdsForSubmission(saved.id)) };
  });

  app.post('/:id/grade/:submissionId', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const id = idOf(request);
    const submissionId = idOf(request, 'submissionId');
    const row = await app.repos.homework.getAssignment(id);
    if (!row) throw AppError.notFound('作业不存在');
    if (!(await app.repos.courses.isManager(row.assignment.courseId, viewer.id, isAdmin(viewer)))) {
      throw AppError.forbidden('只有课程老师或助教可以批改作业');
    }
    const body = GradeSchema.safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_grade', '分数必须在 0~1000 之间');
    if (body.data.score > row.assignment.maxScore) {
      throw AppError.badRequest('bad_grade', `分数不能超过满分 ${row.assignment.maxScore}`);
    }
    const submission = await app.repos.homework.getSubmissionById(submissionId);
    if (!submission || submission.assignmentId !== id) throw AppError.notFound('提交记录不存在');

    const now = Date.now();
    await app.repos.homework.gradeSubmission(
      submissionId,
      body.data.score,
      body.data.feedback ?? '',
      viewer.id,
      now,
    );
    await app.repos.notifications.create({
      id: randomUUID(),
      userId: submission.studentId,
      kind: 'grade',
      title: `作业已批改：${row.assignment.title}`,
      body: `得分 ${body.data.score} / ${row.assignment.maxScore}`,
      link: `assignment:${id}`,
      at: now,
    });
    return { ok: true };
  });

  app.delete('/:id', { preHandler: [requireAuth] }, async (request) => {
    const viewer = viewerOf(request);
    const id = idOf(request);
    const row = await app.repos.homework.getAssignment(id);
    if (!row) throw AppError.notFound('作业不存在');
    if (!(await app.repos.courses.isManager(row.assignment.courseId, viewer.id, isAdmin(viewer)))) {
      throw AppError.forbidden('只有课程老师或助教可以删除作业');
    }
    await app.repos.homework.removeAssignment(id);
    return { ok: true };
  });
};
