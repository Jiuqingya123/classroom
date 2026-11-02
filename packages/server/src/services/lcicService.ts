import type { CourseDTO, LcicLaunchDTO, LcicStatusDTO } from '@classroom/shared';
import type { Config } from '../config';
import type { Repos } from '../db/repos';
import type { UserRecord } from '../db/repos/users';
import { AppError } from '../lib/errors';
import { createLcicClient, type LcicClient } from './lcicClient';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;
const ROOM_REUSE_MARGIN_MS = 10 * 60 * 1000;

interface RegisterUserResult {
  UserId?: string;
  Token?: string;
  RequestId?: string;
}

interface LoginUserResult {
  Token?: string;
  UserId?: string;
  RequestId?: string;
}

interface CreateRoomResult {
  RoomId?: number | string;
  RequestId?: string;
}

interface UserBinding {
  lcicUserId: string;
  token: string;
  tokenExpiresAt: number;
}

interface RoomBinding {
  roomId: string;
  endsAt: number;
}

export interface LcicService {
  readonly enabled: boolean;
  readonly sdkAppId: number;
  status(): LcicStatusDTO;
  launch(course: CourseDTO, viewerId: string): Promise<LcicLaunchDTO>;
}

/** 同一用户/课程的并发点击只打一次腾讯接口，避免重复注册和重复建房。 */
function singleFlight<T>(locks: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const running = locks.get(key);
  if (running) return running;
  const task = fn();
  locks.set(key, task);
  task.then(
    () => locks.delete(key),
    () => locks.delete(key),
  );
  return task;
}

/**
 * 腾讯云实时互动-教育版（LCIC）并列入口。
 * 产品已公告 2026-10-30 起停止新购，这里刻意隔离成可整体删除的模块。
 */
export function createLcicService(deps: {
  config: Config;
  repos: Repos;
  client?: LcicClient;
}): LcicService {
  const { config, repos } = deps;
  const { enabled, sdkAppId } = config.lcic;
  const client =
    deps.client ??
    createLcicClient({
      endpoint: config.lcic.endpoint,
      secretId: config.lcic.secretId,
      secretKey: config.lcic.secretKey,
    });

  const userLocks = new Map<string, Promise<UserBinding>>();
  const roomLocks = new Map<string, Promise<RoomBinding>>();

  async function ensureUserUnlocked(user: UserRecord): Promise<UserBinding> {
    const now = Date.now();
    const existing = await repos.lcic.findUser(user.id);

    if (existing && existing.tokenExpiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
      return {
        lcicUserId: existing.lcicUserId,
        token: existing.token,
        tokenExpiresAt: existing.tokenExpiresAt,
      };
    }

    let lcicUserId: string;
    let token: string;

    if (existing) {
      // token 有效期 7 天，临近过期时用 UserId 换新的，不重复注册用户。
      const login = await client.call<LoginUserResult>('LoginUser', { UserId: existing.lcicUserId });
      if (!login.Token) throw new AppError(502, 'lcic_bad_response', '腾讯课堂登录未返回 token');
      lcicUserId = existing.lcicUserId;
      token = login.Token;
    } else {
      const registered = await client.call<RegisterUserResult>('RegisterUser', {
        SdkAppId: sdkAppId,
        Name: user.displayName.slice(0, 64),
        // OriginId 绑定我方用户 ID，腾讯侧再生成自己的 UserId
        OriginId: user.id,
      });
      if (!registered.UserId) {
        throw new AppError(502, 'lcic_bad_response', '腾讯课堂注册未返回 UserId');
      }
      lcicUserId = registered.UserId;
      token = registered.Token ?? '';
      if (!token) {
        const login = await client.call<LoginUserResult>('LoginUser', { UserId: lcicUserId });
        if (!login.Token) throw new AppError(502, 'lcic_bad_response', '腾讯课堂登录未返回 token');
        token = login.Token;
      }
    }

    const tokenExpiresAt = now + TOKEN_TTL_MS - TOKEN_REFRESH_MARGIN_MS;
    await repos.lcic.upsertUser({
      userId: user.id,
      lcicUserId,
      originId: user.id,
      token,
      tokenExpiresAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { lcicUserId, token, tokenExpiresAt };
  }

  function ensureUser(user: UserRecord): Promise<UserBinding> {
    return singleFlight(userLocks, user.id, () => ensureUserUnlocked(user));
  }

  async function ensureRoomUnlocked(course: CourseDTO): Promise<RoomBinding> {
    const now = Date.now();
    const existing = await repos.lcic.findRoom(course.id);
    if (existing && existing.endsAt > now + ROOM_REUSE_MARGIN_MS) {
      return { roomId: existing.roomId, endsAt: existing.endsAt };
    }

    const teacher = await repos.users.findById(course.teacherId);
    if (!teacher) {
      throw new AppError(409, 'lcic_no_teacher', '课程老师不存在，无法创建腾讯课堂');
    }
    const teacherBinding = await ensureUser(teacher);

    // 腾讯要求 StartTime 严格晚于当前时间；留 5 秒抵消双方时钟误差
    const startSec = Math.floor(now / 1000) + 5;
    const endSec = startSec + config.lcic.roomTtlSeconds;
    const created = await client.call<CreateRoomResult>('CreateRoom', {
      SdkAppId: sdkAppId,
      Name: course.title.slice(0, 256),
      StartTime: startSec,
      EndTime: endSec,
      Resolution: 2,
      MaxMicNumber: 6,
      SubType: 'videodoc',
      RoomType: 0,
      TeacherId: teacherBinding.lcicUserId,
    });
    if (created.RoomId === undefined || created.RoomId === null || created.RoomId === '') {
      throw new AppError(502, 'lcic_bad_response', '腾讯课堂创建房间未返回 RoomId');
    }
    const roomId = String(created.RoomId);

    await repos.lcic.upsertRoom({
      courseId: course.id,
      roomId,
      startsAt: startSec * 1000,
      endsAt: endSec * 1000,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { roomId, endsAt: endSec * 1000 };
  }

  function ensureRoom(course: CourseDTO): Promise<RoomBinding> {
    return singleFlight(roomLocks, course.id, () => ensureRoomUnlocked(course));
  }

  return {
    enabled,
    sdkAppId,

    status() {
      return { enabled, sdkAppId: enabled ? String(sdkAppId) : null };
    },

    async launch(course, viewerId) {
      if (!enabled) {
        throw new AppError(503, 'lcic_not_configured', '腾讯课堂未配置或已关闭');
      }
      const user = await repos.users.findById(viewerId);
      if (!user) throw AppError.unauthorized();

      const [binding, room] = await Promise.all([ensureUser(user), ensureRoom(course)]);
      const url = new URL(`https://${config.lcic.classDomain}/latest/class.html`);
      url.searchParams.set('schoolid', String(sdkAppId));
      url.searchParams.set('classid', room.roomId);
      url.searchParams.set('userid', binding.lcicUserId);
      url.searchParams.set('token', binding.token);

      return {
        provider: 'lcic',
        url: url.toString(),
        roomId: room.roomId,
        userId: binding.lcicUserId,
        expiresAt: Math.min(binding.tokenExpiresAt, room.endsAt),
      };
    },
  };
}
