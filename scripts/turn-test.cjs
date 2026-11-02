/**
 * TURN 中继真连验证。
 *
 * 光「端口可达」不代表 TURN 能用：鉴权、分配、转发任何一环坏了都连不上。
 * 这里在 Chromium 里用 iceTransportPolicy='relay' 强行禁止直连，
 * 让两条 PeerConnection 只能走 TURN 中继，然后检查是否真的连上、选中的是不是 relay 候选。
 *
 * 必须在另一台机器上跑才有意义（同机会命中 host 候选）。
 *   npx electron --no-sandbox scripts/turn-test.cjs
 */
const { app, BrowserWindow } = require('electron');

const UI = process.env.CAPTURE_URL ?? 'http://localhost:5273';
const BASE = process.env.BASE ?? 'http://<PROD_SERVER_IP>';

app.commandLine.appendSwitch('no-sandbox');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

async function fetchIce() {
  const api = `${BASE}/api/v1`;
  const s = Date.now().toString().slice(-6);
  const reg = await fetch(`${api}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `turnt${s}@t.dev`,
      password: 'password123',
      displayName: 'TURN 测试',
      role: 'teacher',
    }),
  });
  const tokens = (await reg.json()).tokens;
  const res = await fetch(`${api}/rtc/ice-servers`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  return res.json();
}

app.whenReady().then(async () => {
  const ice = await fetchIce();
  const turn = ice.iceServers.find((s) => s.username);
  check('API 下发了 TURN 凭据', !!turn, turn?.urls?.join(' '));

  if (!turn) {
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadURL(UI);
  await sleep(1500);

  const config = {
    iceServers: [turn],
    iceTransportPolicy: 'relay', // 关键：禁止 host/srflx，只能走 TURN
  };

  const result = await win.webContents.executeJavaScript(`
    (async () => {
     try {
      const config = ${JSON.stringify(config)};
      const a = new RTCPeerConnection(config);
      const b = new RTCPeerConnection(config);
      const log = { aCandidates: [], bCandidates: [] };

      a.onicecandidate = (e) => {
        if (e.candidate) { log.aCandidates.push(e.candidate.type + '/' + e.candidate.protocol); b.addIceCandidate(e.candidate).catch(() => {}); }
      };
      b.onicecandidate = (e) => {
        if (e.candidate) { log.bCandidates.push(e.candidate.type + '/' + e.candidate.protocol); a.addIceCandidate(e.candidate).catch(() => {}); }
      };

      const dc = a.createDataChannel('probe');
      const gotMessage = new Promise((resolve) => {
        b.ondatachannel = (ev) => {
          ev.channel.onmessage = (m) => resolve(m.data);
        };
      });

      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);

      // 等连接建立
      const connected = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 20000);
        const check = () => {
          if (a.connectionState === 'connected' && b.connectionState === 'connected') {
            clearTimeout(t); resolve(true);
          }
        };
        a.onconnectionstatechange = check;
        b.onconnectionstatechange = check;
        check();
      });

      if (!connected) {
        return { connected: false, log, aState: a.connectionState, bState: b.connectionState };
      }

      // 等数据通道真正 open —— connectionState 变成 connected 时通道可能还没建好，
      // 这时 send() 会直接抛 InvalidStateError
      const channelOpen = await new Promise((resolve) => {
        if (dc.readyState === 'open') return resolve(true);
        const t = setTimeout(() => resolve(false), 8000);
        dc.onopen = () => { clearTimeout(t); resolve(true); };
      });

      // 发一条数据，证明中继真的在转发（不只是握手成功）
      let received = null;
      if (channelOpen) {
        dc.send('relay-hello');
        received = await Promise.race([gotMessage, new Promise((r) => setTimeout(() => r(null), 5000))]);
      }

      // 读选中的候选对
      const stats = await a.getStats();
      const byId = new Map();
      stats.forEach((s) => byId.set(s.id, s));
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
      });
      const local = pair ? byId.get(pair.localCandidateId) : null;
      const remote = pair ? byId.get(pair.remoteCandidateId) : null;

      const out = {
        connected: true,
        received,
        localType: local?.candidateType ?? null,
        remoteType: remote?.candidateType ?? null,
        localProto: local?.protocol ?? null,
        rtt: pair?.currentRoundTripTime ?? null,
        log,
      };
      a.close(); b.close();
      return out;
     } catch (e) {
      return { error: (e && e.stack) || String(e) };
     }
    })()
  `);

  console.log('\n中继测试结果：', JSON.stringify(result, null, 1));

  check('relay-only 模式下连接建立成功', result?.connected === true);
  check('数据通道经中继收到消息', result?.received === 'relay-hello', String(result?.received));
  check('选中候选是 relay', result?.localType === 'relay' || result?.remoteType === 'relay',
    `${result?.localType} → ${result?.remoteType}`);
  check('候选里没有 host（确认真的禁了直连）',
    ![...(result?.log?.aCandidates ?? []), ...(result?.log?.bCandidates ?? [])].some((c) => c.startsWith('host')),
    (result?.log?.aCandidates ?? []).join(','));

  console.log('');
  console.log(failures === 0 ? 'TURN 中继全部通过 🎉' : `${failures} 项失败`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('测试异常：', err);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
