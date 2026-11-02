import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ROLE_LABEL, type AdminOverviewDTO, type AdminUserDTO, type Role } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { requireAdmin, requireAuth } from '../plugins/authGuard';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/overview',
    { preHandler: [requireAuth, requireAdmin] },
    async (): Promise<AdminOverviewDTO> => {
      const now = Date.now();
      const [
        users,
        admins,
        teachers,
        assistants,
        students,
        courses,
        lessons,
        rooms,
        liveRooms,
        assignments,
        messages,
      ] = await Promise.all([
        app.repos.users.count(),
        app.repos.users.countByRole('admin'),
        app.repos.users.countByRole('teacher'),
        app.repos.users.countByRole('assistant'),
        app.repos.users.countByRole('student'),
        app.repos.courses.count(),
        app.repos.lessons.count(),
        app.repos.rooms.count(),
        app.repos.rooms.countLive(),
        app.repos.homework.count(),
        app.repos.messages.countAll(),
      ]);

      const recent = await app.repos.users.list({ limit: 8 });
      return {
        stats: {
          users,
          admins,
          teachers,
          assistants,
          students,
          courses,
          lessons,
          rooms,
          liveRooms,
          assignments,
          messages,
        },
        recentUsers: recent.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          createdAt: u.createdAt,
        })),
        recentCourses: await app.repos.courses.listAll(now, 6),
      };
    },
  );

  app.get('/users', { preHandler: [requireAuth, requireAdmin] }, async (request) => {
    const q = z
      .object({
        search: z.string().trim().max(80).optional(),
        role: z.enum(['admin', 'teacher', 'assistant', 'student']).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(request.query);
    if (!q.success) throw AppError.badRequest('bad_query', '查询参数不正确');
    const opts = q.data;
    const filter = { search: opts.search, role: opts.role };
    const [rows, total] = await Promise.all([
      app.repos.users.list({
        ...filter,
        limit: opts.limit,
        offset: opts.offset,
      }),
      app.repos.users.count(filter),
    ]);
    const users: AdminUserDTO[] = [];
    for (const u of rows) {
      users.push({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        phone: u.phone,
        createdAt: u.createdAt,
        courseCount: await app.repos.users.courseCount(u.id),
      });
    }
    return { users, total };
  });

  app.patch('/users/:id/role', { preHandler: [requireAuth, requireAdmin] }, async (request) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const id = (request.params as { id?: string }).id ?? '';
    if (!id) throw AppError.badRequest('bad_id', '用户 ID 不正确');
    const body = z.object({ role: z.enum(['admin', 'teacher', 'assistant', 'student']) }).safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_role', '角色不正确');

    const user = await app.repos.users.findById(id);
    if (!user) throw AppError.notFound('用户不存在');
    const nextRole: Role = body.data.role;
    if (user.role === nextRole) return { ok: true, role: nextRole };

    if (user.id === claims.sub && nextRole !== 'admin') {
      throw AppError.badRequest('self_demote', '不能取消自己的管理员身份');
    }

    // 「最后一名管理员」检查与角色写入放在同一个事务里，
    // 避免两个管理员并发降级时都看到 count=2 而同时通过。
    const result = await app.repos.users.setRoleGuarded(user.id, nextRole);
    if (result === 'last_admin') {
      throw AppError.conflict('last_admin', '至少需要保留一名管理员');
    }
    if (result === 'not_found') throw AppError.notFound('用户不存在');
    if (result === 'unchanged') return { ok: true, role: nextRole };

    await app.repos.notifications.create({
      id: randomUUID(),
      userId: user.id,
      kind: 'system',
      title: '账号角色已变更',
      body: `你的角色已调整为「${ROLE_LABEL[nextRole]}」`,
      link: '',
      at: Date.now(),
    });
    return { ok: true, role: nextRole };
  });
};
