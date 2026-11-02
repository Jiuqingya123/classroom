export interface AcquireOptions {
  video: boolean;
  audio: boolean;
  videoDeviceId?: string;
  audioDeviceId?: string;
}

let current: MediaStream | null = null;

/** 高清档位。相机只支持 4K 或只支持 640×480 时，这一档会抛 OverconstrainedError，靠降级兜住 */
const HQ: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24, max: 30 },
};

const AUDIO_BASE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** 这些错误重试没有意义：权限被拒时再问一百次也是拒 */
const FATAL = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError', 'PermissionBlockedError']);

/** true / {} 都表示「不设约束，用系统默认设备」，等价但类型不同，统一用这个别名 */
type Attempt = MediaTrackConstraints | true;

function kindOf(track: MediaStreamTrack): 'video' | 'audio' {
  return track.kind === 'video' ? 'video' : 'audio';
}

function isFatal(err: unknown): boolean {
  return FATAL.has((err as { name?: string })?.name ?? '');
}

/**
 * 视频约束档位，从「最精确」到「最宽松」。
 *
 * 为什么必须降级：`deviceId: { exact }` 与 720p 是两条硬约束，任一不满足整次调用就失败。
 * 常见踩坑：USB 相机只出 1080p/4K（OverconstrainedError）、默认设备换了 id、
 * 虚拟摄像头（OBS / 美颜）不认 frameRate 上限。
 */
function videoLadder(deviceId?: string): Attempt[] {
  const byId: Attempt[] = deviceId ? [{ ...HQ, deviceId: { exact: deviceId } }, { deviceId: { exact: deviceId } }] : [];
  // 指定设备彻底不在时，最后退到系统默认设备，至少让人有画面
  return [...byId, { ...HQ }, {}];
}

function audioLadder(deviceId?: string): Attempt[] {
  const byId: Attempt[] = deviceId ? [{ ...AUDIO_BASE, deviceId: { exact: deviceId } }] : [];
  return [...byId, { ...AUDIO_BASE }, {}];
}

/**
 * 组合出候选约束，顺序是刻意的：
 * 先把视频档位逐级放宽（音频保持最高档），视频定下来之后再依次放宽音频。
 * 如果写成两层全排列，视频设备 id 失效时会拿同样的视频约束重复试三遍（每个音频档一次），
 * 白白多花 3 次失败往返 —— 摄像头每次失败要 1~2 秒。
 */
function combos(video: Attempt[] | null, audio: Attempt[] | null): MediaStreamConstraints[] {
  const vs: (Attempt | null)[] = video ?? [null];
  const as: (Attempt | null)[] = audio ?? [null];
  const out: MediaStreamConstraints[] = [];
  for (const v of vs) out.push({ video: v ?? false, audio: as[0] ?? false });
  for (const a of as.slice(1)) out.push({ video: vs[vs.length - 1] ?? false, audio: a ?? false });
  return out;
}

function stopKind(stream: MediaStream | null, kind: 'video' | 'audio'): void {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    if (kindOf(t) === kind) t.stop();
  }
}

function aliveTracks(stream: MediaStream | null, kind: 'video' | 'audio'): MediaStreamTrack[] {
  if (!stream) return [];
  return stream.getTracks().filter((t) => kindOf(t) === kind && t.readyState === 'live');
}

/**
 * 获取本地音视频流。
 *
 * 三条硬规则（都是踩过坑之后加的）：
 *
 * 1. **不请求的类型保住旧轨道**：`current` 里已有的轨道先摘出来，成功后拼回新流。
 *    旧实现是「先 release 再申请」，摄像头重试失败时麦克风被静默停掉，整堂课没声音。
 * 2. **只释放要重新申请的类型**：摄像头是独占设备，不先关旧轨会 NotReadableError；
 *    但麦克风没人抢，没必要为了开摄像头把它一起关掉。
 * 3. **逐级降级 + 音视频拆分**：任何一档失败继续试下一档；全失败就分别单独申请，
 *    能拿到一个算一个 —— 别让「麦克风被占用」变成「摄像头也打不开」。
 */
export async function acquireLocalStream(opts: AcquireOptions): Promise<MediaStream> {
  const needVideo = opts.video;
  const needAudio = opts.audio;
  const prev = current;

  // 只关掉这次要重新申请的轨道，另一类原样保留
  if (needVideo) stopKind(prev, 'video');
  if (needAudio) stopKind(prev, 'audio');
  const kept = [
    ...(needVideo ? [] : aliveTracks(prev, 'video')),
    ...(needAudio ? [] : aliveTracks(prev, 'audio')),
  ];

  const vList = needVideo ? videoLadder(opts.videoDeviceId) : null;
  const aList = needAudio ? audioLadder(opts.audioDeviceId) : null;

  let lastErr: unknown = new Error('无法启动摄像头/麦克风');
  let fresh: MediaStream | null = null;

  // 第一轮：按档位尝试完整组合
  for (const c of combos(vList, aList)) {
    try {
      fresh = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (err) {
      lastErr = err;
      if (isFatal(err)) break;
    }
  }

  // 第二轮：音视频分开拿。合并请求的坑在于「麦克风被腾讯会议占着」会让整次调用报
  // NotReadableError，摄像头明明可用也一起拿不到
  if (!fresh && needVideo && needAudio && !isFatal(lastErr)) {
    const parts: MediaStreamTrack[] = [];
    for (const c of combos(vList, null)) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        parts.push(...s.getTracks());
        break;
      } catch (err) {
        lastErr = err;
        if (isFatal(err)) break;
      }
    }
    for (const c of combos(null, aList)) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        parts.push(...s.getTracks());
        break;
      } catch {
        /* 音频单独也失败就认了，至少视频在 */
      }
    }
    if (parts.length > 0) fresh = new MediaStream(parts);
  }

  // 要了视频却只拿到音频算失败，否则界面显示「摄像头已开」但一片黑
  if (fresh && needVideo && fresh.getVideoTracks().length === 0) {
    fresh.getTracks().forEach((t) => t.stop());
    fresh = null;
  }

  if (!fresh) {
    // 回滚：没动的轨道恢复成当前流，别让人从「有声音」掉到「全没了」
    current = kept.length > 0 ? new MediaStream(kept) : null;
    throw lastErr;
  }

  current = new MediaStream([...fresh.getTracks(), ...kept]);
  return current;
}

export function getLocalStream(): MediaStream | null {
  return current;
}

export function setTrackEnabled(kind: 'video' | 'audio', enabled: boolean): boolean {
  if (!current) return false;
  const tracks = kind === 'video' ? current.getVideoTracks() : current.getAudioTracks();
  if (tracks.length === 0) return false;
  for (const t of tracks) t.enabled = enabled;
  return true;
}

export function hasTrack(kind: 'video' | 'audio'): boolean {
  if (!current) return false;
  return (kind === 'video' ? current.getVideoTracks() : current.getAudioTracks()).length > 0;
}

export function releaseLocalStream(): void {
  if (!current) return;
  for (const t of current.getTracks()) t.stop();
  current = null;
}

export async function listDevices(): Promise<{ cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: all.filter((d) => d.kind === 'videoinput'),
    mics: all.filter((d) => d.kind === 'audioinput'),
  };
}

/**
 * 首帧检测。
 *
 * getUserMedia 成功不等于有画面：macOS 上「参数协商成功但不出帧」是已知现象
 * （尤其在 --no-sandbox 或权限刚被拒过的时候），表现就是一张全黑的 video。
 * 判据取 track 的 settings.width —— 真有帧进来 Chromium 才会填上。
 */
export async function waitForVideoFrames(
  stream: MediaStream,
  timeoutMs = 3000,
): Promise<{ ok: boolean; width: number; height: number }> {
  const track = stream.getVideoTracks()[0];
  if (!track) return { ok: false, width: 0, height: 0 };

  const read = (): { ok: boolean; width: number; height: number } => {
    const s = track.getSettings();
    return { ok: (s.width ?? 0) > 0 && (s.height ?? 0) > 0, width: s.width ?? 0, height: s.height ?? 0 };
  };

  const first = read();
  if (first.ok) return first;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; width: number; height: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      track.removeEventListener('unmute', onUnmute);
      track.removeEventListener('ended', onEnded);
      resolve(r);
    };
    const onUnmute = (): void => finish(read());
    const onEnded = (): void => finish({ ok: false, width: 0, height: 0 });
    const timer = setTimeout(() => finish(read()), timeoutMs);
    track.addEventListener('unmute', onUnmute);
    track.addEventListener('ended', onEnded);
  });
}

const isWin = (): boolean => window.desktop?.platform === 'win32';

/**
 * getUserMedia 的报错名字极不直观，统一翻成人话。
 * 权限类错误按平台给不同指路，否则 Windows 用户会照着 macOS 的文案去找「隐私与安全性」。
 */
export function describeMediaError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return isWin()
        ? '摄像头/麦克风被系统阻止：设置 → 隐私和安全性 → 相机/麦克风 → 允许桌面应用访问'
        : '摄像头/麦克风权限被拒绝，请在「系统设置 → 隐私与安全性」中允许本应用访问';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到可用的摄像头或麦克风，请检查设备是否插好、驱动是否正常';
    case 'NotReadableError':
    case 'TrackStartError':
      return '设备被其他程序占用（常见于腾讯会议、微信视频、钉钉会议），关掉它们再点一次摄像头';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '当前摄像头不支持请求的画质，已降级仍失败，可在系统里换一个默认摄像头';
    case 'AbortError':
      return '设备启动被中断，请重试';
    default:
      return e?.message || '无法启动摄像头/麦克风';
  }
}

/**
 * 采集屏幕。
 *
 * 走标准 getDisplayMedia —— 源的选择由主进程的 setDisplayMediaRequestHandler 决定
 * （渲染进程无法指定具体窗口，这是浏览器的安全边界）。macOS 首次授权后必须重启 App 才生效。
 */
export async function startScreenCapture(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { ideal: 15, max: 20 },
    },
    audio: false,
  });
}

export function describeDisplayMediaError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case 'NotAllowedError':
      return isWin()
        ? '屏幕共享被拒绝。请重新点「共享屏幕」，在弹窗里选中一个屏幕或窗口'
        : '屏幕录制权限被拒绝。请在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用，然后重启应用';
    case 'NotFoundError':
      return '没有可共享的屏幕或窗口';
    case 'NotReadableError':
      return '无法读取屏幕内容（可能被其他录屏软件占用）';
    case 'AbortError':
      return '已取消共享';
    default:
      return e?.message || '无法开始屏幕共享';
  }
}
