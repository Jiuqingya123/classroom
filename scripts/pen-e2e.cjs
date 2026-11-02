/**
 * 数位笔压感的端到端验证：在真实打包出来的客户端里画两笔，截图为证。
 *
 * 做的事：
 *   1. 启动装好的 exe（复用已保存的登录态）
 *   2. 进课堂 → 切到白板
 *   3. 用合成的 PointerEvent（pointerType:'pen'）画一条压感渐变笔迹 + 一条恒定压感笔迹
 *   4. 截图存到 dist/pen-e2e.png
 *
 * 为什么值得跑：合成事件走的是和生产完全相同的代码路径（stage -> client -> wb:op -> 服务端校验），
 * 笔迹能留在画布上就说明服务端接受了 pressures 字段（否则 op 会被 reject、笔画回滚消失）。
 *
 *   node scripts/pen-e2e.cjs [exe路径]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.argv[2] || path.join(ROOT, 'apps/desktop/dist/win-unpacked/ClassRoom.exe');
const PORT = 9355;
const SHOT = path.join(ROOT, 'apps/desktop/dist/pen-e2e.png');

if (!fs.existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForTarget(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('等不到调试端口');
}

let seq = 0;
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
}

async function waitFor(ws, expr, { timeout = 15000, label = '' } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(ws, `!!(${expr})`)) return true;
    await sleep(300);
  }
  throw new Error(`等待超时：${label || expr}`);
}

/**
 * 按可见文字点击。
 *
 * 先找「整段文本正好等于目标」的可点元素（按钮里常带图标，textContent 会含图标节点但文本仍是「下课」），
 * 找不到再退化成「最内层纯文本节点 + 往上找可点祖先」。
 */
const clickByText = (text) => `(() => {
  const t = ${JSON.stringify(text)};
  const clickable = [...document.querySelectorAll('button, .btn, [role="button"]')];
  const direct = clickable.find((e) => (e.textContent || '').trim() === t);
  if (direct && typeof direct.click === 'function') { direct.click(); return true; }

  const contains = clickable.find((e) => (e.textContent || '').trim().includes(t));
  if (contains && typeof contains.click === 'function') { contains.click(); return true; }

  return false;
})()`;

/** 调试用：把当前页面里所有可点元素的文案列出来 */
const listClickables = `[...document.querySelectorAll('button, .btn, [role="button"]')]
  .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 12)`;

(async () => {
  console.log(`启动 ${EXE}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env });

  try {
    const target = await waitForTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');

    await waitFor(ws, `document.querySelector('.lobby, .auth, .room')`, { label: '应用界面' });

    // 没登录就没法进课堂，直接退出并说明原因
    const loggedIn = await evaluate(ws, `!!document.querySelector('.lobby, .room')`);
    if (!loggedIn) {
      console.log('⚠️  当前是未登录状态，跳过（本用例需要已登录的客户端）');
      ws.close();
      process.exitCode = 2;
      return;
    }

    // 进课堂
    if (await evaluate(ws, `!!document.querySelector('.lobby')`)) {
      // 「创建」按钮在课堂名为空时是 disabled 的，必须先把标题填进去
      await evaluate(
        ws,
        `(() => {
          const input = document.querySelector('.lobby input[placeholder*="课堂名称"]');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '压感笔迹验证 ' + new Date().toLocaleTimeString('zh-CN'));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`,
      );
      await sleep(300);

      let ok = await evaluate(ws, clickByText('创建'));
      if (!ok) {
        await evaluate(ws, clickByText('创建课堂'));
        await sleep(600);
        ok = await evaluate(ws, clickByText('创建'));
      }
      if (!ok) {
        const got = await evaluate(ws, listClickables);
        throw new Error(`找不到建房按钮，当前可点元素：${JSON.stringify(got)}`);
      }
      await waitFor(ws, `document.querySelector('.room')`, { label: '进入课堂' });
      await sleep(2000); // 等 socket join + 白板快照
    }

    // 切到白板
    if (await evaluate(ws, `!!document.querySelector('.room-view-toggle')`)) {
      const ok = await evaluate(ws, clickByText('白板'));
      if (!ok) throw new Error('找不到「白板」切换按钮');
      await waitFor(ws, `document.querySelector('.wb-stage-wrap canvas')`, { label: '白板画布' });
      await sleep(800);
    } else {
      throw new Error('房间页没有白板切换入口');
    }

    // 用合成笔事件画两条笔迹
    const drawn = await evaluate(
      ws,
      `(async () => {
        const wrap = document.querySelector('.wb-stage-wrap');
        const canvas = wrap.querySelector('canvas');
        const r = canvas.getBoundingClientRect();
        const fire = (type, x, y, pressure) => {
          const ev = new PointerEvent(type, {
            pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: r.left + x, clientY: r.top + y, pressure,
          });
          canvas.dispatchEvent(ev);
        };
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

        // 第一笔：压感从 0.05 渐增到 1（应当起笔细、收笔粗）
        const y1 = r.height * 0.35;
        fire('pointerdown', r.width * 0.15, y1, 0.05);
        for (let i = 1; i <= 40; i += 1) {
          fire('pointermove', r.width * (0.15 + 0.01 * i), y1 + Math.sin(i / 5) * 8, 0.05 + (0.95 * i) / 40);
          await sleep(8);
        }
        fire('pointerup', r.width * 0.55, y1, 1);
        await sleep(400);

        // 第二笔：恒定压感（对照组，粗细不变）
        const y2 = r.height * 0.6;
        fire('pointerdown', r.width * 0.15, y2, 0.4);
        for (let i = 1; i <= 40; i += 1) {
          fire('pointermove', r.width * (0.15 + 0.01 * i), y2, 0.4);
          await sleep(8);
        }
        fire('pointerup', r.width * 0.55, y2, 0.4);

        // 第三笔：画笔途中不断插入「另一支指针」（鼠标）的移动与抬起。
        // 正确实现下这些干扰会被 pointerId 过滤掉，笔迹是干净的水平线；
        // 如果笔迹被拽到右下角、或者中途断掉，说明设备隔离没生效。
        await sleep(300);
        const y3 = r.height * 0.78;
        const pen = (type, x, y, pressure, id = 7, pointerType = 'pen', button = 0, buttons = 1) => {
          canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: id, pointerType, isPrimary: true, bubbles: true, cancelable: true,
            button, buttons: type === 'pointerup' ? 0 : buttons,
            clientX: r.left + x, clientY: r.top + y, pressure,
          }));
        };
        pen('pointerdown', r.width * 0.15, y3, 0.7);
        let strays = 0;
        for (let i = 1; i <= 60; i += 1) {
          pen('pointermove', r.width * (0.15 + 0.008 * i), y3 + Math.sin(i / 4) * 3, 0.7);
          // 每 6 步插一个鼠标事件，位置故意放在画布右下角（离笔迹很远）
          if (i % 6 === 0) {
            pen('pointermove', r.width * 0.92, r.height * 0.92, 0.5, 1, 'mouse', 0, 0);
            strays += 1;
          }
          if (i === 30) {
            // 中途再插一个鼠标抬起，不应该提前结束这一笔
            pen('pointerup', r.width * 0.92, r.height * 0.92, 0.5, 1, 'mouse', 0, 0);
            strays += 1;
          }
          await sleep(8);
        }
        pen('pointerup', r.width * 0.63, y3, 0.7);

        return { w: Math.round(r.width), h: Math.round(r.height), strays };
      })()`,
    );
    console.log(`画布 ${drawn.w}x${drawn.h}，已画三笔（第三笔夹了 ${drawn.strays} 次鼠标干扰）`);

    // 等 op 走完服务端往返
    await sleep(2000);

    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`截图：${SHOT}`);
    console.log('提示：看截图里第一笔是否「下细上粗」、第二笔是否等宽');

    // 顺手验证诊断面板：Ctrl+Shift+D 打开后画一笔，面板里应该有事件行
    const hud = await evaluate(
      ws,
      `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyD', bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const visible = !!document.querySelector('.pen-hud');
        const canvas = document.querySelector('.wb-stage-wrap canvas');
        const r = canvas.getBoundingClientRect();
        const fire = (type, x, y, pressure, id, pointerType, button) => {
          canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: id, pointerType, isPrimary: true, bubbles: true, cancelable: true,
            button: button ?? 0, buttons: type === 'pointerup' ? 0 : 1,
            clientX: r.left + x, clientY: r.top + y, pressure,
          }));
        };
        const y = r.height * 0.45;
        fire('pointerdown', r.width * 0.2, y, 0.85, 9, 'pen');
        for (let i = 1; i <= 12; i += 1) {
          fire('pointermove', r.width * (0.2 + 0.01 * i), y, 0.85, 9, 'pen');
          // 插一个鼠标模拟事件，面板里应显示为「丢弃」
          if (i % 4 === 0) fire('pointermove', r.width * 0.9, r.height * 0.9, 0.5, 1, 'mouse');
          await new Promise(res => setTimeout(res, 30));
        }
        fire('pointerup', r.width * 0.32, y, 0.85, 9, 'pen');
        await new Promise(res => setTimeout(res, 500));
        return {
          visible,
          rows: document.querySelectorAll('.pen-hud-table tbody tr[data-kind]').length,
          penRows: document.querySelectorAll('.pen-hud-table tbody tr[data-kind="pen"]').length,
          dropped: document.querySelectorAll('.pen-hud-table tbody tr[data-dropped="true"]').length,
          dropSummary: (document.querySelector('.pen-hud-drops') || {}).textContent || '',
        };
      })()`,
    );
    console.log(
      `诊断面板：${hud.visible ? '已打开' : '未出现'}，事件行 ${hud.rows}（笔 ${hud.penRows}，丢弃 ${hud.dropped}）`,
    );
    console.log(`丢弃统计：${hud.dropSummary.trim()}`);

    const hudShot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT.replace(/\.png$/, '-hud.png'), Buffer.from(hudShot.data, 'base64'));
    console.log(`诊断截图：${SHOT.replace(/\.png$/, '-hud.png')}`);

    // 收尾：结束课堂，避免在生产环境留下一堆测试房间
    const ended = await evaluate(ws, clickByText('下课'));
    console.log(ended ? '已结束课堂' : '⚠️  没找到「下课」按钮，请手动结束课堂');

    ws.close();
  } catch (err) {
    console.error('失败：', err.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    await sleep(500);
    if (!child.killed) child.kill('SIGKILL');
  }
})();
