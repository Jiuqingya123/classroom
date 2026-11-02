/**
 * 教学平台冒烟测试：课程 / 课节 / 课件 / 题库 / 作业 / 通知 / 管理后台 / 课堂互动。
 *
 * 用法：先启动服务端，再
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/platform-smoke.mjs
 * 默认打 http://localhost:8080；BASE 指向远程时跳过管理员与落库校验。
 */
import { DatabaseSync } from 'node:sqlite';
import { io } from 'socket.io-client';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const IS_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE);
const API = `${BASE}/api/v1`;
const DB_PATH = process.env.DB_PATH ?? 'packages/server/data/app.db';
const PASSWORD = 'password123';
const stamp = Date.now();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let failures = 0;
let skipped = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}
function skip(name, why) {
  console.log(`⏭  ${name}（${why}）`);
  skipped++;
}

async function req(method, path, body, token, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

async function expectError(method, path, body, token, statusRe, codeRe) {
  const r = await req(method, path, body, token);
  return {
    ...r,
    matched: statusRe.test(String(r.status)) && (!codeRe || codeRe.test(r.data?.error ?? '')),
  };
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { path: '/socket.io', auth: { token }, transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('socket 连接超时')), 8000);
    s.on('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`socket: ${e.message}`));
    });
  });
}

function emitAck(socket, event, payload, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} 超时`)), ms);
    const cb = (r) => {
      clearTimeout(t);
      resolve(r);
    };
    if (payload === undefined) socket.emit(event, cb);
    else socket.emit(event, payload, cb);
  });
}

/** 区分「事件返回 null」和「超时未收到」 */
function onceEvent(socket, event, ms = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      socket.off(event, on);
      resolve({ hit: false, value: null });
    }, ms);
    const on = (value) => {
      clearTimeout(t);
      socket.off(event, on);
      resolve({ hit: true, value });
    };
    socket.on(event, on);
  });
}

async function login(email) {
  const r = await req('POST', '/auth/login', { email, password: PASSWORD });
  if (!r.ok) throw new Error(`登录失败 ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return { ...r.data.tokens, user: r.data.user };
}

const teacherEmail = `t${stamp}@platform.dev`;
const studentEmail = `s${stamp}@platform.dev`;
const peerEmail = `p${stamp}@platform.dev`;
const adminEmail = `a${stamp}@platform.dev`;

console.log('── 账号与课程 ──');
const tReg = await req('POST', '/auth/register', {
  email: teacherEmail,
  password: PASSWORD,
  displayName: '平台老师',
  role: 'teacher',
});
const sReg = await req('POST', '/auth/register', {
  email: studentEmail,
  password: PASSWORD,
  displayName: '平台学生',
  role: 'student',
});
const pReg = await req('POST', '/auth/register', {
  email: peerEmail,
  password: PASSWORD,
  displayName: '旁听学生',
  role: 'student',
});
const aReg = await req('POST', '/auth/register', {
  email: adminEmail,
  password: PASSWORD,
  displayName: '平台管理员',
  role: 'student',
});
check('三类测试账号注册成功', tReg.ok && sReg.ok && pReg.ok && aReg.ok);

const teacher = await login(teacherEmail);
const student = await login(studentEmail);
const peer = await login(peerEmail);

const tTok = teacher.accessToken;
const sTok = student.accessToken;

const cRes = await req('POST', '/courses', { title: '初二数学', subject: '数学' }, tTok);
check('老师创建课程', cRes.status === 201 && cRes.data.course?.id, `status ${cRes.status}`);
const courseId = cRes.data.course.id;

const addMember = await req('POST', `/courses/${courseId}/members`, {
  emails: [studentEmail],
}, tTok);
check('按邮箱加入课程成员', addMember.data.added?.length === 1);
check('不存在的邮箱被列为 missing', (await req('POST', `/courses/${courseId}/members`, {
  emails: [`ghost${stamp}@platform.dev`],
}, tTok)).data.missing?.length === 1);

const sCourses = await req('GET', '/courses', undefined, sTok);
check('学生课程列表包含新课程', sCourses.data.courses?.some((c) => c.id === courseId));

const tDetail = await req('GET', `/courses/${courseId}`, undefined, tTok);
check('课程详情含老师与学生', tDetail.data.members?.length === 2);
check('课程详情返回老师身份', tDetail.data.course?.myRole === 'teacher');

const sDetail = await req('GET', `/courses/${courseId}`, undefined, sTok);
check('学生看课程不含题库管理数据', Array.isArray(sDetail.data.questions) && sDetail.data.questions.length === 0);

/* ── 课件上传、挂载、签名访问 ── */
console.log('── 课件与题库 ──');
const cwForm = new FormData();
cwForm.append('file', new Blob([PNG], { type: 'image/png' }), 'grid.png');
const cwUpload = await req(
  'POST',
  `/files?courseId=${courseId}&purpose=courseware&width=1&height=1`,
  cwForm,
  tTok,
);
check('老师上传课件文件', cwUpload.status === 201 && cwUpload.data.file?.id);
const cwFileId = cwUpload.data.file.id;

const cwLink = await req('POST', `/courses/${courseId}/courseware`, {
  fileId: cwFileId,
  title: '勾股定理示意',
}, tTok);
check('课件挂到课程库', cwLink.status === 201 && cwLink.data.courseware?.url);

const cwUrl = cwLink.data.courseware.url;
const cwFetch = await fetch(cwUrl.startsWith('http') ? cwUrl : `${BASE}${cwUrl}`);
check('签名 URL 可下载课件', cwFetch.ok && (await cwFetch.arrayBuffer()).byteLength === PNG.length);

const sSign = await req('POST', '/files/url', { fileIds: [cwFileId] }, sTok);
check('课程学生可换取课件签名 URL', !!sSign.data.urls?.[cwFileId]);

const outsider = await login(adminEmail);
const oSign = await req('POST', '/files/url', { fileIds: [cwFileId] }, outsider.accessToken);
check('非课程成员无法换取课件 URL', !oSign.data.urls?.[cwFileId]);

const qRes = await req('POST', `/courses/${courseId}/questions`, {
  type: 'single',
  stem: '直角三角形两直角边为 3、4，斜边是多少？',
  options: [
    { key: 'A', text: '5' },
    { key: 'B', text: '6' },
    { key: 'C', text: '7' },
  ],
  answer: ['A'],
  analysis: '3² + 4² = 5²',
}, tTok);
check('题库新增单选题', qRes.status === 201 && qRes.data.question?.id);
const questionId = qRes.data.question.id;

const sQ = await req('GET', `/courses/${courseId}/questions`, undefined, sTok);
check('学生不能读取题库管理列表', sQ.status === 403, `status ${sQ.status}`);

/* ── 课节：进入时间窗与冲突检测 ── */
console.log('── 课节 ──');
const soon = Date.now() + 60_000;
const lessonRes = await req('POST', `/courses/${courseId}/lessons`, {
  title: '勾股定理（直播）',
  startsAt: soon,
  durationMin: 45,
}, tTok);
check('老师创建课节', lessonRes.status === 201 && lessonRes.data.lesson?.roomId);
const lesson = lessonRes.data.lesson;

const sEnter = await req('POST', `/lessons/${lesson.id}/enter`, {}, sTok);
check('开课前 15 分钟内学生可进入', sEnter.ok && sEnter.data.roomId === lesson.roomId);

const far = Date.now() + 2 * 60 * 60 * 1000;
const futureRes = await req('POST', `/courses/${courseId}/lessons`, {
  title: '两小时后的课',
  startsAt: far,
  durationMin: 45,
}, tTok);
const futureLesson = futureRes.data.lesson;
check('创建未来课节', futureRes.status === 201);

const tooEarly = await expectError('POST', `/lessons/${futureLesson.id}/enter`, {}, sTok, /403/, /too_early/);
check('距开课超过 15 分钟学生被拒', tooEarly.matched, `status ${tooEarly.status} ${tooEarly.data?.error}`);

const staffEarly = await req('POST', `/lessons/${futureLesson.id}/enter`, {}, tTok);
check('老师不受 15 分钟限制', staffEarly.ok);

const conflict = await expectError('PATCH', `/lessons/${futureLesson.id}`, {
  startsAt: soon + 5 * 60_000,
  durationMin: 45,
}, tTok, /409/, /time_conflict/);
check('课节时间冲突被拒绝', conflict.matched, `status ${conflict.status} ${conflict.data?.error}`);

const cancelRes = await req('POST', `/lessons/${futureLesson.id}/cancel`, {}, tTok);
check('老师取消未来课节', cancelRes.ok);
const cancelledEnter = await expectError('POST', `/lessons/${futureLesson.id}/enter`, {}, sTok, /409/, /cancelled/);
check('已取消课节不能进入', cancelledEnter.matched, `status ${cancelledEnter.status}`);

const sLessons = await req('GET', '/lessons/history', undefined, sTok);
check('历史课节接口返回数组', Array.isArray(sLessons.data.lessons));

/* ── 作业：附件、提交、批改 ── */
console.log('── 作业 ──');
const hwForm = new FormData();
hwForm.append('file', new Blob([Buffer.from('我的作业答案')], { type: 'text/plain' }), 'answer.txt');
const hwUpload = await req(
  'POST',
  `/files?courseId=${courseId}&purpose=homework`,
  hwForm,
  sTok,
);
check('学生上传作业附件', hwUpload.status === 201 && hwUpload.data.file?.id);
const hwFileId = hwUpload.data.file.id;

const asgRes = await req('POST', `/courses/${courseId}/assignments`, {
  title: '勾股定理练习',
  description: '完成第 1~3 题',
  dueAt: Date.now() + 60 * 60 * 1000,
  maxScore: 100,
  lessonId: lesson.id,
}, tTok);
check('老师发布作业', asgRes.status === 201 && asgRes.data.assignment?.id);
const assignmentId = asgRes.data.assignment.id;

const badGrade = await expectError(
  'POST',
  `/assignments/${assignmentId}/grade/not-exist`,
  { score: 90 },
  sTok,
  /403/,
);
check('学生不能批改作业', badGrade.matched, `status ${badGrade.status}`);

const submitRes = await req('POST', `/assignments/${assignmentId}/submit`, {
  content: '斜边是 5',
  fileIds: [hwFileId],
}, sTok);
check('学生提交作业（含附件）', submitRes.ok && submitRes.data.submission?.fileIds?.length === 1);
const submissionId = submitRes.data.submission.id;

const resubmitRes = await req('POST', `/assignments/${assignmentId}/submit`, {
  content: '斜边是 5（订正）',
  fileIds: [hwFileId],
}, sTok);
check(
  '未批改时可重新提交，状态仍为 submitted',
  resubmitRes.ok &&
    resubmitRes.data.submission?.id === submissionId &&
    resubmitRes.data.submission?.status === 'submitted' &&
    resubmitRes.data.submission?.score === null,
  `status ${resubmitRes.status} ${resubmitRes.data?.submission?.status}`,
);

const asgDetail = await req('GET', `/assignments/${assignmentId}`, undefined, tTok);
check('老师看到提交列表', asgDetail.data.submissions?.length === 1 && asgDetail.data.canManage === true);

const gradeRes = await req('POST', `/assignments/${assignmentId}/grade/${submissionId}`, {
  score: 90,
  feedback: '思路正确',
}, tTok);
check('老师批改作业', gradeRes.ok);

const sAsg = await req('GET', `/assignments/${assignmentId}`, undefined, sTok);
const mine = sAsg.data.assignment?.mySubmission;
check('学生看到批改结果', mine?.status === 'graded' && mine?.score === 90);

const regradeResubmit = await expectError('POST', `/assignments/${assignmentId}/submit`, {
  content: '改成正确答案',
}, sTok, /409/, /graded/);
check('已批改后禁止重新提交', regradeResubmit.matched, `status ${regradeResubmit.status} ${regradeResubmit.data?.error}`);

const afterRegrade = await req('GET', `/assignments/${assignmentId}`, undefined, sTok);
check(
  '拒绝重交后成绩未被清空',
  afterRegrade.data.assignment?.mySubmission?.status === 'graded' &&
    afterRegrade.data.assignment?.mySubmission?.score === 90,
  `${afterRegrade.data.assignment?.mySubmission?.status} ${afterRegrade.data.assignment?.mySubmission?.score}`,
);

const teacherFileSign = await req('POST', '/files/url', { fileIds: [hwFileId] }, tTok);
check('老师可换取学生作业附件 URL', !!teacherFileSign.data.urls?.[hwFileId]);

// 截止时间刚到：先用短截止作业把服务端等过截止点，再提交应被拒绝
const lateAsgRes = await req('POST', `/courses/${courseId}/assignments`, {
  title: '限时作业',
  dueAt: Date.now() + 2000,
  maxScore: 10,
}, tTok);
check('老师发布短截止作业', lateAsgRes.status === 201 && lateAsgRes.data.assignment?.id);
const lateAssignment = lateAsgRes.data.assignment;

// 用服务端返回的 createdAt 校正时钟偏差，避免远程 smoke 因两端时钟不一致误判
const serverSkew = lateAssignment.createdAt - Date.now();
const waitMs = Math.max(0, lateAssignment.dueAt - (Date.now() + serverSkew)) + 300;
await new Promise((r) => setTimeout(r, waitMs));
const lateSubmit = await expectError('POST', `/assignments/${lateAssignment.id}/submit`, {
  content: '迟交的答案',
}, sTok, /409/, /late/);
check('逾期提交被拒绝', lateSubmit.matched, `status ${lateSubmit.status} ${lateSubmit.data?.error}`);

const lateDetail = await req('GET', `/assignments/${lateAssignment.id}`, undefined, sTok);
check('逾期提交未落库', lateDetail.data.assignment?.mySubmission === null);

/* ── 通知 ── */
console.log('── 通知 ──');
const n1 = await req('GET', '/notifications', undefined, sTok);
check('学生收到课程/课节/作业通知', (n1.data.notifications?.length ?? 0) >= 3, `${n1.data.unread ?? 0} 未读`);
const unreadBefore = n1.data.unread;
const firstNote = n1.data.notifications?.[0];
if (firstNote) {
  await req('POST', `/notifications/${firstNote.id}/read`, {}, sTok);
  const n2 = await req('GET', '/notifications/unread_count', undefined, sTok);
  check('单条已读后未读数下降', n2.data.unread === unreadBefore - 1, `${unreadBefore} → ${n2.data.unread}`);
}
await req('POST', '/notifications/read_all', {}, sTok);
const n3 = await req('GET', '/notifications/unread_count', undefined, sTok);
check('全部已读', n3.data.unread === 0);

/* ── 课堂互动 ── */
console.log('── 课堂互动 ──');
const roomRes = await req('POST', '/rooms', { title: '互动冒烟教室' }, tTok);
const room = roomRes.data.room;
check('创建互动测试课堂', !!room?.id && /^\d{6}$/.test(room.joinCode));

const tSock = await connectSocket(teacher.rtcToken);
const sSock = await connectSocket(student.rtcToken);
const pSock = await connectSocket(peer.rtcToken);
const tJoin = await emitAck(tSock, 'room:join', { roomId: room.id, code: room.joinCode });
const sJoin = await emitAck(sSock, 'room:join', { roomId: room.id, code: room.joinCode });
const pJoin = await emitAck(pSock, 'room:join', { roomId: room.id, code: room.joinCode });
check('老师与学生进入互动课堂', tJoin.ok && sJoin.ok && pJoin.ok && pJoin.participants?.length === 3);

// 举手 → 老师批准
const handEvent = onceEvent(tSock, 'member:updated');
sSock.emit('presence:media', { hasVideo: false, hasAudio: false, sharing: false, handRaised: true });
const handUpd = await handEvent;
check('学生举手广播给老师', handUpd.hit && handUpd.value.participant?.handRaisedAt, handUpd.value?.participant?.displayName);

const approveEvent = onceEvent(sSock, 'room:control');
const approveAck = await emitAck(tSock, 'room:control', {
  action: 'approve_hand',
  targetId: sReg.data.user.id,
});
const approve = await approveEvent;
check('老师批准举手', approveAck.ok && approve.value?.action === 'approve_hand');

// 私聊：学生 → 老师；旁听学生不应收到
const teacherChat = onceEvent(tSock, 'chat:message');
const peerChatLeak = onceEvent(pSock, 'chat:message', 800);
const privateAck = await emitAck(sSock, 'chat:send', {
  content: '老师，这一步没听懂',
  toUserId: tReg.data.user.id,
});
const privateMsg = await teacherChat;
const leaked = await peerChatLeak;
check('学生私聊老师可达', privateAck.ok && privateMsg.value?.toUserId === tReg.data.user.id);
check('私聊不会广播给其他学生', !leaked.hit);

const publicChatAtPeer = onceEvent(pSock, 'chat:message');
await emitAck(sSock, 'chat:send', { content: '大家能听到吗' });
const publicMsg = await publicChatAtPeer;
check('全班消息广播给旁听学生', publicMsg.value?.content === '大家能听到吗');

// 公告
const annEvent = onceEvent(sSock, 'room:announce');
const annAck = await emitAck(tSock, 'room:announce', { content: '五分钟后进入练习环节' });
const ann = await annEvent;
check('公告实时下发', annAck.ok && ann.value?.content?.includes('五分钟'));

// 计时器
const timerEvent = onceEvent(sSock, 'timer:state');
const timerAck = await emitAck(tSock, 'timer:start', { mode: 'countdown', durationSec: 60 });
const timer = await timerEvent;
check('倒计时开始并同步', timerAck.ok && timer.value?.mode === 'countdown' && timer.value?.running === true);
const timerStopEvent = onceEvent(sSock, 'timer:state');
const timerStopAck = await emitAck(tSock, 'timer:stop');
const timerStop = await timerStopEvent;
check('计时器停止同步', timerStopAck.ok && timerStop.hit && timerStop.value === null);

// 签到
const signinStartEvent = onceEvent(sSock, 'signin:state');
const signinStartAck = await emitAck(tSock, 'signin:start', { durationSec: 60 });
const signinStart = await signinStartEvent;
check('老师发起签到', signinStartAck.ok && signinStart.value?.done === false);

const signinUpdateAtTeacher = onceEvent(tSock, 'signin:state');
const markAck = await emitAck(sSock, 'signin:mark');
const signinAfterMark = await signinUpdateAtTeacher;
check('学生签到成功且老师看到人数', markAck.ok && signinAfterMark.value?.signedCount === 1);

const signinEndEvent = onceEvent(sSock, 'signin:state');
const signinEndAck = await emitAck(tSock, 'signin:end');
const signinEnd = await signinEndEvent;
check('签到结束状态同步', signinEndAck.ok && signinEnd.value?.done === true);

// 答题
const quizStartEvent = onceEvent(sSock, 'quiz:state');
const quizStartAck = await emitAck(tSock, 'quiz:start', {
  questionId,
  stem: '直角三角形两直角边为 3、4，斜边是多少？',
  type: 'single',
  options: [
    { key: 'A', text: '5' },
    { key: 'B', text: '6' },
    { key: 'C', text: '7' },
  ],
  correctAnswer: ['A'],
  analysis: '勾股定理',
  durationSec: 30,
});
const quizStart = await quizStartEvent;
check('老师发起答题', quizStartAck.ok && quizStart.value?.type === 'single');
const quizId = quizStart.value?.quizId;

const answeredAtTeacher = onceEvent(tSock, 'quiz:state');
const answerAck = await emitAck(sSock, 'quiz:answer', { quizId, answer: ['A'] });
const answered = await answeredAtTeacher;
check('学生作答后老师看到答题人数', answerAck.ok && answered.value?.answeredCount === 1);

const sResultEvent = onceEvent(sSock, 'quiz:result');
const tResultEvent = onceEvent(tSock, 'quiz:result');
const quizEndAck = await emitAck(tSock, 'quiz:end', { quizId });
const sResult = await sResultEvent;
const tResult = await tResultEvent;
check('答题结果包含正确答案与统计', quizEndAck.ok && sResult.value?.correctAnswer?.includes('A'));
check('老师结果包含逐人作答', Array.isArray(tResult.value?.answers) && tResult.value.answers.length === 1);
check('学生结果不含逐人名单', !sResult.value?.answers);

// 奖励
const awardEvent = onceEvent(sSock, 'room:award');
const awardAck = await emitAck(tSock, 'room:award', {
  toUserId: sReg.data.user.id,
  kind: 'star',
  points: 2,
  remark: '回答清晰',
});
const award = await awardEvent;
check('奖励实时下发且带发放人', awardAck.ok && award.value?.by === tReg.data.user.id && award.value?.totalForUser === 2);

const memberAfterAward = onceEvent(tSock, 'member:updated');
await emitAck(tSock, 'room:award', {
  toUserId: sReg.data.user.id,
  kind: 'trophy',
  points: 3,
});
const awardedMember = await memberAfterAward;
check('成员奖励数累加', awardedMember.value?.participant?.rewardCount === 5, `${awardedMember.value?.participant?.rewardCount}`);

// 随机选人
const pickEvent = onceEvent(pSock, 'room:picked');
const pickAck = await emitAck(tSock, 'room:random_pick');
const picked = await pickEvent;
check('随机选人只选学生', pickAck.ok && [sReg.data.user.id, pReg.data.user.id].includes(pickAck.userId));
check('随机选人广播到课堂', picked.hit && picked.value?.userId === pickAck.userId);

// 全员静音与被强制静音的联动
const muteAllEvent = onceEvent(sSock, 'room:control');
const muteAllAck = await emitAck(tSock, 'room:control', { action: 'mute_all' });
const muteAll = await muteAllEvent;
check('全员静音广播权威状态', muteAllAck.ok && muteAll.value?.allMuted === true);

const forceMuteEvent = onceEvent(sSock, 'room:control');
sSock.emit('presence:media', { hasVideo: false, hasAudio: true, sharing: false, handRaised: false });
const forceMute = await forceMuteEvent;
check('静音状态下学生开麦被强制关闭', forceMute.value?.action === 'mute' && forceMute.value?.by === 'system');

const unmuteAllEvent = onceEvent(sSock, 'room:control');
const unmuteAllAck = await emitAck(tSock, 'room:control', { action: 'unmute_all' });
const unmuteAll = await unmuteAllEvent;
check('解除全员静音', unmuteAllAck.ok && unmuteAll.value?.allMuted === false);

// 踢人
const kickEvent = onceEvent(pSock, 'room:kicked');
const kickAck = await emitAck(tSock, 'room:control', {
  action: 'kick',
  targetId: pReg.data.user.id,
});
const kicked = await kickEvent;
check('老师移出学生', kickAck.ok && kicked.hit);

await new Promise((r) => setTimeout(r, 300));
const pSock2 = await connectSocket(peer.rtcToken);
const pRejoin = await emitAck(pSock2, 'room:join', { roomId: room.id, code: room.joinCode });
const pHistory = pRejoin.history ?? [];
check('被移出后重新凭码可进', pRejoin.ok === true);
check('历史消息按可见范围过滤（不含他人私聊）', !pHistory.some((m) => m.content.includes('没听懂')));

// 课堂权限按房间算：全局老师凭码旁听，不能拿到教学管控能力
const guestEmail = `g${stamp}@platform.dev`;
await req('POST', '/auth/register', {
  email: guestEmail,
  password: PASSWORD,
  displayName: '旁听老师',
  role: 'teacher',
});
const guest = await login(guestEmail);
const gSock = await connectSocket(guest.rtcToken);
const gJoin = await emitAck(gSock, 'room:join', { roomId: room.id, code: room.joinCode });
check('课堂教师 isStaff 为 true', tJoin.self?.isStaff === true);
check('全局老师凭码进房但不是课堂教师', gJoin.ok === true && gJoin.self?.isStaff === false);
const gMute = await emitAck(gSock, 'room:control', { action: 'mute_all' });
check('非课堂教师不能全员静音', gMute.ok === false && gMute.error === 'forbidden');
const gTimer = await emitAck(gSock, 'timer:start', { mode: 'countdown', durationSec: 30 });
check('非课堂教师不能发起计时', gTimer.ok === false && gTimer.error === 'forbidden');
const gPrivate = await emitAck(gSock, 'chat:send', {
  content: '你好',
  toUserId: sReg.data.user.id,
});
check('非课堂教师不能私聊学生', gPrivate.ok === false && gPrivate.error === 'private_denied');
gSock.close();

const ended = await emitAck(tSock, 'room:end');
check('老师结束互动课堂', ended.ok);

tSock.close();
sSock.close();
pSock.close();
pSock2.close();

/* ── 管理后台 ── */
console.log('── 管理后台 ──');
if (!IS_LOCAL) {
  skip('管理后台接口', '目标为远程环境，无法在本地提权测试账号');
} else {
  const db = new DatabaseSync(DB_PATH);
  db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', adminEmail);
  db.close();

  const admin = await login(adminEmail);
  const overview = await req('GET', '/admin/overview', undefined, admin.accessToken);
  check('管理员读取总览', overview.ok && overview.data.stats?.users >= 4, `用户 ${overview.data.stats?.users}`);

  const search = await req(
    'GET',
    `/admin/users?search=${encodeURIComponent(teacherEmail)}`,
    undefined,
    admin.accessToken,
  );
  check('管理员搜索账号', search.ok && search.data.users?.length === 1);

  const selfDemote = await expectError(
    'PATCH',
    `/admin/users/${admin.user.id}/role`,
    { role: 'student' },
    admin.accessToken,
    /400/,
    /self_demote/,
  );
  check('管理员不能取消自己', selfDemote.matched, `status ${selfDemote.status}`);

  const demote = await req('PATCH', `/admin/users/${tReg.data.user.id}/role`, {
    role: 'assistant',
  }, admin.accessToken);
  const promoteBack = await req('PATCH', `/admin/users/${tReg.data.user.id}/role`, {
    role: 'teacher',
  }, admin.accessToken);
  check('管理员调整用户角色', demote.ok && promoteBack.ok);
}

/* ── 落库校验 ── */
if (IS_LOCAL) {
  console.log('── 落库校验 ──');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const cwRow = db.prepare('SELECT purpose, course_id FROM files WHERE id = ?').get(cwFileId);
  check('课件文件归属课程', cwRow?.purpose === 'courseware' && cwRow?.course_id === courseId);

  const hwRow = db.prepare('SELECT purpose, course_id FROM files WHERE id = ?').get(hwFileId);
  check('作业附件归属课程', hwRow?.purpose === 'homework' && hwRow?.course_id === courseId);

  const asgRow = db.prepare('SELECT title FROM assignments WHERE id = ?').get(assignmentId);
  check('作业已落库', asgRow?.title === '勾股定理练习');

  const subRow = db
    .prepare('SELECT status, score FROM assignment_submissions WHERE id = ?')
    .get(submissionId);
  check('提交记录已批改落库', subRow?.status === 'graded' && subRow?.score === 90);

  const lessonRow = db.prepare('SELECT status FROM lessons WHERE id = ?').get(futureLesson.id);
  check('取消课节状态已落库', lessonRow?.status === 'cancelled');

  const dmRow = db
    .prepare('SELECT to_user_id FROM messages WHERE room_id = ? AND content LIKE ?')
    .get(room.id, '%没听懂%');
  check('私聊目标已落库', dmRow?.to_user_id === tReg.data.user.id);

  const noteRow = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?')
    .get(sReg.data.user.id);
  check('通知已落库', noteRow.n >= 3, `${noteRow.n} 条`);

  const activityRow = db
    .prepare("SELECT COUNT(*) AS n FROM room_activities WHERE room_id = ? AND kind = 'award'")
    .get(room.id);
  check('课堂奖励活动已落库', activityRow.n === 2, `${activityRow.n} 条`);

  const signinRow = db
    .prepare('SELECT COUNT(*) AS n FROM room_signins WHERE room_id = ?')
    .get(room.id);
  check('签到记录已落库', signinRow.n === 1, `${signinRow.n} 条`);

  db.close();
} else {
  skip('落库校验', '目标为远程环境');
}

console.log('');
if (failures === 0) {
  console.log(`全部通过 🎉${skipped ? `（${skipped} 项跳过）` : ''}`);
} else {
  console.log(`${failures} 项失败`);
  process.exitCode = 1;
}
