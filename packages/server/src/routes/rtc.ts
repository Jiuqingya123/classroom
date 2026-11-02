import type { FastifyPluginAsync } from 'fastify';
import type { IceServersResponse } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { requireAuth } from '../plugins/authGuard';

export const rtcRoutes: FastifyPluginAsync = async (app) => {
  /**
   * 动态下发 ICE 配置（STUN + 短效 TURN 凭据）。
   * 绝不在客户端硬编码 —— 硬编码会随 dmg 分发给所有人，等于永久泄露且无法撤销。
   */
  app.get('/ice-servers', { preHandler: [requireAuth] }, async (request): Promise<IceServersResponse> => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    return app.turn.iceServersFor(claims.sub);
  });
};
