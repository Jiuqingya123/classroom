import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AuthResult,
  AuthTokens,
  LoginInput,
  RegisterInput,
  Role,
  UpdateProfileInput,
  UserDTO,
} from '@classroom/shared';
import type { Config } from '../config';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password';
import type { Repos } from '../db/repos';
import { toUserDTO } from '../db/repos/users';
import { AppError } from '../lib/errors';

export interface TokenClaims {
  sub: string;
  role: Role;
  name: string;
  scope: 'access' | 'rtc';
}

export interface AuthService {
  register(input: RegisterInput): Promise<AuthResult>;
  login(input: LoginInput): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<AuthResult>;
  logout(refreshToken: string): Promise<void>;
  verifyToken(token: string, scope: 'access' | 'rtc'): TokenClaims;
  updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDTO>;
  changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void>;
  ensureAdmin(email: string, password: string, displayName?: string): Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?\d{6,20}$/;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function createAuthService(deps: {
  config: Config;
  repos: Repos;
  sign: (claims: TokenClaims, ttlSeconds: number) => string;
  verify: (token: string) => unknown;
}): AuthService {
  const { config, repos } = deps;

  async function issue(user: { id: string; role: Role; displayName: string }): Promise<AuthTokens> {
    const accessToken = deps.sign(
      { sub: user.id, role: user.role, name: user.displayName, scope: 'access' },
      config.accessTtl,
    );
    const rtcToken = deps.sign(
      { sub: user.id, role: user.role, name: user.displayName, scope: 'rtc' },
      config.rtcTtl,
    );

    const raw = randomBytes(32).toString('base64url');
    const now = Date.now();
    await repos.tokens.insert(randomUUID(), user.id, sha256(raw), now + config.refreshTtlMs, now);

    return {
      accessToken,
      rtcToken,
      refreshToken: raw,
      accessExpiresIn: config.accessTtl,
      rtcExpiresIn: config.rtcTtl,
    };
  }

  return {
    async register(input) {
      const email = input.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw AppError.badRequest('bad_email', '邮箱格式不正确');
      if (input.password.length < 8) throw AppError.badRequest('weak_password', '密码至少 8 位');
      const displayName = input.displayName.trim();
      if (displayName.length < 1 || displayName.length > 24) {
        throw AppError.badRequest('bad_name', '昵称需在 1~24 个字符之间');
      }
      // 自助注册只允许老师/学生；管理员与助教由管理后台分配
      const role: Role = input.role === 'teacher' ? 'teacher' : 'student';

      const existing = await repos.users.findByEmail(email);
      if (existing) throw AppError.conflict('email_taken', '该邮箱已注册');

      const passwordHash = await hashPassword(input.password);
      const record = {
        id: randomUUID(),
        email,
        displayName,
        role,
        passwordHash,
        phone: null,
        bio: '',
        createdAt: Date.now(),
      };
      await repos.users.insert(record);

      return { user: toUserDTO(record), tokens: await issue(record) };
    },

    async login(input) {
      const identifier = input.email.trim().toLowerCase();
      const byEmail = identifier.includes('@');
      const user = byEmail
        ? await repos.users.findByEmail(identifier)
        : await repos.users.findByPhone(identifier);
      // 不论用户是否存在都做一次等量耗时的校验，避免通过响应时间枚举账号
      let ok = false;
      if (user) {
        ok = await verifyPassword(user.passwordHash, input.password);
      } else {
        await burnPasswordCheck(input.password);
      }
      if (!user || !ok) throw AppError.unauthorized('邮箱/手机号或密码不正确');

      return { user: toUserDTO(user), tokens: await issue(user) };
    },

    async refresh(refreshToken) {
      const now = Date.now();
      const found = await repos.tokens.findValid(sha256(refreshToken), now);
      if (!found) throw AppError.unauthorized('登录已失效，请重新登录');

      const user = await repos.users.findById(found.userId);
      if (!user) throw AppError.unauthorized('账号不存在');

      // 轮换：撤销必须是原子的。否则两个并发请求会同时通过 findValid，
      // 各换出一套新令牌 —— 旧令牌被重放时依然有效。
      const revoked = await repos.tokens.revoke(found.id, now);
      if (!revoked) throw AppError.unauthorized('登录已失效，请重新登录');
      return { user: toUserDTO(user), tokens: await issue(user) };
    },

    async logout(refreshToken) {
      const found = await repos.tokens.findValid(sha256(refreshToken), Date.now());
      if (found) await repos.tokens.revoke(found.id, Date.now());
    },

    verifyToken(token, scope) {
      let payload: unknown;
      try {
        payload = deps.verify(token);
      } catch {
        throw AppError.unauthorized('令牌无效或已过期');
      }
      const p = payload as Partial<TokenClaims>;
      if (!p.sub || !p.role || p.scope !== scope) {
        throw AppError.unauthorized('令牌无效');
      }
      return p as TokenClaims;
    },

    async updateProfile(userId, input) {
      const patch: { displayName?: string; phone?: string | null; bio?: string } = {};
      if (input.displayName !== undefined) {
        const name = input.displayName.trim();
        if (name.length < 1 || name.length > 24) {
          throw AppError.badRequest('bad_name', '昵称需在 1~24 个字符之间');
        }
        patch.displayName = name;
      }
      if (input.phone !== undefined) {
        const phone = input.phone.trim();
        if (phone && !PHONE_RE.test(phone)) {
          throw AppError.badRequest('bad_phone', '手机号格式不正确');
        }
        patch.phone = phone || null;
      }
      if (input.bio !== undefined) {
        const bio = input.bio.trim();
        if (bio.length > 200) throw AppError.badRequest('bad_bio', '个人简介不能超过 200 字');
        patch.bio = bio;
      }

      try {
        await repos.users.updateProfile(userId, patch);
      } catch (err) {
        if ((err as Error).message === 'phone_taken') {
          throw AppError.conflict('phone_taken', '该手机号已绑定其他账号');
        }
        throw err;
      }
      const user = await repos.users.findById(userId);
      if (!user) throw AppError.notFound('账号不存在');
      return toUserDTO(user);
    },

    async changePassword(userId, oldPassword, newPassword) {
      if (newPassword.length < 8) throw AppError.badRequest('weak_password', '新密码至少 8 位');
      const user = await repos.users.findById(userId);
      if (!user) throw AppError.notFound('账号不存在');
      const ok = await verifyPassword(user.passwordHash, oldPassword);
      if (!ok) throw AppError.badRequest('bad_password', '当前密码不正确');
      await repos.users.updatePassword(userId, await hashPassword(newPassword));
    },

    async ensureAdmin(email, password, displayName = '系统管理员') {
      const normalized = email.trim().toLowerCase();
      const existing = await repos.users.findByEmail(normalized);
      if (existing) {
        if (existing.role !== 'admin') await repos.users.setRole(existing.id, 'admin');
        return;
      }
      const record = {
        id: randomUUID(),
        email: normalized,
        displayName,
        role: 'admin' as Role,
        passwordHash: await hashPassword(password),
        phone: null,
        bio: '系统内置管理员',
        createdAt: Date.now(),
      };
      await repos.users.insert(record);
    },
  };
}
