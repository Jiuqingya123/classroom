import type { preHandlerHookHandler } from 'fastify';

/**
 * REST 接口鉴权：只接受 scope='access' 的短令牌（15 分钟）。
 * rtc 令牌不能用来调 REST —— 它活 2 小时，泄露面更大。
 */
export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  const header = request.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: '请先登录', statusCode: 401 });
  }

  try {
    request.claims = request.server.auth.verifyToken(token, 'access');
  } catch {
    return reply
      .code(401)
      .send({ error: 'token_expired', message: '登录已过期，请重新登录', statusCode: 401 });
  }
};

/** 教学管理：老师或管理员（助教不能创建课程/课节） */
export const requireTeacher: preHandlerHookHandler = async (request, reply) => {
  const role = request.claims?.role;
  if (role !== 'teacher' && role !== 'admin') {
    return reply
      .code(403)
      .send({ error: 'forbidden', message: '只有老师或管理员可以执行此操作', statusCode: 403 });
  }
};

/** 课堂协作：老师、助教、管理员 */
export const requireStaff: preHandlerHookHandler = async (request, reply) => {
  const role = request.claims?.role;
  if (role !== 'teacher' && role !== 'assistant' && role !== 'admin') {
    return reply
      .code(403)
      .send({ error: 'forbidden', message: '只有教学人员可以执行此操作', statusCode: 403 });
  }
};

export const requireAdmin: preHandlerHookHandler = async (request, reply) => {
  if (request.claims?.role !== 'admin') {
    return reply
      .code(403)
      .send({ error: 'forbidden', message: '只有管理员可以执行此操作', statusCode: 403 });
  }
};
