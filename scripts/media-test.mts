/**
 * 摄像头采集链路的单元测试（无需真实硬件，任何平台都能跑）。
 *
 * 用假的 navigator.mediaDevices 打桩，直接驱动 media.ts 里的真实逻辑，
 * 验证「出问题能不能降级、能不能保住已有轨道」，而不是 Chromium 的采集能力。
 * 真机画面请在打包后手动验证。
 *
 *   npx tsx scripts/media-test.mts
 */
import assert from 'node:assert/strict';

// ── 打桩：media.ts 只依赖 navigator.mediaDevices 与 MediaStream/MediaStreamTrack ──
class FakeTrack {
  kind: 'audio' | 'video';
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  listeners: Record<string, (() => void)[]> = {};
  settings: { width?: number; height?: number };
  constructor(kind: 'audio' | 'video', settings: { width?: number; height?: number } = {}) {
    this.kind = kind;
    this.settings = settings;
  }
  stop(): void {
    this.readyState = 'ended';
  }
  getSettings(): { width?: number; height?: number } {
    return this.settings;
  }
  addEventListener(name: string, fn: () => void): void {
    (this.listeners[name] ??= []).push(fn);
  }
  removeEventListener(name: string, fn: () => void): void {
    this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn);
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

const def = (name: string, value: unknown): void => {
  // Node 21+ 的 navigator 是只读 getter，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
def('MediaStream', FakeStream);
def('MediaStreamTrack', FakeTrack);
def('window', globalThis);
def('navigator', { mediaDevices: {} });

interface Constraints {
  video?: unknown;
  audio?: unknown;
}

const calls: Constraints[] = [];
let handler: (c: Constraints) => FakeStream = () => {
  throw named('NotFoundError');
};

(globalThis as unknown as { navigator: { mediaDevices: unknown } }).navigator.mediaDevices = {
  getUserMedia: async (c: Constraints) => {
    calls.push(c);
    return handler(c);
  },
};

function named(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const asksVideo = (c: Constraints): boolean => c.video !== false && c.video !== undefined;
const asksAudio = (c: Constraints): boolean => c.audio !== false && c.audio !== undefined;
const exactOf = (c: Constraints): string | undefined =>
  (c.video as { deviceId?: { exact?: string } } | undefined)?.deviceId?.exact;
const hasQuality = (c: Constraints): boolean => !!(c.video as { width?: unknown } | undefined)?.width;

const cam = (w = 1280, h = 720): FakeStream =>
  new FakeStream([new FakeTrack('video', { width: w, height: h }), new FakeTrack('audio')]);

const media = await import('../apps/desktop/src/renderer/lib/media.ts');

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✅ ${label}`);
}

function reset(): void {
  calls.length = 0;
  media.releaseLocalStream();
}

// 1. 正常路径：第一档就成，不要有多余往返
reset();
handler = () => cam();
{
  const s = await media.acquireLocalStream({ video: true, audio: true });
  check('正常情况一次拿到音视频', () => {
    assert.equal(s.getVideoTracks().length, 1);
    assert.equal(s.getAudioTracks().length, 1);
    assert.equal(calls.length, 1);
    assert.equal(hasQuality(calls[0]!), true);
  });
}

// 2. 记住的设备 id 已失效（换 USB 口/拔插）→ 必须退到系统默认设备
reset();
handler = (c) => {
  if (exactOf(c)) throw named('OverconstrainedError', 'device gone');
  return cam();
};
{
  const s = await media.acquireLocalStream({ video: true, audio: true, videoDeviceId: 'stale-id' });
  check('指定设备失效后自动改用默认设备', () => {
    assert.equal(s.getVideoTracks().length, 1);
    assert.ok(calls.some((c) => exactOf(c) === 'stale-id'), '应先试过指定设备');
    assert.ok(calls.some((c) => !exactOf(c) && asksVideo(c)), '应退到无 deviceId 的档位');
  });
}

// 3. 只出 4K 的相机不认 720p → 第二档（不带画质约束）兜住
reset();
handler = (c) => {
  if (hasQuality(c)) throw named('OverconstrainedError', 'unsupported 1280x720');
  return cam(3840, 2160);
};
{
  const s = await media.acquireLocalStream({ video: true, audio: true });
  check('画质约束不满足时降到无约束档', () => {
    assert.equal(s.getVideoTracks().length, 1);
    assert.equal(hasQuality(calls[0]!), true, '第一档应带画质约束');
    assert.equal(hasQuality(calls[1]!), false, '第二档应去掉画质约束');
  });
}

// 4. 麦克风被别的程序占用 → 合并请求全失败，拆开后视频仍能拿到
reset();
handler = (c) => {
  const v = asksVideo(c);
  const a = asksAudio(c);
  if (v && a) throw named('NotReadableError', 'mic busy');
  if (v) return new FakeStream([new FakeTrack('video', { width: 640, height: 480 })]);
  throw named('NotReadableError', 'mic busy');
};
{
  const s = await media.acquireLocalStream({ video: true, audio: true });
  check('麦克风被占用时仍能单独拿到视频', () => {
    assert.equal(s.getVideoTracks().length, 1);
    assert.equal(s.getAudioTracks().length, 0);
  });
}

// 5. 关键回归：中途重开摄像头失败，麦克风不能被连带停掉
reset();
handler = (c) => {
  if (asksVideo(c)) throw named('NotReadableError', 'camera busy');
  return new FakeStream([new FakeTrack('audio')]);
};
{
  const audioOnly = await media.acquireLocalStream({ video: false, audio: true });
  const mic = audioOnly.getAudioTracks()[0]!;
  let threw = false;
  try {
    await media.acquireLocalStream({ video: true, audio: false });
  } catch {
    threw = true;
  }
  check('重开摄像头失败后麦克风仍在（不会整场静音）', () => {
    assert.equal(threw, true);
    assert.equal(mic.readyState, 'live', '麦克风轨道被误杀');
    assert.equal(media.hasTrack('audio'), true);
    assert.equal(media.hasTrack('video'), false);
  });
}

// 6. 权限被拒是终止性错误，不该把降级链跑完
reset();
handler = () => {
  throw named('NotAllowedError');
};
{
  let name = '';
  try {
    await media.acquireLocalStream({ video: true, audio: true });
  } catch (e) {
    name = (e as Error).name;
  }
  check('权限被拒立即终止，不做无谓重试', () => {
    assert.equal(name, 'NotAllowedError');
    assert.equal(calls.length, 1);
  });
}

// 7. 只要视频却只拿到音频（驱动异常）→ 判失败，别显示「已开摄像头」但一片黑
reset();
handler = () => new FakeStream([new FakeTrack('audio')]);
{
  let failed = false;
  try {
    await media.acquireLocalStream({ video: true, audio: false });
  } catch {
    failed = true;
  }
  check('要视频却只有音频时判失败', () => assert.equal(failed, true));
}

// 8. 首帧检测：settings.width 为 0 → 判定无画面（macOS「协商成功不出帧」）
{
  const dead = new FakeStream([new FakeTrack('video', { width: 0, height: 0 })]);
  const r = await media.waitForVideoFrames(dead as unknown as MediaStream, 120);
  check('首帧检测能识别「协商成功但不出帧」', () => {
    assert.equal(r.ok, false);
    assert.equal(r.width, 0);
  });
}

// 9. 有帧进来 → 判定画面正常
{
  const live = new FakeStream([new FakeTrack('video', { width: 640, height: 480 })]);
  const r = await media.waitForVideoFrames(live as unknown as MediaStream, 120);
  check('首帧检测识别正常画面', () => {
    assert.equal(r.ok, true);
    assert.equal(r.width, 640);
  });
}

media.releaseLocalStream();
console.log(`\n摄像头采集链路 ${passed} 项全部通过 🎉`);
