/**
 * PDF 课件导入端到端验证。
 *
 * 现造一份合法的两页 PDF，通过本地小 HTTP 服务喂给渲染进程，
 * 走的是和用户点「导入」完全相同的代码路径（lib/import.ts）。
 *
 * 用法（需先启动服务端与 renderer dev server）：
 *   npx electron --no-sandbox scripts/pdf-test.cjs
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const URL_UI = process.env.CAPTURE_URL ?? 'http://localhost:5273';
const BASE = process.env.BASE ?? 'http://localhost:8080';
const API = `${BASE}/api/v1`;
const OUT = '/tmp/ui3';

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

/** 手搓一个带正确 xref 的 PDF，避免为了测试引入生成库 */
function makePdf(texts) {
  const objs = [];
  const n = texts.length;
  // 1 目录, 2 页面树, 3 字体, 之后每页两个对象（page + content）
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  texts.forEach((t, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objs[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 600] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = `BT /F1 44 Tf 60 500 Td (${t}) Tj ET\n0 0 1 rg 60 120 300 200 re f`;
    objs[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const total = objs.length;
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < total; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const FILL = `
  window.__fill = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return 'no-el';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  };
  window.__wbSnap = () => {
    const wb = __classroomDebug.wb();
    if (!wb) return null;
    return {
      pages: wb.doc.pages.map(p => ({
        id: p.id,
        name: p.name,
        width: Math.round(p.width),
        height: Math.round(p.height),
        bg: p.background ? p.background.fileId : null,
      })),
      active: wb.activePageId,
    };
  };
  'ready';
`;

const js = (win, code) => win.webContents.executeJavaScript(code);

async function shot(win, name) {
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !String(msg).includes('Electron Security')) console.log(`[${label}]`, msg);
  });
  await win.loadURL(URL_UI);
  await sleep(1600);
  await js(win, FILL);
  win.showInactive();
  await sleep(600);
  return win;
}

async function waitFor(fn, timeout = 20000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(300);
  }
  console.log('[timeout]', label);
  return false;
}

async function login(win, email, password) {
  await js(win, `window.__fill('#email', ${JSON.stringify(email)})`);
  await js(win, `window.__fill('#password', ${JSON.stringify(password)})`);
  await sleep(180);
  await js(win, `document.querySelector('form.auth-form button[type=submit]').click()`);
  return waitFor(async () => js(win, `!!document.querySelector('.lobby')`), 15000, `login ${email}`);
}

async function ensureAccount(email, password, displayName, role) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, role }),
  });
  return res.ok || res.status === 409;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const pdf = makePdf(['勾股定理 · 第一页', '例题讲解 · 第二页']);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(pdf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pdfUrl = `http://127.0.0.1:${server.address().port}/lesson.pdf`;
  console.log('PDF 服务地址', pdfUrl, `(${pdf.length} 字节)`);

  const stamp = Date.now().toString().slice(-6);
  const teacher = { email: `pt${stamp}@pdf.dev`, password: 'password123', name: '王老师' };
  const student = { email: `ps${stamp}@pdf.dev`, password: 'password123', name: '张三' };
  await ensureAccount(teacher.email, teacher.password, teacher.name, 'teacher');
  await ensureAccount(student.email, student.password, student.name, 'student');

  const w0 = await makeWindow('teacher');
  const w1 = await makeWindow('student');
  check('老师登录', await login(w0, teacher.email, teacher.password));
  check('学生登录', await login(w1, student.email, student.password));

  await js(w0, `window.__fill('.card .input', 'PDF 课件测试')`);
  await sleep(250);
  await js(w0, `document.querySelector('.card .btn-primary').click()`);
  await waitFor(async () => js(w0, `!!document.querySelector('.room-title')`), 15000, 'room');
  const code = await js(w0, `__classroomDebug.roomState().room?.joinCode`);

  await js(w1, `window.__fill('.code-input', ${JSON.stringify(String(code))})`);
  await sleep(220);
  await js(w1, `document.querySelector('.card .btn-primary').click()`);
  await waitFor(async () => js(w1, `__classroomDebug.peerCount() >= 1`), 15000, 'student join');

  // 两端切到白板
  for (const w of [w0, w1]) {
    await js(
      w,
      `[...document.querySelectorAll('.room-view-toggle button')].find(b => b.textContent.includes('白板'))?.click()`,
    );
  }
  await sleep(1200);

  const before = await js(w0, `__wbSnap()`);
  check('导入前只有 1 个空白页', before?.pages.length === 1, `${before?.pages.length}`);

  // 导入
  const added = await js(w0, `__classroomDebug.importPdfFromUrl(${JSON.stringify(pdfUrl)})`);
  check('导入返回新增页数', added === 2, String(added));
  await sleep(2500);

  const after = await js(w0, `__wbSnap()`);
  console.log('\n老师端页面：', JSON.stringify(after?.pages, null, 1));
  check('页数变为 3', after?.pages.length === 3, `${after?.pages.length}`);

  const imported = (after?.pages ?? []).slice(1);
  check('两页都带背景图 id', imported.every((p) => !!p.bg), imported.map((p) => p.bg?.slice(0, 8)).join(','));
  check('背景图是渲染后的位图尺寸', imported.every((p) => p.width >= 800 && p.height >= 400), imported.map((p) => `${p.width}x${p.height}`).join(' '));
  check('自动跳到第一张课件页', after?.active === imported[0]?.id);
  check('页名带文件名', imported.every((p) => p.name.includes('test')), imported.map((p) => p.name).join(' | '));

  // 学生端应看到同样的页
  const studentSnap = await js(w1, `__wbSnap()`);
  await sleep(600);
  const studentAfter = await js(w1, `__wbSnap()`);
  check('学生端也看到 3 页', studentAfter?.pages.length === 3, `${studentAfter?.pages.length}`);
  check(
    '学生端背景 fileId 与老师端一致',
    studentAfter?.pages.every((p, i) => p.bg === after?.pages[i]?.bg),
  );
  check('学生端当前页跟随', studentAfter?.active === after?.active, studentSnap?.active);

  await sleep(1500);
  await shot(w0, 'pdf-teacher');
  await shot(w1, 'pdf-student');

  server.close();
  console.log('');
  console.log(failures === 0 ? 'PDF 导入全部通过 🎉' : `${failures} 项失败`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('测试脚本异常终止：', err);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
