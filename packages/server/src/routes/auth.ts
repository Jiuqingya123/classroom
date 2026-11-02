import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthResult, UserDTO } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { requireAuth } from '../plugins/authGuard';

const RegisterSchema = z.object({
  email: z.string().min(3).max(120),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(24),
  role: z.enum(['teacher', 'student']),
});

const LoginSchema = z.object({
  email: z.string().min(3).max(120),
  password: z.string().min(1).max(200),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(10) });

const ProfileSchema = z.object({
  displayName: z.string().min(1).max(24).optional(),
  phone: z.string().max(24).optional(),
  bio: z.string().max(200).optional(),
});

const PasswordSchema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

function parse<T>(schema: z.ZodType<T>, data: unknown, code = 'bad_request'): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path.join('.') ?? '';
    throw AppError.badRequest(code, `${field ? `${field}: ` : ''}${first?.message ?? '参数不正确'}`);
  }
  return r.data;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request): Promise<AuthResult> => {
      const input = parse(RegisterSchema, request.body);
      const result = await app.auth.register(input);
      request.log.info({ userId: result.user.id, role: result.user.role }, 'user registered');
      return result;
    },
  );

  app.post(
    '/login',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request): Promise<AuthResult> => {
      const input = parse(LoginSchema, request.body);
      return app.auth.login(input);
    },
  );

  /** 用 refreshToken 换新的三件套（access / rtc / refresh 全轮换） */
  app.post('/refresh', async (request): Promise<AuthResult> => {
    const { refreshToken } = parse(RefreshSchema, request.body);
    return app.auth.refresh(refreshToken);
  });

  app.post('/logout', async (request) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    if (typeof body.refreshToken === 'string' && body.refreshToken.length > 0) {
      await app.auth.logout(body.refreshToken);
    }
    return { ok: true };
  });

  app.get('/me', { preHandler: [requireAuth] }, async (request): Promise<{ user: UserDTO }> => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const user = await app.repos.users.findById(claims.sub);
    if (!user) throw AppError.unauthorized('账号不存在');
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        phone: user.phone,
        bio: user.bio,
        createdAt: user.createdAt,
      },
    };
  });

  app.patch('/me', { preHandler: [requireAuth] }, async (request): Promise<{ user: UserDTO }> => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();
    const input = parse(ProfileSchema, request.body);
    return { user: await app.auth.updateProfile(claims.sub, input) };
  });

  app.post(
    '/password',
    { preHandler: [requireAuth], config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const claims = request.claims;
      if (!claims) throw AppError.unauthorized();
      const input = parse(PasswordSchema, request.body);
      await app.auth.changePassword(claims.sub, input.oldPassword, input.newPassword);
      return { ok: true };
    },
  );
};
