/**
 * 白板左右翻页延迟与并发一致性验证。
 *
 * 用一份 6 页、A4 比例、每页纯色不同的 PDF（真实走 lib/import.ts 的渲染/上传路径），
 * 分三组验证：
 *   1. 渲染管线：直接切页，测「切页 → 新页背景真正出现在画布上」的耗时；
 *   2. 交互：真实点击翻页按钮连点 5 次，必须一页不落地前进 5 页、页码即时更新；
 *   3. 并发：连点只向服务端合并发送、学生端不倒退、重同步以服务端页为准、学生不能越权翻页。
 *
 * 前置：
 *   1. 服务端已启动（默认 http://localhost:8080）
 *   2. 渲染层 dev server 已启动（默认 http://localhost:5173）
 * 运行：
 *   npx electron --no-sandbox scripts/page-switch-test.cjs
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');

const URL_UI = process.env.CAPTURE_URL ?? 'http://localhost:5173';
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

/** A4 比例（595×842pt），每页铺满一种颜色，翻页后看背景图是否换了就能判断当前页 */
const COLORS = [
  [220, 38, 38],
  [37, 99, 235],
  [22, 163, 74],
  [217, 119, 6],
  [124, 58, 237],
  [13, 148, 136],
];

function makePdf(colors) {
  const objs = [];
  const n = colors.length;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = colors.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const LOREM =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';

  colors.forEach(([r, g, b], i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objs[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;

    let stream = `${(r / 255).toFixed(4)} ${(g / 255).toFixed(4)} ${(b / 255).toFixed(4)} rg 0 0 595 842 re f\n`;
    // 白底内容区 + 密集文字/色块：让每页 PNG 接近真实课件的体积与解码成本
    stream += '1 1 1 rg 36 36 523 770 re f\n';
    stream += `BT /F1 9 Tf 0.08 0.1 0.14 rg 48 770 Td 12 TL\n`;
    for (let line = 0; line < 30; line++) {
      stream += `(${LOREM} ${line + 1}) Tj T*\n`;
    }
    stream += 'ET\n';
    for (let row = 0; row < 24; row++) {
      for (let col = 0; col < 12; col++) {
        const rr = ((row * 13 + col * 7 + i * 31) % 200) / 255;
        const gg = ((row * 7 + col * 17 + i * 53) % 200) / 255;
        const bb = ((row * 19 + col * 11 + i * 11) % 200) / 255;
        stream += `${rr.toFixed(3)} ${gg.toFixed(3)} ${bb.toFixed(3)} rg ${52 + col * 42} ${80 + row * 20} 30 12 re f\n`;
      }
    }
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

const HELPERS = `
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
    pages: wb.doc.pages.map((p) => ({
      id: p.id,
      name: p.name,
      width: Math.round(p.width),
      height: Math.round(p.height),
      bg: p.background ? p.background.fileId : null,
    })),
    active: wb.activePageId,
  };
};
window.__perf = { longTasks: [], imgLoads: [], bgDraws: [] };
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
  }).observe({ entryTypes: ['longtask'] });
} catch (_) {}

/**
 * 背景图是跨域 URL，画布会被 taint，不能 getImageData。
 * 改为监听 <img> 载入与 drawImage，判断「新页背景真正画到画布上」的时刻。
 */
(() => {
  const NativeImage = window.Image;
  window.Image = function (...args) {
    const img = new NativeImage(...args);
    const t0 = performance.now();
    const fileIdOf = (src) => {
      const m = /\\/files\\/([0-9a-f-]{36})/.exec(String(src));
      return m ? m[1] : '';
    };
    img.addEventListener('load', () => {
      if (img.naturalWidth < 600) return;
      window.__perf.imgLoads.push({
        fileId: fileIdOf(img.src),
        ms: performance.now() - t0,
        w: img.naturalWidth,
        h: img.naturalHeight,
      });
    });
    img.addEventListener('error', () => {
      window.__perf.imgLoads.push({ fileId: fileIdOf(img.src), ms: performance.now() - t0, error: true });
    });
    return img;
  };
  window.Image.prototype = NativeImage.prototype;

  const origDraw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (src, ...rest) {
    if (src instanceof HTMLImageElement && src.naturalWidth >= 600) {
      const m = /\\/files\\/([0-9a-f-]{36})/.exec(String(src.src));
      window.__perf.bgDraws.push({ fileId: m ? m[1] : '', t: performance.now(), w: src.naturalWidth });
    }
    return origDraw.call(this, src, ...rest);
  };
})();

window.__bgDrawCount = (fileId) => window.__perf.bgDraws.filter((d) => d.fileId === fileId).length;

window.__trace = { calls: [], syncs: [] };
window.__traceWb = () => {
  const wb = __classroomDebug.wb();
  if (!wb || wb.__traced) return false;
  wb.__traced = true;
  const origGo = wb.goToPage.bind(wb);
  wb.goToPage = (id) => {
    window.__trace.calls.push({ k: 'goToPage', id, active: wb.activePageId, t: Math.round(performance.now()) });
    return origGo(id);
  };
  return true;
};
window.__tracePages = () => {
  const wb = __classroomDebug.wb();
  if (!wb || wb.__pageTrace) return false;
  wb.__pageTrace = [];
  const orig = wb.setActivePage.bind(wb);
  wb.setActivePage = (id) => {
    wb.__pageTrace.push({ id, t: Math.round(performance.now()) });
    return orig(id);
  };
  return true;
};
window.__traceSync = () => {
  const wb = __classroomDebug.wb();
  if (!wb || wb.__syncTrace) return false;
  wb.__syncTrace = [];
  const orig = wb.applySync.bind(wb);
  wb.applySync = (p) => {
    wb.__syncTrace.push({ pageId: p.pageId, pages: p.pages.length, t: Math.round(performance.now()) });
    return orig(p);
  };
  return true;
};

window.__waitBg = (fileId, timeoutMs = 15000) => new Promise((resolve) => {
  const t0 = performance.now();
  const tick = () => {
    if (window.__bgDrawCount(fileId) > 0) {
      resolve({ ok: true, ms: performance.now() - t0 });
      return;
    }
    if (performance.now() - t0 > timeoutMs) {
      resolve({ ok: false, ms: performance.now() - t0 });
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
});

/** 直接切页（绕过按钮），测「切页 → 目标页背景画到画布上」的耗时 */
window.__goto = (pageId, targetFileId, timeoutMs = 8000) => new Promise((resolve) => {
  const wb = __classroomDebug.wb();
  if (!wb) return resolve({ ok: false, error: 'no-wb' });
  const t0 = performance.now();
  const ltBefore = window.__perf.longTasks.length;
  const drawsBefore = targetFileId ? window.__bgDrawCount(targetFileId) : 0;
  const activeBefore = wb.activePageId;
  wb.goToPage(pageId);
  const tick = () => {
    const drawn = !targetFileId || window.__bgDrawCount(targetFileId) > drawsBefore;
    if (wb.activePageId === pageId && drawn) {
      const lts = window.__perf.longTasks
        .slice(ltBefore)
        .map((e) => ({ start: Math.round(e.start - t0), dur: Math.round(e.dur) }));
      resolve({ ok: true, ms: performance.now() - t0, activeBefore, longTasks: lts });
      return;
    }
    if (performance.now() - t0 > timeoutMs) {
      resolve({
        ok: false,
        error: 'timeout',
        ms: performance.now() - t0,
        activeBefore,
        activeAfter: wb.activePageId,
        draws: window.__perf.bgDraws.slice(-3),
      });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

/**
 * 真实点击「下一页」连点 count 次，每次间隔 intervalMs。
 * 返回每次 goToPage 调用时的旧页，用来验证每次点击都真的前进了一页。
 */
window.__clickBurst = (count, intervalMs, targetPageId, targetFileId, timeoutMs = 12000) => new Promise((resolve) => {
  const wb = __classroomDebug.wb();
  if (!wb) return resolve({ ok: false, error: 'no-wb' });
  const startIndex = wb.doc.pages.findIndex((p) => p.id === wb.activePageId);
  const t0 = performance.now();
  const ltBefore = window.__perf.longTasks.length;
  const drawsBefore = window.__bgDrawCount(targetFileId);
  const callsBefore = window.__trace.calls.length;
  let sent = 0;

  const collect = (extra) => {
    const calls = window.__trace.calls.slice(callsBefore).filter((c) => c.k === 'goToPage');
    const lts = window.__perf.longTasks
      .slice(ltBefore)
      .map((e) => ({ start: Math.round(e.start - t0), dur: Math.round(e.dur) }));
    const label = document.querySelector('.wb-page-label')?.textContent ?? '';
    return Object.assign({ sent, ms: performance.now() - t0, startIndex, endIndex: wb.doc.pages.findIndex((p) => p.id === wb.activePageId), calls, label, longTasks: lts }, extra);
  };

  const waitPaint = () => {
    const tick = () => {
      const drawn = !targetFileId || window.__bgDrawCount(targetFileId) > drawsBefore;
      if (wb.activePageId === targetPageId && drawn) return resolve(collect({ ok: true }));
      if (performance.now() - t0 > timeoutMs) {
        return resolve(collect({ ok: false, error: 'timeout', active: wb.activePageId, targetPageId }));
      }
      requestAnimationFrame(tick);
    };
    tick();
  };

  const clickNext = () => {
    const btn = [...document.querySelectorAll('.wb-page-btn')].find((b) => b.title === '下一页');
    if (!btn) return waitPaint();
    btn.click();
    sent++;
    if (sent >= count) return waitPaint();
    setTimeout(clickNext, intervalMs);
  };
  clickNext();
});

/** 点一次下一页，测量页码文字跟上所需的时间（渲染陈旧时会等到下一次 300ms 轮询） */
window.__clickNextAndWaitLabel = (expected, timeoutMs = 3000) => new Promise((resolve) => {
  const btn = [...document.querySelectorAll('.wb-page-btn')].find((b) => b.title === '下一页');
  if (!btn || btn.disabled) return resolve({ ok: false, error: 'no-button' });
  const t0 = performance.now();
  btn.click();
  const tick = () => {
    const text = document.querySelector('.wb-page-label')?.textContent ?? '';
    if (text.indexOf(expected) === 0) return resolve({ ok: true, ms: performance.now() - t0, text });
    if (performance.now() - t0 > timeoutMs) return resolve({ ok: false, error: 'timeout', ms: performance.now() - t0, text });
    requestAnimationFrame(tick);
  };
  tick();
});

/** 学生尝试翻页：应该被客户端角色校验直接拦掉 */
window.__tryGoto = (pageId) => {
  const wb = __classroomDebug.wb();
  if (!wb) return null;
  const before = wb.activePageId;
  wb.goToPage(pageId);
  return { before, after: wb.activePageId, isTeacher: wb.isTeacher() };
};
'ready';
`;

const js = (win, code) => win.webContents.executeJavaScript(code);

async function makeWindow(label) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      // 老师和学生必须用互相隔离的会话，否则同一份 localStorage 里的登录态会互相覆盖
      partition: `perf-${label}-${Date.now()}`,
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
  await js(win, HELPERS);
  win.showInactive();
  await sleep(600);
  return win;
}

async function waitFor(fn, timeout = 20000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(250);
  }
  console.log('[timeout]', label);
  return false;
}

async function login(win, email, password) {
  await js(win, `window.__fill('#email', ${JSON.stringify(email)})`);
  await js(win, `window.__fill('#password', ${JSON.stringify(password)})`);
  await sleep(180);
  await js(win, `document.querySelector('form.auth-form button[type=submit]').click()`);
  return waitFor(async () => js(win, `!!document.querySelector('.wb')`), 15000, `login ${email}`);
}

async function ensureAccount(email, password, displayName, role) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, role }),
  });
  return res.ok || res.status === 409;
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  return {
    n: s.length,
    min: Math.round(s[0] ?? 0),
    p50: Math.round(at(0.5) ?? 0),
    p95: Math.round(at(0.95) ?? 0),
    max: Math.round(s[s.length - 1] ?? 0),
  };
}

const pageText = (i) => `第 ${i + 1} 页`;

app.whenReady().then(async () => {
  const pdf = makePdf(COLORS);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(pdf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pdfUrl = `http://127.0.0.1:${server.address().port}/six-pages.pdf`;
  console.log('PDF 服务地址', pdfUrl, `(${pdf.length} 字节)`);

  const stamp = Date.now().toString().slice(-6);
  const teacher = { email: `swt${stamp}@perf.dev`, password: 'password123', name: '王老师' };
  const student = { email: `sws${stamp}@perf.dev`, password: 'password123', name: '张三' };
  await ensureAccount(teacher.email, teacher.password, teacher.name, 'teacher');
  await ensureAccount(student.email, student.password, student.name, 'student');

  const w0 = await makeWindow('teacher');
  const w1 = await makeWindow('student');
  check('老师登录', await login(w0, teacher.email, teacher.password));
  check('学生登录', await login(w1, student.email, student.password));

  await waitFor(async () => js(w0, `!!document.querySelector('.wb-nav-item')`), 15000, 'workbench nav');
  for (const w of [w0, w1]) {
    await js(
      w,
      `[...document.querySelectorAll('.wb-nav-item')].find(b => b.textContent.includes('我的课堂'))?.click()`,
    );
  }
  await waitFor(async () => js(w0, `!!document.querySelector('.card .input')`), 15000, 'workbench ready');
  await js(w0, `window.__fill('.card .input', '翻页性能测试')`);
  await sleep(250);
  await js(w0, `document.querySelector('.card .btn-primary').click()`);
  await waitFor(async () => js(w0, `!!document.querySelector('.room-title')`), 15000, 'room');
  const code = await js(w0, `__classroomDebug.roomState().room?.joinCode`);

  await js(w1, `window.__fill('.code-input', ${JSON.stringify(String(code))})`);
  await sleep(220);
  await js(w1, `document.querySelector('.card .btn-primary').click()`);
  await waitFor(async () => js(w1, `__classroomDebug.peerCount() >= 1`), 15000, 'student join');

  for (const w of [w0, w1]) {
    await js(
      w,
      `[...document.querySelectorAll('.room-view-toggle button')].find(b => b.textContent.includes('白板'))?.click()`,
    );
  }
  await sleep(1000);

  const added = await js(w0, `__classroomDebug.importPdfFromUrl(${JSON.stringify(pdfUrl)})`);
  check('导入 6 页课件', added === 6, String(added));
  await waitFor(async () => (await js(w0, `__wbSnap()`))?.pages.length === 7, 30000, 'import pages');
  const snap0 = await js(w0, `__wbSnap()`);
  const allPages = snap0?.pages ?? [];
  const bgIds = allPages.slice(1).map((p) => p.bg);
  check('课件页都有背景图', bgIds.length === 6 && bgIds.every(Boolean), bgIds.map((x) => x?.slice(0, 6)).join(','));
  const wait0 = await js(w0, `__waitBg(${JSON.stringify(bgIds[0])}, 15000)`);
  check('第一页背景可见', wait0?.ok === true, `${Math.round(wait0?.ms ?? -1)}ms`);
  await waitFor(async () => (await js(w1, `__wbSnap()`))?.pages.length === 7, 20000, 'student import pages');

  /* ── 1. 渲染管线延迟 ───────────────────────────────────── */

  console.log('\n── 冷翻页：首次切到每一页 ──');
  const cold = [];
  for (let k = 1; k < bgIds.length; k++) {
    const r = await js(w0, `__goto(${JSON.stringify(allPages[k + 1].id)}, ${JSON.stringify(bgIds[k])}, 6000)`);
    console.log(
      `  ${pageText(k + 1)}  ${r.ok ? Math.round(r.ms) + 'ms' : '失败 ' + r.error}`,
      r.longTasks?.length ? `长任务 ${JSON.stringify(r.longTasks)}` : '',
      r.ok ? '' : JSON.stringify(r),
    );
    if (r.ok) cold.push(r.ms);
  }
  check('冷翻页全部成功', cold.length === bgIds.length - 1, `${cold.length}/${bgIds.length - 1}`);

  console.log('\n── 暖翻页：回看已访问过的页 ──');
  const warmBack = [];
  for (let k = bgIds.length - 2; k >= 0; k--) {
    const r = await js(w0, `__goto(${JSON.stringify(allPages[k + 1].id)}, ${JSON.stringify(bgIds[k])})`);
    console.log(`  ${pageText(k + 1)}  ${r.ok ? Math.round(r.ms) + 'ms' : '失败 ' + r.error}`);
    if (r.ok) warmBack.push(r.ms);
  }
  const warmForward = [];
  for (let k = 1; k < bgIds.length; k++) {
    const r = await js(w0, `__goto(${JSON.stringify(allPages[k + 1].id)}, ${JSON.stringify(bgIds[k])})`);
    console.log(`  ${pageText(k + 1)}  ${r.ok ? Math.round(r.ms) + 'ms' : '失败 ' + r.error}`);
    if (r.ok) warmForward.push(r.ms);
  }

  const steady = [];
  for (let round = 0; round < 2; round++) {
    for (let k = bgIds.length - 2; k >= 0; k--) {
      const r = await js(w0, `__goto(${JSON.stringify(allPages[k + 1].id)}, ${JSON.stringify(bgIds[k])})`);
      if (r.ok) steady.push(r.ms);
    }
    for (let k = 1; k < bgIds.length; k++) {
      const r = await js(w0, `__goto(${JSON.stringify(allPages[k + 1].id)}, ${JSON.stringify(bgIds[k])})`);
      if (r.ok) steady.push(r.ms);
    }
  }

  console.log('\n汇总（切页 → 背景上屏）');
  console.log('  冷翻页', JSON.stringify(stats(cold)));
  console.log('  暖翻页（回退）', JSON.stringify(stats(warmBack)));
  console.log('  暖翻页（前进）', JSON.stringify(stats(warmForward)));
  console.log('  稳定态', JSON.stringify(stats(steady)));
  check('稳定态每次翻页 < 120ms', stats(steady).p95 < 120, `p95=${stats(steady).p95}ms`);

  /* ── 2. 真实按钮连点：必须每次点击都前进 ─────────────────── */

  console.log('\n── 连点「下一页」5 次（每 40ms 一次） ──');
  await js(w0, `__goto(${JSON.stringify(allPages[1].id)}, ${JSON.stringify(bgIds[0])})`);
  await sleep(400); // 等学生端也落到起始页，避免把这次跟随算进连点统计
  check('连点前停在第 2 页', (await js(w0, `__wbSnap()`))?.active === allPages[1].id);
  check('老师端 trace 安装', await js(w0, `__traceWb()`));
  check('学生端页轨安装', await js(w1, `__tracePages()`));
  const traceMark = await js(w1, `__classroomDebug.wb().__pageTrace.length`);

  const burst = await js(
    w0,
    `__clickBurst(5, 40, ${JSON.stringify(allPages[6].id)}, ${JSON.stringify(bgIds[5])})`,
  );
  console.log(
    '  结果',
    JSON.stringify({
      ok: burst.ok,
      ms: Math.round(burst.ms),
      sent: burst.sent,
      startIndex: burst.startIndex,
      endIndex: burst.endIndex,
      label: burst.label,
      calls: burst.calls,
    }),
  );
  if (burst.longTasks?.length) console.log('  长任务', JSON.stringify(burst.longTasks));
  check('连点 5 次前进 5 页', burst.ok === true && burst.endIndex - burst.startIndex === 5, `advance=${burst.endIndex - burst.startIndex}`);
  check('每次点击都基于实时页（无陈旧索引）',
    burst.calls?.length === 5 &&
      burst.calls.every((c, i) => c.active === (i === 0 ? allPages[1].id : burst.calls[i - 1].id)),
    JSON.stringify(burst.calls?.map((c) => c.active?.slice(0, 6))));
  check('页码同步到最终页', burst.label.indexOf('7 / 7') === 0, burst.label);
  check('连点无明显长任务', !burst.longTasks?.some((t) => t.dur > 120), JSON.stringify(burst.longTasks ?? []));

  await sleep(600); // 等所有回声到达，主控端不能被旧页回声拽回去
  check('主控端不被回声回跳', (await js(w0, `__wbSnap()`))?.active === allPages[6].id);

  /* ── 3. 学生端跟随与并发 ───────────────────────────────── */

  const pageTrace = await js(w1, `__classroomDebug.wb().__pageTrace.slice(${traceMark}).map(e => e.id)`);
  const idxOf = (id) => allPages.findIndex((p) => p.id === id);
  const traceIdx = pageTrace.map(idxOf);
  console.log('  学生端收到的翻页', JSON.stringify(traceIdx.map((i) => pageText(i))), `(${traceIdx.length} 次)`);
  check('学生端最终跟随到最后一页', traceIdx.at(-1) === 6);
  check('学生端翻页单调不倒退', traceIdx.every((v, i) => i === 0 || v >= traceIdx[i - 1]), JSON.stringify(traceIdx));
  check('连点翻页被合并发送', traceIdx.length < 5, `${traceIdx.length} 次广播 / 5 次点击`);

  const studentBg = await js(w1, `__waitBg(${JSON.stringify(bgIds[5])}, 8000)`);
  check('学生端画布显示最终页', studentBg?.ok === true, `${Math.round(studentBg?.ms ?? -1)}ms`);

  console.log('\n── 学生越权翻页 ──');
  const denied = await js(w1, `__tryGoto(${JSON.stringify(allPages[3].id)})`);
  check('学生端 goToPage 被角色校验拦下', denied?.isTeacher === false && denied.after === denied.before, JSON.stringify(denied));
  const disabled = await js(w1, `[...document.querySelectorAll('.wb-page-btn')].every(b => b.disabled)`);
  check('学生端翻页按钮全部禁用', disabled === true);

  /* ── 4. 重同步以服务端页为准 ───────────────────────────── */

  console.log('\n── 学生带过期页重同步 ──');
  await js(w0, `__goto(${JSON.stringify(allPages[2].id)}, ${JSON.stringify(bgIds[1])})`);
  await waitFor(async () => (await js(w1, `__wbSnap()`))?.active === allPages[2].id, 8000, 'student follow page 3');
  check('学生端先跟随到第 3 页', (await js(w1, `__wbSnap()`))?.active === allPages[2].id);
  check('学生端 sync trace 安装', await js(w1, `__traceSync()`));
  await js(w1, `__classroomDebug.wbResync(${JSON.stringify(allPages[6].id)})`);
  const gotSync = await waitFor(
    async () => (await js(w1, `__classroomDebug.wb().__syncTrace.length`)) > 0,
    5000,
    'student resync response',
  );
  await sleep(400);
  const afterResync = await js(w1, `__wbSnap()`);
  check('服务端确实回了全量快照', gotSync === true);
  check('重同步落在服务端当前页（不采纳过期页）', afterResync?.active === allPages[2].id, JSON.stringify({
    active: idxOf(afterResync?.active),
    expected: 2,
  }));

  /* ── 5. 页码即时刷新 ─────────────────────────────────── */

  console.log('\n── 页码刷新延迟 ──');
  await js(w0, `__goto(${JSON.stringify(allPages[1].id)}, ${JSON.stringify(bgIds[0])})`);
  await sleep(120);
  const labelRes = await js(w0, `__clickNextAndWaitLabel('3 / 7')`);
  console.log('  结果', JSON.stringify(labelRes));
  check('点一次页码即时更新', labelRes?.ok === true, `${Math.round(labelRes?.ms ?? -1)}ms`);
  check('页码刷新 < 150ms', (labelRes?.ms ?? 9999) < 150, `${Math.round(labelRes?.ms ?? -1)}ms`);

  server.close();
  console.log('');
  console.log(failures === 0 ? '翻页全部通过 🎉' : `${failures} 项失败`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('测试脚本异常终止：', err);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
