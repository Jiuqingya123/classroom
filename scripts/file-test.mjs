/**
 * 文件上传 / 签名访问 / 课堂记录 的接口测试。
 * 只打 HTTP，不需要 Electron。用法：node scripts/file-test.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const API = `${BASE}/api/v1`;

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

// 1×1 红点 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const stamp = Date.now().toString().slice(-7);
  const teacher = { email: `ft${stamp}@file.dev`, password: 'password123' };
  const student = { email: `fs${stamp}@file.dev`, password: 'password123' };
  const outsider = { email: `fo${stamp}@file.dev`, password: 'password123' };

  const reg = async (u, name, role) => {
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...u, displayName: name, role }),
    });
    const body = await json(res);
    return body?.tokens;
  };

  const tTok = await reg(teacher, '王老师', 'teacher');
  const sTok = await reg(student, '张三', 'student');
  const oTok = await reg(outsider, '路人', 'student');
  check('三个账号注册成功', !!tTok && !!sTok && !!oTok);

  const tToken = tTok.accessToken;
  const sToken = sTok.accessToken;
  const oToken = oTok.accessToken;

  // 建房
  const roomRes = await fetch(`${API}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tToken}` },
    body: JSON.stringify({ title: '文件测试课堂' }),
  });
  const room = (await json(roomRes))?.room;
  check('创建课堂', !!room?.id, room?.joinCode);

  /**
   * 参与记录是在 socket 的 room:join 里创建的，HTTP 的 /rooms/join 只校验入会码。
   * 所以这里必须真的建一条 socket 连接，否则「参与人」永远是空。
   */
  function joinSocket(rtcToken, code) {
    return new Promise((resolve, reject) => {
      const sock = io(BASE, { auth: { token: rtcToken }, transports: ['websocket'] });
      const timer = setTimeout(() => {
        sock.close();
        reject(new Error('socket 进房超时'));
      }, 8000);
      sock.on('connect', () => {
        sock.emit('room:join', { roomId: room.id, code }, (r) => {
          clearTimeout(timer);
          resolve({ sock, result: r });
        });
      });
      sock.on('connect_error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  const { sock: tSock } = await joinSocket(tTok.rtcToken, undefined);
  const { sock: sSock } = await joinSocket(sTok.rtcToken, room.joinCode);
  check('老师与学生都真的进了房', !!tSock?.connected && !!sSock?.connected);

  // ── 上传 ──
  const form = new FormData();
  form.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'page-1.png');
  const upRes = await fetch(`${API}/files?roomId=${room.id}&width=1600&height=900`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tToken}` },
    body: form,
  });
  const upBody = await json(upRes);
  check('上传图片返回 201', upRes.status === 201, String(upRes.status));
  check('返回文件 id 与尺寸', !!upBody?.file?.id && upBody.file.width === 1600);
  check('返回带签名的 url', /\/files\/.+\?exp=\d+&sig=/.test(upBody?.file?.url ?? ''));

  // ── 签名访问 ──
  const fileUrl = `${BASE}${upBody.file.url}`;
  const getRes = await fetch(fileUrl);
  const got = Buffer.from(await getRes.arrayBuffer());
  check('无登录态也能用签名读到文件', getRes.status === 200, String(getRes.status));
  check('Content-Type 正确', getRes.headers.get('content-type') === 'image/png');
  check('字节与上传内容一致', got.equals(PNG_1PX), `${got.length}B`);

  // ── 篡改签名 ──
  const tampered = fileUrl.replace(/sig=([^&]{4})/, (m, p1) => `sig=${p1 === 'AAAA' ? 'BBBB' : 'AAAA'}`);
  const badRes = await fetch(tampered);
  check('签名被篡改时拒绝', badRes.status === 401, String(badRes.status));

  // ── 过期时间 ──
  const expiredUrl = fileUrl.replace(/exp=\d+/, 'exp=1000');
  const expRes = await fetch(expiredUrl);
  check('过期链接被拒绝', expRes.status === 401, String(expRes.status));

  // ── 不存在的文件 ──
  const missing = await fetch(fileUrl.replace(/\/files\/[^?]+/, '/files/does-not-exist'));
  check('不存在的文件返回 401 或 404', [401, 404].includes(missing.status), String(missing.status));

  // ── 错误类型 ──
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'x.txt');
  const badMime = await fetch(`${API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tToken}` },
    body: badForm,
  });
  check('非图片类型被拒绝', badMime.status === 400, String(badMime.status));

  // ── 超限 ──
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const bigForm = new FormData();
  bigForm.append('file', new Blob([big], { type: 'image/png' }), 'big.png');
  const bigRes = await fetch(`${API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tToken}` },
    body: bigForm,
  });
  check('超过 5MB 被拒绝', bigRes.status === 400 || bigRes.status === 413, String(bigRes.status));

  // ── 未登录上传 ──
  const anonForm = new FormData();
  anonForm.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'a.png');
  const anonRes = await fetch(`${API}/files`, { method: 'POST', body: anonForm });
  check('未登录不能上传', anonRes.status === 401, String(anonRes.status));

  // ── 批量签 URL ──
  const urlRes = await fetch(`${API}/files/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sToken}` },
    body: JSON.stringify({ fileIds: [upBody.file.id] }),
  });
  const urlBody = await json(urlRes);
  check('房间成员可以拿到签名 URL', !!urlBody?.urls?.[upBody.file.id]);

  const outsiderRes = await fetch(`${API}/files/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oToken}` },
    body: JSON.stringify({ fileIds: [upBody.file.id] }),
  });
  const outsiderBody = await json(outsiderRes);
  check('非成员拿不到签名 URL', !outsiderBody?.urls?.[upBody.file.id]);

  // ── 课堂记录 ──
  const repRes = await fetch(`${API}/rooms/${room.id}/report`, {
    headers: { Authorization: `Bearer ${tToken}` },
  });
  const rep = await json(repRes);
  check('老师能读到课堂记录', repRes.status === 200, String(repRes.status));
  check('记录包含参与人', Array.isArray(rep?.participants) && rep.participants.length >= 1, `${rep?.participants?.length} 人`);
  check('记录包含页/元素统计', typeof rep?.pageCount === 'number' && typeof rep?.elementCount === 'number');
  const tp = rep?.participants?.find((p) => p.role === 'teacher');
  check('老师那条记录的时长非负', !!tp && tp.totalMs >= 0, `${tp?.totalMs}ms`);

  const outsiderRep = await fetch(`${API}/rooms/${room.id}/report`, {
    headers: { Authorization: `Bearer ${oToken}` },
  });
  check('没参加过的人看不到记录', outsiderRep.status === 403, String(outsiderRep.status));

  const studentRep = await fetch(`${API}/rooms/${room.id}/report`, {
    headers: { Authorization: `Bearer ${sToken}` },
  });
  check('参与过的学生能看记录', studentRep.status === 200, String(studentRep.status));

  tSock?.close();
  sSock?.close();

  console.log('');
  console.log(failures === 0 ? '文件与记录接口全部通过 🎉' : `${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
