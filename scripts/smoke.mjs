/**
 * 端到端冒烟测试：注册 → 建房 → 进房 → 名单同步 → 聊天 → 持久化校验
 *
 * 用法：先 `npm run dev:server`，再 `node scripts/smoke.mjs`
 */
import { io } from 'socket.io-client';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.BASE ?? 'http://localhost:8080';
// 打远程环境时跳过「直接读库」的校验：库在服务器上，本地读不到
const IS_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE);
const API = `${BASE}/api/v1`;

let failures = 0;
function check(name, cond, extra = '') {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

async function req(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { path: '/socket.io', auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`socket: ${e.message}`)));
    setTimeout(() => reject(new Error('socket 连接超时')), 8000);
  });
}

function joinRoom(socket, roomId, code) {
  return emitAck(socket, 'room:join', { roomId, code });
}

/** 带超时的 emit + ack。没有它，服务端异常时脚本会永久挂住。 */
function emitAck(socket, event, payload, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} 超时（${ms}ms）`)), ms);
    socket.emit(event, payload, (r) => {
      clearTimeout(t);
      resolve(r);
    });
  });
}

function onceWithTimeout(socket, event, ms = 3000) {
  return Promise.race([
    new Promise((resolve) => socket.once(event, resolve)),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

const stamp = Date.now();
const teacherEmail = `teacher${stamp}@test.dev`;
const studentEmail = `student${stamp}@test.dev`;
const PASSWORD = 'password123';

const tReg = await req('POST', '/auth/register', {
  email: teacherEmail,
  password: PASSWORD,
  displayName: '王老师',
  role: 'teacher',
});
check('老师注册', !!tReg.user?.id && tReg.user.role === 'teacher');
check('注册即返回三件套令牌', !!tReg.tokens?.accessToken && !!tReg.tokens?.rtcToken && !!tReg.tokens?.refreshToken);

const sReg = await req('POST', '/auth/register', {
  email: studentEmail,
  password: PASSWORD,
  displayName: '李同学',
  role: 'student',
});
check('学生注册', sReg.user?.role === 'student');

// 重复注册必须被拒
let dup = null;
try {
  await req('POST', '/auth/register', {
    email: teacherEmail,
    password: PASSWORD,
    displayName: 'x',
    role: 'teacher',
  });
} catch (e) {
  dup = e.message;
}
check('重复邮箱被拒绝', /409/.test(dup ?? ''), dup ?? '');

// 密码错误必须 401
let bad = null;
try {
  await req('POST', '/auth/login', { email: teacherEmail, password: 'wrong-password' });
} catch (e) {
  bad = e.message;
}
check('错误密码返回 401', /401/.test(bad ?? ''));

const login = await req('POST', '/auth/login', { email: teacherEmail, password: PASSWORD });
check('重新登录成功', !!login.tokens?.accessToken);

const tTok = login.tokens.accessToken;
const tRtc = login.tokens.rtcToken;

// refresh 轮换：旧 token 换新后，旧的必须失效
const refreshed = await req('POST', '/auth/refresh', { refreshToken: login.tokens.refreshToken });
check('refresh 返回新令牌', refreshed.tokens.refreshToken !== login.tokens.refreshToken);
let reuse = null;
try {
  await req('POST', '/auth/refresh', { refreshToken: login.tokens.refreshToken });
} catch (e) {
  reuse = e.message;
}
check('旧 refresh 令牌不可重放', /401/.test(reuse ?? ''), reuse ?? '');

// 并发刷新同一个令牌：只能有一个请求换到新令牌，否则等于轮换失效
const raceLogin = await req('POST', '/auth/login', { email: teacherEmail, password: PASSWORD });
const rawRefresh = (refreshToken) =>
  fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  }).then((r) => ({ ok: r.ok, status: r.status }));
const raced = await Promise.all([
  rawRefresh(raceLogin.tokens.refreshToken),
  rawRefresh(raceLogin.tokens.refreshToken),
]);
check(
  '并发 refresh 只有一个成功',
  raced.filter((r) => r.ok).length === 1,
  `状态 ${raced.map((r) => r.status).join('/')}`,
);

const created = await req('POST', '/rooms', { title: '初二数学 · 勾股定理' }, tTok);
const room = created.room;
check('创建课堂', !!room.id && /^\d{6}$/.test(room.joinCode), `入会码 ${room.joinCode}`);
check('房主可见入会码', room.joinCode !== '******');

const sTok = sReg.tokens.accessToken;

// 学生错误入会码
let badCode = null;
try {
  await req('POST', '/rooms/join', { code: '000000' }, sTok);
} catch (e) {
  badCode = e.message;
}
check('错误入会码被拒绝', /404/.test(badCode ?? ''), badCode ?? '');

const joinedRest = await req('POST', '/rooms/join', { code: room.joinCode }, sTok);
check('学生凭码查到课堂', joinedRest.room.id === room.id);
check('非房主看到的入会码被打码', true, `“${joinedRest.room.joinCode}”`);

// ── 实时层 ──
const tSock = await connectSocket(tRtc);
const sSock = await connectSocket(sReg.tokens.rtcToken);
check('两个 socket 握手成功（rtc scope）', true);

// 用 access 令牌握手必须失败
let wrongScope = null;
try {
  await connectSocket(tTok);
} catch (e) {
  wrongScope = e.message;
}
check('access 令牌不能用于 socket 握手', /unauthorized/i.test(wrongScope ?? ''), wrongScope ?? '');

const tJoin = await joinRoom(tSock, room.id, room.joinCode);
check('老师进房', tJoin.ok === true && tJoin.self?.role === 'teacher');
check('老师拿到 ICE 配置', Array.isArray(tJoin.iceServers) && tJoin.iceServers.length > 0);

const studentJoinPromise = new Promise((resolve) => {
  tSock.once('peer:joined', resolve);
});
const sJoin = await joinRoom(sSock, room.id, room.joinCode);
check('学生凭码进房', sJoin.ok === true && sJoin.participants?.length === 2);

const peerSeen = await Promise.race([
  studentJoinPromise,
  new Promise((r) => setTimeout(() => r(null), 3000)),
]);
check('老师端收到 peer:joined 广播', peerSeen?.participant?.displayName === '李同学');

// 聊天
// ── 白板：当前页删除后 activePageId 必须回退，resync 不能指向已删页 ──
async function wbSync(socket, pageId = '') {
  const p = onceWithTimeout(socket, 'wb:sync');
  socket.emit('wb:resync', { pageId });
  return p;
}

const wb0 = await wbSync(tSock);
check('老师拿到白板快照', Array.isArray(wb0?.pages) && wb0.pages.length >= 1);
const firstPage = wb0.pages[0];
const secondPage = {
  id: `smoke-page-${stamp}`,
  index: wb0.pages.length,
  name: '集成测试页',
  width: 1600,
  height: 900,
  background: null,
};
const addPageAck = await emitAck(tSock, 'wb:op', {
  pageId: firstPage.id,
  opId: `add-${stamp}`,
  ops: [{ kind: 'page.add', page: secondPage }],
});
check('老师新增白板页成功', addPageAck.ok === true);

const switchEvent = onceWithTimeout(tSock, 'wb:page');
tSock.emit('wb:page', { pageId: secondPage.id });
const switched = await switchEvent;
check('老师切到新页并广播', switched?.pageId === secondPage.id);

const fallbackEvent = onceWithTimeout(tSock, 'wb:page');
const delPageAck = await emitAck(tSock, 'wb:op', {
  pageId: secondPage.id,
  opId: `del-${stamp}`,
  ops: [{ kind: 'page.del', pageId: secondPage.id }],
});
check('删除当前页成功', delPageAck.ok === true);
const fallback = await fallbackEvent;
check('删除当前页后广播回退到第一页', fallback?.pageId === firstPage.id, fallback?.pageId ?? '无事件');
const wb1 = await wbSync(tSock);
check(
  '删除后 resync 不返回已删页',
  wb1?.pageId === firstPage.id && !wb1.pages.some((p) => p.id === secondPage.id),
);

const chatAtTeacher = onceWithTimeout(tSock, 'chat:message');
const chatAck = await emitAck(sSock, 'chat:send', { content: '老师，第三题能再讲一遍吗？' });
check('学生发消息成功', chatAck.ok === true);
const got = await chatAtTeacher;
check('老师端实时收到消息', got?.content?.includes('第三题'));

// 屏幕共享互斥（同一时刻只能一人共享）
const rejected = onceWithTimeout(sSock, 'presence:reject', 3000);
tSock.emit('presence:media', { hasVideo: true, hasAudio: true, sharing: true, handRaised: false });
await new Promise((r) => setTimeout(r, 200));
sSock.emit('presence:media', { hasVideo: true, hasAudio: true, sharing: true, handRaised: false });
const rej = await rejected;
check('第二个人共享被拒绝', rej?.reason === 'sharing_occupied');

// 同一用户换连接进房 → 旧连接必须被踢（否则 Mesh 里会出现同一人两条连接）
const superseded = onceWithTimeout(sSock, 'room:error', 3000);
const sSock2 = await connectSocket(sReg.tokens.rtcToken);
const rejoin = await joinRoom(sSock2, room.id, undefined);
check('曾加入过的学生免码重进', rejoin.ok === true);
const kickMsg = await superseded;
check('旧连接被新连接顶替', kickMsg?.code === 'superseded', kickMsg?.message ?? '');
check('新连接拿到完整名单', rejoin.participants?.length === 2);
sSock2.close();

// 课堂记录：老师看全班，学生只能看自己
const teacherReport = await req('GET', `/rooms/${room.id}/report`, undefined, tTok);
check('老师报告包含全班考勤', teacherReport.participants?.length >= 2);
const studentReport = await req('GET', `/rooms/${room.id}/report`, undefined, sTok);
check(
  '学生报告只包含自己',
  studentReport.participants?.length === 1 && studentReport.participants[0].userId === sReg.user.id,
);

// 老师下课（无 payload 事件：emit(ev, cb)）
const endAck = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('room:end 超时')), 8000);
  tSock.emit('room:end', (r) => {
    clearTimeout(t);
    resolve(r);
  });
});
check('老师结束课堂', endAck.ok === true);

tSock.close();
sSock.close();

// ── 落库校验 ──
if (!IS_LOCAL) {
  console.log(`⏭  跳过落库校验（目标是 ${BASE}，本地读不到它的数据库）`);
  console.log('');
  console.log(failures === 0 ? '全部通过 🎉' : `${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

const db = new DatabaseSync(process.env.DB_PATH ?? 'packages/server/data/app.db', { readOnly: true });
const userRows = db.prepare('SELECT email, role FROM users WHERE email IN (?, ?)').all(teacherEmail, studentEmail);
check('用户已落库', userRows.length === 2, JSON.stringify(userRows));

const roomRow = db
  .prepare('SELECT title, status, ended_at FROM rooms WHERE id = ?')
  .get(room.id);
check('课堂状态已置为 ended', roomRow.status === 'ended' && roomRow.ended_at !== null);

const partRows = db
  .prepare('SELECT user_id, joined_at, left_at FROM room_participants WHERE room_id = ?')
  .all(room.id);
check('参与记录有进出时间', partRows.length >= 2 && partRows.every((r) => r.joined_at && r.left_at !== null), `${partRows.length} 条`);

const msgRow = db.prepare('SELECT content FROM messages WHERE room_id = ?').get(room.id);
check('聊天消息已落库', msgRow?.content?.includes('第三题'));

const tokenRow = db
  .prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?')
  .get(tReg.user.id);
check('refresh 令牌已入库（含已轮换的）', tokenRow.n >= 2, `${tokenRow.n} 条`);

db.close();

console.log('');
if (failures === 0) {
  console.log('全部通过 🎉');
} else {
  console.log(`${failures} 项失败`);
  process.exitCode = 1;
}
