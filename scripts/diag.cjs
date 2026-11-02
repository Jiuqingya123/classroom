/** 诊断：登录 → 建房 → 进房，打印视频格的真实 DOM 与媒体状态 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5273';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    console.log(`[renderer:${level}]`, msg);
  });

  await win.loadURL(URL);
  await sleep(2000);

  const js = (code) => win.webContents.executeJavaScript(code);

  await js(`
    (() => {
      window.__fill = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return 'no-el';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      };
    })()
  `);

  await js(`window.__fill('#email', 'demo@classroom.dev')`);
  await js(`window.__fill('#password', 'demo12345')`);
  await sleep(200);
  await js(`document.querySelector('form.auth-form button[type=submit]').click()`);
  await sleep(2000);

  await js(`window.__fill('.card .input', '诊断课堂')`);
  await sleep(300);
  await js(`document.querySelector('.card .btn-primary').click()`);
  await sleep(3500);

  const tile = await js(`document.querySelector('.tile')?.outerHTML.slice(0, 900) ?? 'NO TILE'`);
  console.log('\n=== .tile HTML ===\n', tile);

  const videoStats = await js(`
    (() => {
      const v = document.querySelector('.tile video');
      if (!v) return { note: 'no video element' };
      const s = v.srcObject;
      const t = s && s.getVideoTracks()[0];
      return {
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
        trackSettings: t ? t.getSettings() : null,
        trackState: t ? t.readyState : null,
        muted: t ? t.muted : null,
      };
    })()
  `);
  console.log('=== video stats ===', JSON.stringify(videoStats, null, 2));

  const media = await js(`
    (() => ({
      hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      devices: 'checking',
    }))()
  `);
  console.log('\n=== media api ===', JSON.stringify(media));

  const devs = await js(
    `navigator.mediaDevices.enumerateDevices().then(d => d.map(x => x.kind + ':' + (x.label || '(no label)')))`,
  );
  console.log('=== devices ===', JSON.stringify(devs));

  const gum = await js(`
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(s => 'OK tracks=' + s.getTracks().map(t => t.kind + ':' + t.readyState).join(','))
      .catch(e => 'ERR ' + e.name + ' — ' + e.message)
  `);
  console.log('=== getUserMedia ===', gum);

  const note = await js(`document.querySelector('.stage-note')?.getBoundingClientRect().toJSON()`);
  const bar = await js(`document.querySelector('.controlbar')?.getBoundingClientRect().toJSON()`);
  const stage = await js(`document.querySelector('.stage')?.getBoundingClientRect().toJSON()`);
  console.log('=== stage rect ===', JSON.stringify(stage));
  console.log('=== note rect ===', JSON.stringify(note));
  console.log('=== controlbar rect ===', JSON.stringify(bar));

  app.quit();
});

app.on('window-all-closed', () => app.quit());
