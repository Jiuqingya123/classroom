/**
 * 打包产物冒烟：直接启动装好的 exe，用 CDP 连进去看它到底渲染出了什么。
 *
 * 只验证「能启动 + 能渲染 + 连对服务器」这三件事，不做业务流（业务流有 smoke.mjs）。
 *
 *   node scripts/win-smoke.cjs [exe路径]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.argv[2] || path.join(ROOT, 'apps/desktop/dist/win-unpacked/ClassRoom.exe');
const PORT = 9333;
const SHOT = path.join(ROOT, 'apps/desktop/dist/win-smoke.png');

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
  throw new Error('等不到调试端口，应用可能没起来');
}

function connect(wsUrl) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

let passed = 0;
function check(label, cond, extra = '') {
  if (!cond) {
    console.error(`❌ ${label} ${extra}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`✅ ${label}${extra ? '  ' + extra : ''}`);
}

(async () => {
  console.log(`启动 ${EXE}`);
  // ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node（不建窗口、报 "bad option"），
  // 这个变量在某些 IDE / CI 里是默认带着的，必须剥掉
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // 默认用 Chromium 合成摄像头：这台机器可能压根没有摄像头（CI / 云主机），
  // 但采集链路是否通必须能验。要测真机设备就设 REAL_MEDIA=1。
  const args = [`--remote-debugging-port=${PORT}`];
  if (!process.env.REAL_MEDIA) {
    args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');
  }

  const child = spawn(EXE, args, { stdio: 'ignore', detached: false, env });

  try {
    const target = await waitForTarget();
    const ws = await connect(target.webSocketDebuggerUrl);
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');

    // 等 React 挂载完。注意启动页（.splash）也算「挂载完」，
    // 要等到真正落到登录页或大厅才算稳定，否则会话恢复慢的时候会抓到启动页
    for (let i = 0; i < 60; i += 1) {
      const view = await evaluate(
        ws,
        `(() => {
          const root = document.getElementById('root');
          return {
            mounted: !!root && root.children.length > 0,
            settled: !!document.querySelector('.auth, .topbar, .room'),
          };
        })()`,
      );
      if (view.settled) break;
      await sleep(300);
    }

    const info = await evaluate(ws, `window.desktop ? window.desktop.appInfo() : null`);
    check('预加载脚本注入成功（window.desktop 可用）', !!info);
    check('打包态连的是生产服务器', info && info.serverUrl === 'http://<PROD_SERVER_IP>:9999', info && info.serverUrl);
    check('isDev=false（走打包产物而非 dev server）', info && info.isDev === false);
    // 期望版本直接从 package.json 读，升版本号时不用改这个脚本
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/package.json'), 'utf8')).version;
    check('版本号与 package.json 一致', info && info.version === expectedVersion, info && info.version);
    check('平台标识为 win32', info && info.platform === 'win32');

    const rendered = await evaluate(
      ws,
      `(() => {
        const root = document.getElementById('root');
        return {
          nodes: root ? root.querySelectorAll('*').length : 0,
          hasAuth: !!document.querySelector('.auth'),
          hasLobby: !!document.querySelector('.lobby'),
          platformAttr: document.documentElement.dataset.platform || '',
          title: document.title,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      })()`,
    );
    check('React 已渲染出节点', rendered.nodes > 20, `${rendered.nodes} 个节点`);
    // 这台机器上曾登录过，refresh token 存在 userData 里，启动会直接进大厅；
    // 所以只断言「进到了应用界面」，不假定具体是哪一页
    check('渲染出应用界面', rendered.hasAuth === true || rendered.hasLobby === true,
      rendered.hasAuth ? '登录页' : rendered.hasLobby ? '大厅（已恢复登录）' : '未知页面');
    check('平台标识已写入 DOM', rendered.platformAttr === 'win32', rendered.platformAttr);

    // 摄像头：真正拉起一路流并确认出帧。这一步是「摄像头打不开」的直接验收
    const camera = await evaluate(
      ws,
      `(async () => {
        const out = { steps: [] };
        try {
          const perm = window.desktop ? await window.desktop.requestMediaAccess('camera') : 'no-desktop';
          out.permission = perm;
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
            audio: true,
          });
          const vt = stream.getVideoTracks()[0];
          out.tracks = { video: stream.getVideoTracks().length, audio: stream.getAudioTracks().length };
          out.label = vt ? vt.label : null;
          const v = document.createElement('video');
          v.muted = true; v.autoplay = true; v.playsInline = true;
          v.srcObject = stream;
          await v.play().catch(() => {});
          // 等首帧：videoWidth 由 0 变正才算真的有画面
          for (let i = 0; i < 40 && v.videoWidth === 0; i += 1) {
            await new Promise(r => setTimeout(r, 100));
          }
          out.videoWidth = v.videoWidth;
          out.videoHeight = v.videoHeight;
          out.readyState = v.readyState;
          stream.getTracks().forEach(t => t.stop());
          out.ok = out.videoWidth > 0;
        } catch (e) {
          out.ok = false;
          out.error = e.name + ': ' + e.message;
        }
        return out;
      })()`,
    );
    check('摄像头能打开并出帧', camera && camera.ok === true, JSON.stringify({ w: camera.videoWidth, h: camera.videoHeight, tracks: camera.tracks, label: camera.label }));
    check('权限查询接口可用', camera && camera.permission !== undefined, String(camera && camera.permission));

    // 窗口壳适配：Windows 走原生标题栏，顶栏不该再给 macOS 红绿灯留 88~92px
    const pads = await evaluate(
      ws,
      `(() => {
        const read = (cls) => {
          const d = document.createElement('div');
          d.className = cls;
          document.body.appendChild(d);
          const pl = getComputedStyle(d).paddingLeft;
          d.remove();
          return pl;
        };
        return { topbar: read('topbar'), roomHeader: read('room-header') };
      })()`,
    );
    check('Windows 顶栏去掉了红绿灯留白', pads.topbar === '18px', `topbar padding-left=${pads.topbar}`);
    check('房间头部去掉了红绿灯留白', pads.roomHeader === '16px', `room-header padding-left=${pads.roomHeader}`);

    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图：${SHOT}`);

    // 页面没有未捕获的报错才算过
    const errors = await evaluate(ws, `window.__smokeErrors ? window.__smokeErrors.length : 0`);
    check('渲染进程无致命报错', errors === 0 || errors === undefined);

    ws.close();
    console.log(`\n打包产物冒烟 ${passed} 项通过 🎉`);
  } catch (err) {
    console.error('冒烟失败：', err.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    await sleep(500);
    if (!child.killed) child.kill('SIGKILL');
  }
})();
