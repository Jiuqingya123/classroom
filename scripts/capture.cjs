/**
 * UI 视觉验收：用 Electron 的 capturePage 抓真实渲染结果。
 *
 * 覆盖：登录、工作台、课程/课程详情、课表、作业、通知、个人中心、设备自检、
 * 管理后台，以及教室成员/互动/聊天/答题/课件/白板。
 *
 * 前置：
 *   1. 服务端已启动（默认 http://localhost:8080）
 *   2. 渲染层已构建，并在 5273 提供静态服务：
 *      python3 -m http.server 5273 --bind 127.0.0.1 --directory apps/desktop/out/renderer
 * 运行：
 *   npx electron --no-sandbox scripts/capture.cjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5273';
const BASE = process.env.BASE ?? 'http://localhost:8080';
const API = `${BASE}/api/v1`;
const OUT = process.env.OUT ?? '/tmp/ui-verify';
const DB_PATH = process.env.DB_PATH ?? 'packages/server/data/app.db';

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILL = `
  window.__fill = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return 'no-el:' + sel;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  };
  'ready';
`;

const js = (win, code) => win.webContents.executeJavaScript(code);

async function shot(win, name) {
  await sleep(250);
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  console.log('saved', file);
}

async function makeWindow(label) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !String(msg).includes('Electron Security')) {
      console.log(`[${label}]`, msg);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[${label}] 页面加载失败`, code, desc, url);
  });
  await win.loadURL(URL);
  await sleep(1500);
  await js(win, FILL);
  win.showInactive();
  await sleep(700);
  return win;
}

async function waitFor(fn, timeout = 20000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      /* 页面切换期间 DOM 可能暂时不可用 */
    }
    await sleep(300);
  }
  console.log('等待超时', label);
  return false;
}

const has = (win, sel) => js(win, `!!document.querySelector(${JSON.stringify(sel)})`);
const count = (win, sel) => js(win, `document.querySelectorAll(${JSON.stringify(sel)}).length`);

async function clickText(win, selector, text) {
  return js(
    win,
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((x) => x.textContent.includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
}

async function nav(win, label) {
  return clickText(win, '.wb-nav-item', label);
}

async function login(win, email, password, waitSel = '.wb') {
  await js(win, `window.__fill('#email', ${JSON.stringify(email)})`);
  await js(win, `window.__fill('#password', ${JSON.stringify(password)})`);
  await sleep(200);
  await js(win, `document.querySelector('form.auth-form button[type=submit]').click()`);
  return waitFor(() => has(win, waitSel), 20000, `登录 ${email}`);
}

async function api(method, pathName, body, token) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function ensureAccount(email, password, displayName, role) {
  const res = await api('POST', '/auth/register', { email, password, displayName, role });
  return res.ok || res.status === 409;
}

async function loginApi(email, password) {
  const r = await api('POST', '/auth/login', { email, password });
  if (!r.ok) throw new Error(`登录失败 ${email}: ${r.status}`);
  return r.data;
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { path: '/socket.io', auth: { token }, transports: ['websocket'] });
    const t = setTimeout(() => reject(new Error('socket 连接超时')), 8000);
    s.on('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on('connect_error', (e) => {
      clearTimeout(t);
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

/** 生成一张课件图，插到白板里能看出不是空白页 */
async function makeWorksheetPng() {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    backgroundColor: '#ffffff',
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#fff}
    .page{width:960px;height:640px;padding:46px 58px;position:relative}
    .tag{display:inline-block;padding:5px 12px;border-radius:999px;background:#eaf1ff;color:#2f6bff;font-size:16px;font-weight:600}
    h1{font-size:44px;margin:18px 0 6px;letter-spacing:1px}
    .sub{font-size:18px;color:#6b7280}
    .rule{height:2px;background:#e5e7eb;margin:22px 0 26px}
    .grid{display:grid;grid-template-columns:1.05fr .95fr;gap:36px}
    .q{font-size:21px;line-height:1.9}
    .q b{color:#2f6bff}
    .blank{display:inline-block;width:90px;border-bottom:2px solid #9ca3af;margin:0 6px}
    .footer{position:absolute;left:58px;right:58px;bottom:26px;display:flex;justify-content:space-between;color:#9ca3af;font-size:14px}
    svg{display:block;margin:0 auto}
  </style></head><body><div class="page">
    <span class="tag">初二数学 · 课堂练习</span>
    <h1>勾股定理</h1>
    <div class="sub">直角三角形两直角边的平方和等于斜边的平方：a² + b² = c²</div>
    <div class="rule"></div>
    <div class="grid">
      <div class="q">
        <div>1. 已知直角边 a = 3，b = 4，斜边 c =<span class="blank"></span></div>
        <div>2. 已知直角边 a = 5，c = 13，另一直角边 b =<span class="blank"></span></div>
        <div>3. 判断：任意三角形都满足 a² + b² = c²（<span class="blank"></span>）</div>
        <div style="margin-top:18px;font-size:17px;color:#6b7280">提示：先画图，再标出直角边与斜边。</div>
      </div>
      <div>
        <svg width="330" height="270" viewBox="0 0 330 270">
          <polygon points="40,220 280,220 280,50" fill="#eff4ff" stroke="#2f6bff" stroke-width="4"/>
          <rect x="250" y="190" width="30" height="30" fill="none" stroke="#1f2937" stroke-width="3"/>
          <text x="150" y="248" font-size="20" fill="#1f2937">b = 4</text>
          <text x="292" y="140" font-size="20" fill="#1f2937">a = 3</text>
          <text x="120" y="120" font-size="20" fill="#ef4444">c = ?</text>
        </svg>
      </div>
    </div>
    <div class="footer"><span>ClassRoom · 互动课堂</span><span>第 1 页 / 共 1 页</span></div>
  </div></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.showInactive();
  await sleep(600);
  const png = (await win.webContents.capturePage()).toPNG();
  win.destroy();
  return png;
}

function promoteAdmin(email) {
  if (!fs.existsSync(DB_PATH)) return false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout = 3000');
    db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', email);
    db.close();
    return true;
  } catch (err) {
    console.log('提权管理员失败', err.message);
    return false;
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const teacher = { email: 'capture.teacher@classroom.dev', password: 'capture123', name: '王老师' };
  const student = { email: 'capture.student@classroom.dev', password: 'capture123', name: '李同学' };
  const co = { email: 'capture.co@classroom.dev', password: 'capture123', name: '陈老师' };
  const admin = { email: 'capture.admin@classroom.dev', password: 'capture123', name: '教务主任' };

  await Promise.all([
    ensureAccount(teacher.email, teacher.password, teacher.name, 'teacher'),
    ensureAccount(student.email, student.password, student.name, 'student'),
    ensureAccount(co.email, co.password, co.name, 'teacher'),
    ensureAccount(admin.email, admin.password, admin.name, 'student'),
  ]);

  const tAuth = await loginApi(teacher.email, teacher.password);
  const sAuth = await loginApi(student.email, student.password);
  const cAuth = await loginApi(co.email, co.password);
  const tTok = tAuth.tokens.accessToken;
  const sTok = sAuth.tokens.accessToken;

  /* ── 准备演示数据 ── */
  const courses = (await api('GET', '/courses', undefined, tTok)).data.courses ?? [];
  let course = courses.find((c) => c.title === '课堂演示 · 勾股定理');
  if (!course) {
    const created = await api('POST', '/courses', {
      title: '课堂演示 · 勾股定理',
      subject: '数学',
      description: '用于界面验收的演示课程：课件、课节、作业、题库一应俱全。',
    }, tTok);
    course = created.data.course;
  }
  const courseId = course.id;
  await api('POST', `/courses/${courseId}/members`, { emails: [student.email] }, tTok);
  // 协作者必须是本课程助教，才能用 socket 触发只有课堂教师能发起的互动。
  // 先删再加以防历史上以学生身份加入过（addMember 对已存在成员是 no-op）。
  const before = (await api('GET', `/courses/${courseId}`, undefined, tTok)).data;
  const oldCo = (before.members ?? []).find((m) => m.email === co.email);
  if (oldCo) await api('DELETE', `/courses/${courseId}/members/${oldCo.userId}`, undefined, tTok);
  await api('POST', `/courses/${courseId}/members`, { emails: [co.email], role: 'assistant' }, tTok);

  let detail = (await api('GET', `/courses/${courseId}`, undefined, tTok)).data;

  if ((detail.courseware ?? []).length === 0) {
    const png = await makeWorksheetPng();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), '勾股定理练习.png');
    const up = await api(
      'POST',
      `/files?courseId=${courseId}&purpose=courseware&width=960&height=640`,
      form,
      tTok,
    );
    if (up.ok) {
      await api('POST', `/courses/${courseId}/courseware`, {
        fileId: up.data.file.id,
        title: '勾股定理 · 课堂练习',
      }, tTok);
      console.log('已上传演示课件');
    }
  }

  if ((detail.questions ?? []).length === 0) {
    await api('POST', `/courses/${courseId}/questions`, {
      type: 'single',
      stem: '直角三角形两直角边为 3、4，斜边是多少？',
      options: [
        { key: 'A', text: '5' },
        { key: 'B', text: '6' },
        { key: 'C', text: '7' },
      ],
      answer: ['A'],
      analysis: '3² + 4² = 25，所以斜边是 5。',
    }, tTok);
  }

  let assignments = (await api('GET', `/courses/${courseId}/assignments`, undefined, tTok)).data.assignments ?? [];
  let assignment = assignments[0];
  if (!assignment) {
    const r = await api('POST', `/courses/${courseId}/assignments`, {
      title: '勾股定理课后练习',
      description: '完成课本第 42 页第 1~5 题，拍照或写清步骤后提交。',
      dueAt: Date.now() + 24 * 60 * 60 * 1000,
      maxScore: 100,
    }, tTok);
    assignment = r.data.assignment;
  }
  if (assignment) {
    await api('POST', `/assignments/${assignment.id}/submit`, {
      content: '第 1 题：c = 5；第 2 题：b = 12；第 3 题：只有直角三角形满足。',
    }, sTok);
    const ad = (await api('GET', `/assignments/${assignment.id}`, undefined, tTok)).data;
    const sub = (ad.submissions ?? []).find((x) => x.status === 'submitted') ?? (ad.submissions ?? [])[0];
    if (sub && sub.status !== 'graded') {
      await api('POST', `/assignments/${assignment.id}/grade/${sub.id}`, {
        score: 94,
        feedback: '步骤完整，注意标注直角边。',
      }, tTok);
    }
  }

  // 课节：只保留一节 15 分钟内可进入的课，避免多次运行后互相冲突
  const fresh = (await api('GET', `/courses/${courseId}`, undefined, tTok)).data;
  const now = Date.now();
  let lesson = (fresh.lessons ?? []).find(
    (l) => l.status === 'scheduled' && l.startsAt > now - 60_000 && l.startsAt < now + 15 * 60_000,
  );
  if (!lesson) {
    for (const l of fresh.lessons ?? []) {
      if (l.status === 'scheduled') {
        await api('PATCH', `/lessons/${l.id}`, { status: 'cancelled' }, tTok);
      }
    }
    const createdAt = await api('POST', `/courses/${courseId}/lessons`, {
      title: '勾股定理 · 直播课',
      startsAt: now + 5 * 60_000,
      durationMin: 45,
    }, tTok);
    if (!createdAt.ok) throw new Error(`创建课节失败：${JSON.stringify(createdAt.data)}`);
    lesson = createdAt.data.lesson;
  }
  const enterInfo = await api('POST', `/lessons/${lesson.id}/enter`, {}, tTok);
  const roomId = enterInfo.data.roomId;
  const joinCode = enterInfo.data.joinCode;
  console.log('演示课堂', roomId, '入会码', joinCode);

  /* ── 登录页 ── */
  const wT = await makeWindow('teacher');
  await shot(wT, '1-login');

  await login(wT, teacher.email, teacher.password);
  await waitFor(() => has(wT, '.wb-hello'), 15000, '工作台');
  await sleep(900);
  await shot(wT, '2-dashboard');

  await nav(wT, '课程');
  await waitFor(() => has(wT, '.course-grid'), 12000, '课程列表');
  await sleep(600);
  await shot(wT, '3-courses');

  await js(wT, `document.querySelector('.course-card')?.click()`);
  await waitFor(() => has(wT, '.course-hero'), 12000, '课程详情');
  await sleep(800);
  await shot(wT, '4-course-detail');

  await clickText(wT, '.tab', '课件');
  await sleep(700);
  await shot(wT, '4b-course-detail-courseware');

  await nav(wT, '课表');
  await waitFor(() => has(wT, '.schedule-groups'), 12000, '课表');
  await sleep(600);
  await shot(wT, '5-schedule');

  await nav(wT, '作业');
  await waitFor(() => has(wT, '.assign-layout'), 12000, '作业');
  await sleep(800);
  await shot(wT, '6-assignments');

  await nav(wT, '通知');
  await waitFor(() => has(wT, '.notify-list'), 12000, '通知');
  await sleep(600);
  await shot(wT, '7-notifications');

  await nav(wT, '个人中心');
  await waitFor(() => has(wT, '.profile-grid'), 12000, '个人中心');
  await sleep(600);
  await shot(wT, '8-profile');

  await clickText(wT, '.wb-nav-item', '设备自检');
  await waitFor(() => has(wT, '.device-preview'), 12000, '设备自检');
  await sleep(1500);
  await shot(wT, '9-device-check');
  await js(wT, `[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('完成'))?.click()`);
  await sleep(500);

  /* ── 管理后台 ── */
  if (promoteAdmin(admin.email)) {
    const wA = await makeWindow('admin');
    await login(wA, admin.email, admin.password);
    await nav(wA, '管理后台');
    await waitFor(() => has(wA, '.admin-stats'), 15000, '管理后台');
    await sleep(900);
    await shot(wA, '10-admin');
    wA.destroy();
  } else {
    console.log('跳过管理后台截图（无法提权或数据库不可用）');
  }

  /* ── 教室 ── */
  await nav(wT, '工作台');
  await waitFor(() => has(wT, '.next-lesson'), 12000, '下一节课');
  await sleep(400);
  await js(wT, `document.querySelector('.next-actions .btn-primary')?.click()`);
  const inRoom = await waitFor(() => has(wT, '.room .sidebar'), 18000, '老师进房');
  await sleep(3500);
  await shot(wT, '11-room-teacher');

  const wS = await makeWindow('student');
  await login(wS, student.email, student.password);
  await waitFor(() => has(wS, '.next-lesson'), 15000, '学生工作台');
  await js(wS, `document.querySelector('.next-actions .btn-primary')?.click()`);
  await waitFor(() => has(wS, '.room .sidebar'), 18000, '学生进房');

  // 协作者用 socket 进房，用来触发只有老师能发起的互动
  const coSock = await connectSocket(cAuth.tokens.rtcToken);
  const coJoin = await emitAck(coSock, 'room:join', { roomId, code: joinCode });
  if (!coJoin.ok) throw new Error(`协作老师进房失败：${coJoin.error}`);
  console.log('协作老师进房', coJoin.self?.isStaff);

  await waitFor(async () => (await count(wT, '.pitem')) >= 3, 12000, '三名成员');
  await sleep(2200);

  await emitAck(coSock, 'room:announce', { content: '请把课本翻到第 42 页，五分钟后进入练习。' });
  await emitAck(coSock, 'timer:start', { mode: 'countdown', durationSec: 300 });
  await emitAck(coSock, 'signin:start', { durationSec: 120 });
  await sleep(500);

  // 学生签到
  await clickText(wS, '.sidebar-tab', '互动');
  await sleep(400);
  await clickText(wS, '.int-action', '课堂签到');
  await sleep(700);

  await emitAck(coSock, 'room:award', {
    toUserId: sAuth.user.id,
    kind: 'star',
    points: 5,
    remark: '准时到课',
  });
  await sleep(500);

  // 成员面板 + 展开学生操作
  await clickText(wT, '.sidebar-tab', '成员');
  await sleep(400);
  await js(wT, `[...document.querySelectorAll('.pitem')].find(el => !el.textContent.includes('（我）'))?.click()`);
  await sleep(400);
  await shot(wT, '12-room-members');

  // 私聊
  await clickText(wT, '.pitem-actions .mini-btn', '私聊');
  await waitFor(() => has(wT, '.chat-target'), 8000, '私聊目标');
  await js(wT, `window.__fill('.chat-input', '李同学，先做第 2 题，做完在聊天里告诉我。')`);
  await sleep(200);
  await js(wT, `document.querySelector('.chat-send')?.click()`);
  await sleep(800);
  await shot(wT, '13-room-chat');

  // 互动面板（计时、签到、奖励）
  await clickText(wT, '.sidebar-tab', '互动');
  await sleep(700);
  await shot(wT, '14-room-interaction');

  // 答题：协作者发起，学生作答，老师结束
  await emitAck(coSock, 'quiz:start', {
    stem: '直角三角形两直角边为 3、4，斜边是多少？',
    type: 'single',
    options: [
      { key: 'A', text: '5' },
      { key: 'B', text: '6' },
      { key: 'C', text: '7' },
    ],
    correctAnswer: ['A'],
    analysis: '3² + 4² = 25，所以斜边是 5。',
    durationSec: 120,
  });
  await waitFor(() => has(wT, '.quiz-overlay'), 12000, '老师答题浮层');
  await waitFor(() => has(wS, '.quiz-overlay'), 12000, '学生答题浮层');
  await sleep(900);
  await shot(wT, '15-quiz-teacher');
  await shot(wS, '15b-quiz-student');

  await js(wS, `document.querySelector('.quiz-option')?.click()`);
  await sleep(250);
  await js(wS, `[...document.querySelectorAll('.quiz-actions .btn')].find(b => b.textContent.includes('提交答案'))?.click()`);
  await sleep(700);
  await js(wT, `[...document.querySelectorAll('.quiz-actions .btn')].find(b => b.textContent.includes('结束答题'))?.click()`);
  await waitFor(() => has(wT, '.quiz-answers'), 10000, '答题结果');
  await waitFor(() => has(wS, '.quiz-option[data-correct="true"]'), 10000, '学生答题结果');
  await sleep(700);
  await shot(wT, '16-quiz-result-teacher');
  await shot(wS, '16b-quiz-result-student');
  await js(wT, `[...document.querySelectorAll('.quiz-actions .btn')].find(b => b.textContent.includes('关闭'))?.click()`);
  await js(wS, `[...document.querySelectorAll('.quiz-actions .btn')].find(b => b.textContent.includes('关闭'))?.click()`);
  await sleep(500);

  // 随机点名
  await emitAck(coSock, 'room:random_pick');
  await waitFor(() => has(wT, '.picked-stage'), 8000, '随机点名');
  await sleep(400);
  await shot(wT, '17-random-pick');

  // 课件 → 白板
  await clickText(wT, 'header .btn', '课件');
  await waitFor(() => has(wT, '.cw-modal'), 12000, '课件弹窗');
  await sleep(900);
  await shot(wT, '18-courseware');
  await js(wT, `document.querySelector('.cw-row .mini-btn.primary')?.click()`);
  await waitFor(() => has(wT, '.wb-panel'), 15000, '白板课件页');
  await sleep(1500);
  await shot(wT, '19-whiteboard-courseware');

  // 回到视频视图
  await clickText(wT, '.room-view-toggle button', '视频');
  await sleep(700);
  await shot(wT, '20-room-final');

  // 助教通过课程取消接口结束课堂：同时覆盖取消课节 → 结束教室 → room:ended 的链路
  const ended = await api('POST', `/lessons/${lesson.id}/cancel`, {}, cAuth.tokens.accessToken);
  console.log('取消课节并结束课堂', ended.ok, ended.data?.error ?? '');
  coSock.close();
  wT.destroy();
  wS.destroy();

  console.log('截图输出目录', OUT);
  app.quit();
});

// 不要监听 window-all-closed：生成课件图片的临时窗口销毁时会把整个验收进程带走
