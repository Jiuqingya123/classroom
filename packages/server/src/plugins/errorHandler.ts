import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors';

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.statusCode)
        .send({ error: err.code, message: err.message, statusCode: err.statusCode });
    }

    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;

    if (status === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: '操作太频繁，请稍后再试', statusCode: 429 });
    }

    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: 'bad_request', message: e.message ?? '请求不正确', statusCode: status });
    }

    // 5xx 不把内部细节抛给客户端
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: '服务器内部错误', statusCode: 500 });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: 'not_found',
      message: `接口不存在: ${request.method} ${request.url}`,
      statusCode: 404,
    });
  });
}
