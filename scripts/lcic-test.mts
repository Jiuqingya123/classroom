/**
 * LCIC 并列入口回归。
 *
 * 离线模式（默认）：未配置凭据时 /status 必须为 disabled，launch 必须 503。
 * 联调模式：设置 LCIC_SDK_APP_ID / LCIC_SECRET_ID / LCIC_SECRET_KEY 后，
 *   会真实注册腾讯侧用户、建房、二次进入并清理。
 *
 * 运行：
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
 *     ./node_modules/tsx/dist/cli.mjs scripts/lcic-test.mts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'lcic-test-'));
process.env['NODE_ENV'] = 'test';
process.env['DB_PATH'] = ':memory:';
process.env['DATA_DIR'] = tmp;
process.env['JWT_SECRET'] = 'lcic-test-secret-at-least-16-chars';
process.env['ADMIN_EMAIL'] = '';
process.env['ADMIN_PASSWORD'] = '';

const live =
  !!process.env['LCIC_SDK_APP_ID'] &&
  !!process.env['LCIC_SECRET_ID'] &&
  !!process.env['LCIC_SECRET_KEY'];

const { loadConfig } = await import('../packages/server/src/config.ts');
const { buildServer } = await import('../packages/server/src/app.ts');
const { createLcicClient } = await import('../packages/server/src/services/lcicClient.ts');

const config = loadConfig();
const app = await buildServer(config);

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const API = '/api/v1';

async function call(
  method: 'GET' | 'POST',
  path: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method,
    url: `${API}${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = res.body;
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
}

const teacher = await app.auth.register({
  email: `lcic-teacher-${Date.now()}@example.com`,
  password: 'test-password-1',
  displayName: 'LCIC 测试老师',
  role: 'teacher',
});
const student = await app.auth.register({
  email: `lcic-student-${Date.now()}@example.com`,
  password: 'test-password-1',
  displayName: 'LCIC 测试学生',
  role: 'student',
});

const courseId = randomUUID();
await app.repos.courses.create({
  id: courseId,
  title: 'LCIC 联调课程',
  subject: '测试',
  description: '',
  teacherId: teacher.user.id,
  cover: '',
  createdAt: Date.now(),
});
await app.repos.courses.addMember(courseId, student.user.id, 'student');

const tToken = teacher.tokens.accessToken;
const sToken = student.tokens.accessToken;

console.log(`\n== 模式：${live ? '联调（会调用腾讯云）' : '离线（未配置凭据）'} ==\n`);

{
  const unauth = await call('GET', '/lcic/status');
  check('status 未登录返回 401', unauth.status === 401);
}

{
  const status = await call('GET', '/lcic/status', tToken);
  check('status 登录后返回 200', status.status === 200, JSON.stringify(status.body).slice(0, 200));
  check(
    `status.enabled = ${String(status.body?.enabled)}（配置=${String(live)}）`,
    status.body?.enabled === live,
  );
  check(
    'disabled 时不暴露 AppId',
    live ? status.body?.sdkAppId === String(config.lcic.sdkAppId) : status.body?.sdkAppId === null,
  );
}

if (!live) {
  const launched = await call('POST', `/lcic/courses/${courseId}/launch`, tToken);
  check('未配置时 launch 返回 503', launched.status === 503);
  check('未配置时错误码为 lcic_not_configured', launched.body?.error === 'lcic_not_configured');
} else {
  const client = createLcicClient({
    endpoint: config.lcic.endpoint,
    secretId: config.lcic.secretId,
    secretKey: config.lcic.secretKey,
  });
  const createdUserIds: string[] = [];
  const testUserIds = new Set([teacher.user.id, student.user.id]);
  let createdRoomId: string | null = null;

  try {
    const first = await call('POST', `/lcic/courses/${courseId}/launch`, tToken);
    check('老师 launch 返回 200', first.status === 200, JSON.stringify(first.body).slice(0, 120));
    if (first.status !== 200) throw new Error('launch 失败，跳过后续检查');
    const l1 = first.body as {
      provider: string;
      url: string;
      roomId: string;
      userId: string;
      expiresAt: number;
    };
    createdRoomId = l1.roomId;
    createdUserIds.push(l1.userId);
    const url = new URL(l1.url);
    check('provider 为 lcic', l1.provider === 'lcic');
    check('URL 指向 class.qcloudclass.com', url.hostname === config.lcic.classDomain);
    check('URL 含 schoolid/classid/userid/token',
      url.searchParams.get('schoolid') === String(config.lcic.sdkAppId) &&
        url.searchParams.get('classid') === l1.roomId &&
        url.searchParams.get('userid') === l1.userId &&
        !!url.searchParams.get('token'));
    check('expiresAt 在未来且不超过 7 天',
      l1.expiresAt > Date.now() && l1.expiresAt <= Date.now() + 7 * 24 * 3600 * 1000);

    const second = await call('POST', `/lcic/courses/${courseId}/launch`, tToken);
    check('老师二次 launch 返回 200', second.status === 200);
    check('二次 launch 复用同一房间', second.body?.roomId === l1.roomId);
    check('二次 launch 复用同一腾讯用户', second.body?.userId === l1.userId);

    const stu = await call('POST', `/lcic/courses/${courseId}/launch`, sToken);
    check('学生 launch 返回 200', stu.status === 200);
    check('学生进入同一房间', stu.body?.roomId === l1.roomId);
    check('学生是独立的腾讯用户', stu.body?.userId !== l1.userId);
    if (stu.body?.userId) createdUserIds.push(stu.body.userId);

    const outsider = await app.auth.register({
      email: `lcic-outsider-${Date.now()}@example.com`,
      password: 'test-password-1',
      displayName: 'LCIC 外部用户',
      role: 'student',
    });
    const denied = await call('POST', `/lcic/courses/${courseId}/launch`, outsider.tokens.accessToken);
    check('非课程成员 launch 被拒绝', denied.status === 404);
  } finally {
    if (createdRoomId) {
      try {
        await client.call('DeleteRoom', { RoomId: Number(createdRoomId) });
        console.log(`CLEAN 已删除腾讯房间 ${createdRoomId}`);
      } catch (err) {
        console.log(`WARN 删除腾讯房间 ${createdRoomId} 失败：${(err as Error).message}`);
      }
    }
    // 即使 launch 在返回前失败，也按 OriginId 兜底清理腾讯侧用户
    try {
      const list = await client.call<{
        Users?: Array<{ UserId?: string; OriginId?: string }>;
      }>('DescribeSdkAppIdUsers', { SdkAppId: config.lcic.sdkAppId, Page: 1, Limit: 100 });
      for (const u of list.Users ?? []) {
        if (u.UserId && u.OriginId && testUserIds.has(u.OriginId)) createdUserIds.push(u.UserId);
      }
    } catch (err) {
      console.log(`WARN 拉取腾讯用户列表失败：${(err as Error).message}`);
    }
    for (const userId of new Set(createdUserIds)) {
      try {
        await client.call('DeleteUser', { UserId: userId });
        console.log(`CLEAN 已删除腾讯用户 ${userId}`);
      } catch (err) {
        console.log(`WARN 删除腾讯用户 ${userId} 失败：${(err as Error).message}`);
      }
    }
  }
}

await app.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
