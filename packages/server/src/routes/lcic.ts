import type { FastifyPluginAsync } from 'fastify';
import type { LcicLaunchDTO, LcicStatusDTO } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { loadCourseOrThrow, type Viewer } from '../lib/teachingAccess';
import { requireAuth } from '../plugins/authGuard';
import { LcicApiError } from '../services/lcicClient';

export const lcicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status', { preHandler: [requireAuth] }, async (): Promise<LcicStatusDTO> => {
    return app.lcic.status();
  });

  /** 返回一次性的腾讯课堂进入地址；仅课程成员/老师/管理员可调用。 */
  app.post(
    '/courses/:courseId/launch',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request): Promise<LcicLaunchDTO> => {
      const claims = request.claims;
      if (!claims) throw AppError.unauthorized();
      const courseId = (request.params as { courseId?: string }).courseId;
      if (!courseId || courseId.length > 64) throw AppError.badRequest('bad_id', '课程 ID 不正确');

      const viewer: Viewer = { id: claims.sub, role: claims.role };
      const course = await loadCourseOrThrow(app.repos, courseId, viewer);
      try {
        return await app.lcic.launch(course, viewer.id);
      } catch (err) {
        if (err instanceof LcicApiError) {
          // 只记录错误码与 RequestId，绝不打印凭据或含 token 的 URL
          request.log.warn(
            { lcicCode: err.code, lcicRequestId: err.requestId },
            '腾讯课堂接口调用失败',
          );
          throw new AppError(502, 'lcic_failed', `腾讯课堂暂时不可用（${err.code}），请稍后再试`);
        }
        throw err;
      }
    },
  );
};
