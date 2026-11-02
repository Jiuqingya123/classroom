/**
 * Mesh 音视频自动化验证。
 *
 * 开三个隐藏窗口（1 老师 + 2 学生），用 Chromium 的假摄像头走完整链路：
 * 登录 → 建房 → 凭码进房 → WebRTC 协商 → 校验连接状态与远端轨道。
 *
 * 用法（需先启动 renderer dev server，即 `npm run dev` 会自动起在 5273）：
 *   npx electron --no-sandbox scripts/rtc-test.cjs
 */
const { app, BrowserWindow } = require('electron');

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5273';
const BASE = process.env.BASE ?? 'http://localhost:8080';
const API = `${BASE}/api/v1`;

// 没有真摄像头也能跑：合成一路 640×480 的假视频 + 假麦克风
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-gpu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const FILL_HELPER = `
  window.__fill = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return 'no-el:' + sel;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  };
  'ready';
`;

async function makeWindow(label) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏窗口默认会被节流，WebRTC 的心跳/定时器会被拖慢
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !String(msg).includes('Electron Security')) {
      console.log(`[${label}:console]`, msg);
    }
  });
  await win.loadURL(URL);
  await sleep(1200);
  await win.webContents.executeJavaScript(FILL_HELPER);
  return win;
}

const js = (win, code) => win.webContents.executeJavaScript(code);

async function waitFor(fn, { timeout = 20000, interval = 400, label = '' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  console.log(`[timeout] ${label}`);
  return false;
}

async function login(win, email, password) {
  await js(win, `window.__fill('#email', ${JSON.stringify(email)})`);
  await js(win, `window.__fill('#password', ${JSON.stringify(password)})`);
  await sleep(200);
  await js(win, `document.querySelector('form.auth-form button[type=submit]').click()`);
  const ok = await waitFor(
    async () => js(win, `!!document.querySelector('.lobby')`),
    { label: `login ${email}` },
  );
  return ok;
}

async function registerAccount(email, password, displayName, role) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, role }),
  });
  if (res.ok) return true;
  // 已存在也当作成功（重复跑测试时）
  return res.status === 409;
}

app.whenReady().then(async () => {
  const stamp = Date.now().toString().slice(-6);
  const accounts = [
    { email: `t${stamp}@rtc.dev`, password: 'password123', name: '王老师', role: 'teacher' },
    { email: `s1${stamp}@rtc.dev`, password: 'password123', name: '张三', role: 'student' },
    { email: `s2${stamp}@rtc.dev`, password: 'password123', name: '李四', role: 'student' },
  ];

  for (const a of accounts) {
    await registerAccount(a.email, a.password, a.name, a.role);
  }

  console.log('创建 3 个窗口…');
  const wins = [];
  for (const a of accounts) {
    const w = await makeWindow(a.name);
    wins.push(w);
  }

  for (let i = 0; i < 3; i++) {
    const ok = await login(wins[i], accounts[i].email, accounts[i].password);
    check(`${accounts[i].name} 登录`, ok);
  }

  // 老师建房
  await js(wins[0], `window.__fill('.card .input', 'Mesh 测试课堂')`);
  await sleep(300);
  await js(wins[0], `document.querySelector('.card .btn-primary').click()`);
  const inRoom = await waitFor(
    async () => js(wins[0], `document.querySelector('.room-title')?.textContent === 'Mesh 测试课堂'`),
    { label: 'teacher 进房' },
  );
  check('老师建房并进房', inRoom);

  const joinCode = await js(wins[0], `__classroomDebug.roomState().room?.joinCode`);
  check('拿到 6 位入会码', /^\d{6}$/.test(String(joinCode)), String(joinCode));

  // 两个学生进房
  for (let i = 1; i <= 2; i++) {
    await js(wins[i], `window.__fill('.code-input', ${JSON.stringify(String(joinCode))})`);
    await sleep(250);
    await js(wins[i], `document.querySelector('.card .btn-primary').click()`);
    const ok = await waitFor(async () => js(wins[i], `__classroomDebug?.peerCount() >= 1`), {
      label: `student${i} 进房`,
    });
    check(`${accounts[i].name} 进房并建连`, ok);
  }

  // 等协商全部完成
  console.log('等待 Mesh 协商…');
  await sleep(6000);

  for (let i = 0; i < 3; i++) {
    const label = accounts[i].name;
    const snap = await js(
      wins[i],
      `(() => {
        const st = __classroomDebug.roomState();
        return {
          selfId: st.selfId,
          peerCount: __classroomDebug.peerCount(),
          people: st.participants.length,
          hasVideo: st.hasVideo,
          hasAudio: st.hasAudio,
          peers: Object.entries(st.peers).map(([id, v]) => ({
            id,
            state: v.state,
            camTracks: v.cam ? v.cam.getTracks().map(t => t.kind + ':' + t.readyState + ':' + t.enabled) : [],
            screenTracks: v.screen ? v.screen.getTracks().length : 0,
          })),
        };
      })()`,
    );
    console.log(`\n=== ${label} ===`, JSON.stringify(snap, null, 2));
    const rawStates = await js(wins[i], `__classroomDebug.pcStates()`);
    for (const rs of rawStates) {
      console.log(
        `--- ${label} → ${rs.userId.slice(0, 6)} | conn=${rs.connection} ice=${rs.ice} sig=${rs.signaling} ` +
          `neg=${rs.negotiationCount} offer=${rs.offersSent} ans=${rs.answersSent} ignored=${rs.signalsIgnored} ` +
          `mLines=${rs.sdpMLines} tx=${rs.transceivers.length} ` +
          `[${rs.transceivers.map((t) => `${t.mid ?? '-'}/${t.direction}/${t.currentDirection ?? '-'}/${t.senderTrack ?? 'null'}`).join(' ')}]`,
      );
    }

    check(`${label} 建立 2 条 Mesh 连接`, snap.peerCount === 2, `实际 ${snap.peerCount}`);
    check(`${label} 名单里有 3 人`, snap.people === 3, `实际 ${snap.people}`);
    check(`${label} 本地摄像头轨道就绪`, snap.hasVideo === true);
    check(`${label} 本地麦克风轨道就绪`, snap.hasAudio === true);

    const allConnected = snap.peers.every((p) => p.state === 'connected');
    check(
      `${label} 所有 PeerConnection 已 connected`,
      allConnected,
      snap.peers.map((p) => p.state).join(', '),
    );

    const gotRemoteVideo = snap.peers.every((p) => p.camTracks.some((t) => t.startsWith('video:')));
    const gotRemoteAudio = snap.peers.every((p) => p.camTracks.some((t) => t.startsWith('audio:')));
    check(`${label} 收到对端视频轨`, gotRemoteVideo, JSON.stringify(snap.peers.map((p) => p.camTracks)));
    check(`${label} 收到对端音频轨`, gotRemoteAudio);
    check(
      `${label} 预留了屏幕共享槽位`,
      snap.peers.every((p) => p.screenTracks >= 1),
    );
  }

  // 诊断数据
  await js(wins[0], `__classroomDebug.refreshDiag()`);
  await sleep(800);
  const diag = await js(wins[0], `__classroomDebug.roomState().diag`);
  console.log('\n=== 诊断快照 ===', JSON.stringify(diag, null, 2));
  check('诊断面板拿到 2 条连接数据', diag?.peers?.length === 2);
  check(
    '所有连接都拿到了 candidate 类型',
    diag?.peers?.every((p) => p.localCandidateType && p.remoteCandidateType),
    diag?.peers?.map((p) => `${p.localCandidateType}→${p.remoteCandidateType}`).join(' | ') ?? '',
  );

  // 摄像头开关应通过 presence 同步到对端
  const beforeToggle = await js(
    wins[1],
    `__classroomDebug.roomState().participants.find(p => p.role === 'teacher')?.hasVideo`,
  );
  await js(wins[0], `__classroomDebug.roomState().toggleCamera()`);
  await sleep(1500);
  const afterToggle = await js(
    wins[1],
    `__classroomDebug.roomState().participants.find(p => p.role === 'teacher')?.hasVideo`,
  );
  check('关摄像头同步到对端', beforeToggle === true && afterToggle === false, `${beforeToggle} → ${afterToggle}`);

  // ── 屏幕共享传输通路 ──
  // 这台机器没有录屏权限，getDisplayMedia 拿不到源；用 canvas 流替代，
  // 验证的正是「共享槽位 replaceTrack → 远端收到未静音视频轨」这一段
  await js(
    wins[0],
    `(() => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const ctx = c.getContext('2d');
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = '#12233f'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#8fb0ff'; ctx.font = '44px sans-serif';
        ctx.fillText('SCREEN ' + (++n), 40, 190);
      }, 80);
      window.__fakeScreen = c.captureStream(12);
      __classroomDebug.injectScreen(window.__fakeScreen);
    })()`,
  );
  await sleep(2500);

  const shareOnTeacher = await js(
    wins[0],
    `(() => { const s = __classroomDebug.roomState(); return { sharing: s.sharing, hasStream: !!s.screenStream }; })()`,
  );
  check('老师端进入共享状态', shareOnTeacher.sharing === true && shareOnTeacher.hasStream);

  const shareOnStudent = await js(
    wins[1],
    `(() => {
      const st = __classroomDebug.roomState();
      const holder = st.sharingUserId;
      const view = holder ? st.peers[holder] : null;
      const track = view?.screen?.getVideoTracks?.()[0] ?? null;
      return {
        sharingUserId: holder,
        selfId: st.selfId,
        hasScreenStream: !!view?.screen,
        screenTrackCount: view?.screen ? view.screen.getTracks().length : 0,
        trackMuted: track ? track.muted : null,
        trackReadyState: track ? track.readyState : null,
      };
    })()`,
  );
  console.log('\n=== 学生端看到的共享 ===', JSON.stringify(shareOnStudent));
  check('学生端知道是谁在共享', !!shareOnStudent.sharingUserId && shareOnStudent.sharingUserId !== shareOnStudent.selfId);
  check('学生端收到共享视频轨', shareOnStudent.screenTrackCount >= 1, `track 数 ${shareOnStudent.screenTrackCount}`);
  check('共享视频轨在出帧（未 muted）', shareOnStudent.trackMuted === false, `muted=${shareOnStudent.trackMuted}`);

  const shareDiag = await js(wins[0], `__classroomDebug.refreshDiag()`);
  await sleep(600);
  const shareDiagSnap = await js(wins[0], `__classroomDebug.roomState().diag`);
  check(
    '共享时上行带宽非零',
    (shareDiagSnap?.peers ?? []).some((p) => (p.outboundKbps ?? 0) > 0),
    (shareDiagSnap?.peers ?? []).map((p) => `${p.outboundKbps}kbps`).join(' | '),
  );

  await js(wins[0], `__classroomDebug.stopScreen()`);
  await sleep(1200);
  const afterStop = await js(wins[1], `__classroomDebug.roomState().sharingUserId`);
  check('停止共享后对端状态清除', afterStop === null, String(afterStop));

  console.log('');
  console.log(failures === 0 ? 'Mesh 全部通过 🎉' : `${failures} 项失败`);

  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('测试脚本异常终止：', err);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
