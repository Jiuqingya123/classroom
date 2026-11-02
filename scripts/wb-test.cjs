/**
 * 白板协同自动化验证。
 *
 * 1 老师 + 2 学生同房，验证：
 *  - 广播收敛（三端元素集合/rev/order 完全一致）
 *  - 并发 patch 的 rev 乐观锁（只有一个赢，三端仍收敛）
 *  - 并发 append 的 z 序不撞车
 *  - 老师锁白板后学生的 op 被拒
 *  - 老师翻页全员跟随
 *  - 新客户端进来能拿到全量快照
 *
 * 用法（需先启动服务端与 renderer dev server）：
 *   npx electron --no-sandbox scripts/wb-test.cjs
 */
const { app, BrowserWindow } = require('electron');

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5273';
const BASE = process.env.BASE ?? 'http://localhost:8080';
const API = `${BASE}/api/v1`;

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const FILL = `
  window.__fill = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return 'no-el';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  };
  window.__stroke = (x1, y1, x2, y2, color) => {
    const wb = __classroomDebug.wb();
    const id = crypto.randomUUID();
    wb.addElement({
      id, pageId: wb.activePageId, type: 'pen', rev: 1, order: 'a0',
      x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1,
      points: [x1, y1, x2, y2], stroke: color, strokeWidth: 3, opacity: 1,
      createdBy: wb.selfId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    return id;
  };
  window.__snap = () => {
    const wb = __classroomDebug.wb();
    if (!wb) return null;
    return {
      pages: wb.doc.pages.map(p => p.id),
      active: wb.activePageId,
      seq: wb.seq,
      canDraw: wb.canDraw(),
      studentsCanDraw: wb.studentsCanDraw,
      elements: wb.elementsOnPage().map(e => ({ id: e.id, rev: e.rev, order: e.order, stroke: e.stroke, type: e.type })),
      notice: __classroomDebug.roomState().notice,
    };
  };
  'ready';
`;

const js = (win, code) => win.webContents.executeJavaScript(code);

async function makeWindow(label) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
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
  await win.loadURL(URL);
  await sleep(1400);
  await js(win, FILL);
  return win;
}

async function waitFor(fn, timeout = 15000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(300);
  }
  console.log('[timeout]', label);
  return false;
}

async function login(win, email, password) {
  const hasForm = await waitFor(
    async () => js(win, `!!document.querySelector('#email')`),
    20000,
    `login form ${email}`,
  );
  if (!hasForm) {
    const state = await js(
      win,
      `({ body: document.body.innerText.slice(0, 160), workbench: !!document.querySelector('.wb') })`,
    );
    console.log('   登录页未出现:', JSON.stringify(state));
    // 同一默认会话里已登录时窗口会直接进工作台，算登录成功
    if (state.workbench) return true;
    return false;
  }
  await js(win, `window.__fill('#email', ${JSON.stringify(email)})`);
  await js(win, `window.__fill('#password', ${JSON.stringify(password)})`);
  await sleep(180);
  await waitFor(
    async () => js(win, `!!document.querySelector('form.auth-form button[type=submit]')`),
    8000,
    'login submit',
  );
  await js(win, `document.querySelector('form.auth-form button[type=submit]').click()`);
  return waitFor(async () => js(win, `!!document.querySelector('.wb')`), 15000, `login ${email}`);
}

async function joinByCode(win, code) {
  await waitFor(async () => js(win, `!!document.querySelector('.code-input')`), 10000, 'join input');
  await js(win, `window.__fill('.code-input', ${JSON.stringify(String(code))})`);
  await waitFor(
    async () =>
      js(win, `(() => { const b = document.querySelector('.card .btn-primary'); return !!b && !b.disabled; })()`),
    8000,
    'join button enabled',
  );
  await js(win, `document.querySelector('.card .btn-primary').click()`);
}

async function ensureAccount(email, password, displayName, role) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, role }),
  });
  return res.ok || res.status === 409;
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const sa = a.map((e) => `${e.id}:${e.rev}:${e.order}`).sort();
  const sb = b.map((e) => `${e.id}:${e.rev}:${e.order}`).sort();
  return sa.every((v, i) => v === sb[i]);
}

app.whenReady().then(async () => {
  const stamp = Date.now().toString().slice(-6);
  const accounts = [
    { email: `wt${stamp}@wb.dev`, password: 'password123', name: '王老师', role: 'teacher' },
    { email: `ws1${stamp}@wb.dev`, password: 'password123', name: '张三', role: 'student' },
    { email: `ws2${stamp}@wb.dev`, password: 'password123', name: '李四', role: 'student' },
  ];
  for (const a of accounts) await ensureAccount(a.email, a.password, a.name, a.role);

  const wins = [];
  for (const a of accounts) wins.push(await makeWindow(a.name));
  for (let i = 0; i < 3; i++) {
    const ok = await login(wins[i], accounts[i].email, accounts[i].password);
    check(`${accounts[i].name} 登录`, ok);
  }

  // 建房 + 学生进房
  // 登录后落在工作台，课堂入口在「我的课堂」视图里
  await waitFor(async () => js(wins[0], `!!document.querySelector('.wb-nav-item')`), 15000, 'workbench nav');
  for (const w of wins) {
    await js(
      w,
      `[...document.querySelectorAll('.wb-nav-item')].find(b => b.textContent.includes('我的课堂'))?.click()`,
    );
  }
  await waitFor(async () => js(wins[0], `!!document.querySelector('.card .input')`), 15000, 'classroom page');
  await js(wins[0], `window.__fill('.card .input', '白板测试课堂')`);
  // 等「创建」按钮真的可用再点：填值到按钮解除 disabled 之间有一次 React 状态更新，
  // 网络慢时按钮还是灰的，点了等于没点，且不会报任何错
  const btnReady = await waitFor(
    async () => js(wins[0], `!document.querySelector('.card .btn-primary').disabled`),
    8000,
    'create button enabled',
  );
  check('创建按钮进入可用状态', btnReady);
  await js(wins[0], `document.querySelector('.card .btn-primary').click()`);

  const inRoom = await waitFor(
    async () => js(wins[0], `__classroomDebug.roomState().status === 'joined'`),
    30000,
    'teacher room',
  );
  if (!inRoom) {
    const err = await js(wins[0], `document.querySelector('.alert-error')?.textContent ?? '(无错误提示)'`);
    check('老师建房成功', false, err);
  }
  {
    const st = await js(wins[0], `({
      title: document.querySelector('.room-title')?.textContent,
      status: __classroomDebug.roomState().status,
      error: __classroomDebug.roomState().error,
      hasRoom: !!__classroomDebug.roomState().room,
      notice: __classroomDebug.roomState().notice,
    })`);
    console.log('   建房后状态:', JSON.stringify(st));
  }

  const code = await js(wins[0], `__classroomDebug.roomState().room?.joinCode`);
  check('拿到入会码', /^\d{6}$/.test(String(code)), String(code));

  for (let i = 1; i <= 2; i++) {
    await joinByCode(wins[i], code);
    await waitFor(async () => js(wins[i], `__classroomDebug.peerCount() >= 1`), 30000, `student${i} join`);
  }

  // 等白板全量同步
  const synced = await waitFor(
    async () => {
      const snaps = await Promise.all(wins.map((w) => js(w, `__snap()`)));
      return snaps.every((s) => s && s.pages.length >= 1 && s.active);
    },
    15000,
    'wb sync',
  );
  check('三端都收到白板快照', synced);

  const s0 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  check('初始只有 1 页', s0.every((s) => s.pages.length === 1));
  check('初始当前页一致', s0.every((s) => s.active === s0[0].active));
  check('默认学生可画', s0.every((s) => s.canDraw === true));

  // ── 1. 老师画一笔 → 三端收敛 ──
  const strokeId = await js(wins[0], `__stroke(10, 10, 120, 80, '#ef4444')`);
  await sleep(900);
  const s1 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  check('老师的一笔同步到三端', s1.every((s) => s.elements.length === 1));
  check('三端元素集合与 rev 完全一致', s1.every((s) => sameSet(s.elements, s1[0].elements)));
  check('元素 id 就是发起端生成的 id', s1.every((s) => s.elements[0]?.id === strokeId));
  check('服务端分配了 rev=1', s1.every((s) => s.elements[0]?.rev === 1));

  // ── 2. 并发 append：z 序不撞车 ──
  const [zhangId, liId] = await Promise.all([
    js(wins[1], `__stroke(20, 20, 200, 90, '#0ea5e9')`),
    js(wins[2], `__stroke(30, 30, 260, 100, '#22c55e')`),
  ]);
  check('两个并发追加各拿到自己的元素 id', !!zhangId && !!liId && zhangId !== liId);
  await sleep(1000);
  const s2 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  const orders = s2[0].elements.map((e) => e.order);
  check('并发追加后三端都有 3 个元素', s2.every((s) => s.elements.length === 3), `${s2[0].elements.length}`);
  check('三端仍完全一致', s2.every((s) => sameSet(s.elements, s2[0].elements)));
  check('三个元素 z 序互不相同', new Set(orders).size === 3, orders.join(','));

  // ── 3. 并发 patch 同一元素：只有一个赢 ──
  // 用张三自己画的元素：他和老师都有修改权限，这才构成真正的 rev 竞争
  const targetId = zhangId;
  const targetRev = s2[0].elements.find((e) => e.id === zhangId).rev;
  await Promise.all([
    js(
      wins[0],
      `(() => { const wb = __classroomDebug.wb(); wb.patchElement(${JSON.stringify(targetId)}, { stroke: '#111111' }); })()`,
    ),
    js(
      wins[1],
      `(() => { const wb = __classroomDebug.wb(); wb.patchElement(${JSON.stringify(targetId)}, { stroke: '#eeeeee' }); })()`,
    ),
  ]);
  await sleep(1200);
  const s3 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  const colors = s3.map((s) => s.elements.find((e) => e.id === targetId)?.stroke);
  const revs = s3.map((s) => s.elements.find((e) => e.id === targetId)?.rev);
  check('并发 patch 后三端收敛到同一个值', new Set(colors).size === 1, colors.join(' / '));
  check('rev 只涨了 1（只有一个 patch 生效）', new Set(revs).size === 1 && revs[0] === targetRev + 1, `${targetRev} → ${revs.join('/')}`);
  const rejectSeen = s3.filter((s) => (s.notice ?? '').includes('刚被其他人修改')).length;
  check('落败方收到 rev 冲突提示', rejectSeen >= 1, s3.map((s) => s.notice ?? '-').join(' | '));

  // ── 4. 老师锁白板 → 学生 op 被拒 ──
  await js(wins[0], `__classroomDebug.wb().toggleLock()`);
  await sleep(800);
  const lockedSnaps = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  check('锁定状态同步到三端', lockedSnaps.every((s) => s.studentsCanDraw === false));
  check('学生的 canDraw 变为 false', lockedSnaps[1].canDraw === false && lockedSnaps[2].canDraw === false);
  check('老师不受锁定影响', lockedSnaps[0].canDraw === true);

  const beforeLockCount = lockedSnaps[0].elements.length;
  await js(wins[1], `__stroke(400, 400, 480, 460, '#ec4899')`);
  await sleep(900);
  const s4 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  check('锁定期间学生的绘制被服务端拒绝', s4.every((s) => s.elements.length === beforeLockCount), `${s4[0].elements.length}`);

  // 老师说可以画了
  await js(wins[0], `__classroomDebug.wb().toggleLock()`);
  await sleep(700);

  // ── 5. 老师新建页并翻页 → 全员跟随 ──
  await js(wins[0], `__classroomDebug.wb().addPage('第二页')`);
  await sleep(1000);
  const s5 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  check('三端都看到 2 页', s5.every((s) => s.pages.length === 2), `${s5[0].pages.length}`);
  check('三端当前页都跟随老师', s5.every((s) => s.active === s5[0].active));
  check('新页上没有旧元素', s5.every((s) => s.elements.length === 0));

  // 回到第一页，元素应还在
  const firstPage = s5[0].pages[0];
  await js(wins[0], `__classroomDebug.wb().goToPage(${JSON.stringify(firstPage)})`);
  await sleep(900);
  const s6 = await Promise.all(wins.map((w) => js(w, `__snap()`)));
  check('翻回第一页元素仍在', s6.every((s) => s.elements.length === 3), `${s6[0].elements.length}`);
  check('翻页后三端仍一致', s6.every((s) => sameSet(s.elements, s6[0].elements)));

  // ── 6. 新客户端进来拿全量快照 ──
  const lateWin = await makeWindow('late');
  await login(lateWin, accounts[2].email, accounts[2].password);
  await waitFor(async () => js(lateWin, `!!document.querySelector('.wb-nav-item')`), 15000, 'late workbench');
  await js(
    lateWin,
    `[...document.querySelectorAll('.wb-nav-item')].find(b => b.textContent.includes('我的课堂'))?.click()`,
  );
  await waitFor(async () => js(lateWin, `!!document.querySelector('.card .input')`), 15000, 'late classroom');
  await joinByCode(lateWin, code);
  const lateOk = await waitFor(async () => {
    const s = await js(lateWin, `__snap()`);
    return !!s && s.elements.length > 0;
  }, 15000, 'late join');
  const lateSnap = await js(lateWin, `__snap()`);
  check('后进来的客户端拿到全量快照', lateOk, `${lateSnap?.elements.length} 个元素`);
  check('后进来的客户端与其他人一致', sameSet(lateSnap.elements, s6[0].elements));

  console.log('');
  console.log(failures === 0 ? '白板全部通过 🎉' : `${failures} 项失败`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('测试脚本异常终止：', err);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
