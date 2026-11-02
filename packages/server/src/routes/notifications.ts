import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { requireAuth } from '../plugins/authGuard';

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [requireAuth] }, async (request) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const q = z.object({ limit: z.coerce.number().int().positive().max(200).optional() }).safeParse(request.query);
    const limit = q.success ? q.data.limit ?? 50 : 50;
    const [items, unread] = await Promise.all([
      app.repos.notifications.list(claims.sub, limit),
      app.repos.notifications.unreadCount(claims.sub),
    ]);
    return { notifications: items, unread };
  });

  app.get('/unread_count', { preHandler: [requireAuth] }, async (request) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    return { unread: await app.repos.notifications.unreadCount(claims.sub) };
  });

  app.post('/:id/read', { preHandler: [requireAuth] }, async (request) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const id = (request.params as { id?: string }).id ?? '';
    if (!id) throw AppError.badRequest('bad_id', '通知 ID 不正确');
    await app.repos.notifications.markRead(id, claims.sub, Date.now());
    return { ok: true };
  });

  app.post('/read_all', { preHandler: [requireAuth] }, async (request) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    await app.repos.notifications.markAllRead(claims.sub, Date.now());
    return { ok: true };
  });
};
