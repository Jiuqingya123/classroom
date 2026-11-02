import { create } from 'zustand';
import type {
  AwardKind,
  ChatMessageDTO,
  DiagSnapshot,
  IceServerConfig,
  JoinRoomResult,
  ParticipantDTO,
  QuizPublicState,
  QuizResultState,
  QuizStartInput,
  RoomAnnouncement,
  RoomAwardBroadcast,
  RoomControlAction,
  RoomDTO,
  RoomSigninState,
  RoomTimerMode,
  RoomTimerState,
} from '@classroom/shared';
import {
  createSocket,
  describeSocketError,
  PeerManager,
  WhiteboardClient,
  type AppClientSocket,
} from '@classroom/client-core';
import type { Role } from '@classroom/shared';
import type { MediaAccessResult, ScreenSource } from '../../shared/ipc';
import { tokenHolder } from '../lib/api';
import { runtime } from '../lib/config';
import { requestNativeMediaPermissions } from '../lib/native';
import {
  acquireLocalStream,
  describeDisplayMediaError,
  describeMediaError,
  hasTrack,
  releaseLocalStream,
  setTrackEnabled,
  startScreenCapture,
  waitForVideoFrames,
} from '../lib/media';
import { useNav } from './nav';
import { setAuthLostHandler, useSession } from './session';

type RoomStatus = 'idle' | 'connecting' | 'joined' | 'error';

export interface PeerView {
  /** 远端摄像头（仅视频轨） */
  cam: MediaStream | null;
  /** 远端麦克风（仅音频轨）。必须独立于视频元素，关摄像头/切白板时声音不能停 */
  mic: MediaStream | null;
  screen: MediaStream | null;
  state: string;
}

interface RoomState {
  status: RoomStatus;
  error: string | null;
  notice: string | null;
  /** notice 对应的设备类型：有值说明这条提示可以一键跳到系统设置 */
  noticeMedia: 'camera' | 'microphone' | 'screen' | null;
  room: RoomDTO | null;
  selfId: string | null;
  participants: ParticipantDTO[];
  messages: ChatMessageDTO[];
  peers: Record<string, PeerView>;

  localStream: MediaStream | null;
  hasVideo: boolean;
  hasAudio: boolean;
  handRaised: boolean;

  /** 老师开启了全员静音（学生端显示提示） */
  allMuted: boolean;
  announcement: RoomAnnouncement | null;
  timer: RoomTimerState | null;
  quiz: QuizPublicState | null;
  quizResult: QuizResultState | null;
  /** 本地已提交的答案（服务端不回传个人答案） */
  myQuizAnswer: string[] | null;
  signin: RoomSigninState | null;
  awards: RoomAwardBroadcast[];
  picked: { userId: string; displayName: string; byName: string } | null;
  chatTarget: { userId: string; displayName: string } | null;

  screenStream: MediaStream | null;
  sharing: boolean;
  sharingUserId: string | null;
  shareSources: ScreenSource[];
  sharePickerOpen: boolean;
  screenPermissionMissing: boolean;

  diag: DiagSnapshot | null;
  diagOpen: boolean;

  /** 白板客户端（进房后才有） */
  wb: WhiteboardClient | null;

  connect(roomId: string, code: string | null): Promise<void>;
  leave(): Promise<void>;
  toggleCamera(): Promise<void>;
  toggleMic(): void;
  toggleHand(): void;
  setChatTarget(target: { userId: string; displayName: string } | null): void;
  sendChat(text: string, toUserId?: string): Promise<boolean>;
  endRoom(): Promise<void>;
  dismissNotice(): void;

  control(action: RoomControlAction, targetId?: string): Promise<boolean>;
  announce(content: string): Promise<boolean>;
  award(toUserId: string, kind: AwardKind, points: number, remark?: string): Promise<boolean>;
  randomPick(): Promise<boolean>;
  startQuiz(input: QuizStartInput): Promise<boolean>;
  answerQuiz(answer: string[]): Promise<boolean>;
  endQuiz(): Promise<boolean>;
  startTimer(mode: RoomTimerMode, durationSec: number): Promise<boolean>;
  stopTimer(): Promise<boolean>;
  startSignin(durationSec: number): Promise<boolean>;
  markSignin(): Promise<boolean>;
  endSignin(): Promise<boolean>;
  dismissPicked(): void;
  dismissAnnouncement(): void;
  dismissQuiz(): void;

  openSharePicker(): Promise<void>;
  closeSharePicker(): void;
  chooseShareSource(id: string): Promise<void>;
  stopShare(): void;

  toggleDiag(): void;
  refreshDiag(): Promise<void>;
}

let socket: AppClientSocket | null = null;
let pm: PeerManager | null = null;
let wb: WhiteboardClient | null = null;
let joinArgs: { roomId: string; code: string | null } | null = null;
let localScreenStream: MediaStream | null = null;
let diagTimer: ReturnType<typeof setInterval> | null = null;
let iceInfo = { count: 0, hasTurn: false };
/** 由 store 内部注入，供开发态调试钩子复用的「接上屏幕流」实现 */
let attachScreenImpl: ((stream: MediaStream) => void) | null = null;

function emitPresence(): void {
  const s = useRoom.getState();
  socket?.emit('presence:media', {
    hasVideo: s.hasVideo,
    hasAudio: s.hasAudio,
    sharing: s.sharing,
    handRaised: s.handRaised,
  });
}

function stopDiagTimer(): void {
  if (diagTimer) {
    clearInterval(diagTimer);
    diagTimer = null;
  }
}

function releaseScreen(): void {
  if (localScreenStream) {
    for (const t of localScreenStream.getTracks()) t.stop();
    localScreenStream = null;
  }
}

let wbResyncTimer: ReturnType<typeof setTimeout> | null = null;

/** 白板 op 被拒/限流后回拉权威快照，清掉本地乐观产生的幽灵元素或页面 */
function scheduleWbResync(): void {
  if (wbResyncTimer) return;
  wbResyncTimer = setTimeout(() => {
    wbResyncTimer = null;
    socket?.emit('wb:resync', { pageId: '' });
  }, 120);
}

function cleanup(): void {
  stopDiagTimer();
  if (wbResyncTimer) {
    clearTimeout(wbResyncTimer);
    wbResyncTimer = null;
  }
  releaseScreen();
  pm?.destroy();
  pm = null;
  wb?.destroy();
  wb = null;
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  joinArgs = null;
  releaseLocalStream();
}

export const useRoom = create<RoomState>((set, get) => {
  function snapshotTracks(tracks: MediaStreamTrack[]): MediaStream | null {
    // MediaStream 是原地修改的容器：轨道新增后对象引用不变，React 不会重渲染，
    // <video>/<audio> 也就不会重新绑定 srcObject。每次都包一层新实例来制造引用变化。
    return tracks.length > 0 ? new MediaStream(tracks) : null;
  }

  function buildPeerManager(iceServers: IceServerConfig[], selfId: string): PeerManager {
    pm?.destroy();
    iceInfo = {
      count: iceServers.length,
      hasTurn: iceServers.some((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'));
      }),
    };

    pm = new PeerManager({
      selfId,
      iceServers,
      send: (to, payload) => socket?.emit('rtc:signal', { to, payload }),
      onRemoteStream: (userId, kind, stream) => {
        set((st) => {
          const prev: PeerView = st.peers[userId] ?? { cam: null, mic: null, screen: null, state: 'new' };
          const next: PeerView =
            kind === 'screen'
              ? { ...prev, screen: snapshotTracks(stream.getVideoTracks()) }
              : {
                  ...prev,
                  cam: snapshotTracks(stream.getVideoTracks()),
                  mic: snapshotTracks(stream.getAudioTracks()),
                };
          return { peers: { ...st.peers, [userId]: next } };
        });
      },
      onStateChange: (userId, state) => {
        set((st) => {
          const prev: PeerView = st.peers[userId] ?? { cam: null, mic: null, screen: null, state };
          return { peers: { ...st.peers, [userId]: { ...prev, state } } };
        });
      },
      log: (message, detail) => {
        if (import.meta.env.DEV) console.debug('[rtc]', message, detail ?? '');
      },
    });

    return pm;
  }

  function buildWhiteboard(selfId: string, role: Role): WhiteboardClient {
    wb?.destroy();
    wb = new WhiteboardClient({
      selfId,
      role,
      sendOp: (payload, cb) => {
        socket?.emit('wb:op', payload, (r) => {
          cb(r.ok, r.error);
          if (!r.ok) scheduleWbResync();
        });
      },
      sendPreview: (payload) => {
        socket?.emit('wb:preview', payload);
      },
      sendCursor: (payload) => {
        socket?.emit('wb:presence', payload);
      },
      sendPage: (pageId) => {
        socket?.emit('wb:page', { pageId });
      },
      sendLock: (studentsCanDraw) => {
        socket?.emit('wb:lock', { studentsCanDraw }, () => {
          /* 老师才有权限，学生误触会被服务端忽略 */
        });
      },
    });
    return wb;
  }

  /**
   * 采集前先问系统要权限。
   *
   * 以前这里是空的（主进程实现了 requestMediaAccess 却没人调用），后果是 macOS 上
   * 首次进课堂 getUserMedia 直接拿到 NotAllowedError，系统授权框压根没弹出来 ——
   * 表现就是「摄像头打不开」。macOS 必须由主进程主动 askForMediaAccess 才会亮弹窗。
   */
  async function requestDevicePermission(): Promise<{ camera: MediaAccessResult; mic: MediaAccessResult }> {
    const d = window.desktop;
    if (!d) {
      // Android 的 WebView 不会自己弹系统权限框，先在原生侧要 CAMERA / RECORD_AUDIO
      const native = await requestNativeMediaPermissions();
      if (native) {
        const map = (s: string): MediaAccessResult =>
          s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'unknown';
        return { camera: map(native.camera), mic: map(native.microphone) };
      }
      return { camera: 'unknown', mic: 'unknown' };
    }
    const safe = (p: Promise<MediaAccessResult>): Promise<MediaAccessResult> => p.catch(() => 'unknown' as MediaAccessResult);
    const [camera, mic] = await Promise.all([safe(d.requestMediaAccess('camera')), safe(d.requestMediaAccess('microphone'))]);
    return { camera, mic };
  }

  function permissionNotice(kind: 'camera' | 'microphone'): string {
    if (runtime.isAndroid) {
      return kind === 'camera'
        ? '摄像头权限被拒绝：系统设置 → 应用 → ClassRoom → 权限 → 相机，允许后重试'
        : '麦克风权限被拒绝：系统设置 → 应用 → ClassRoom → 权限 → 麦克风，允许后重试';
    }
    const win = window.desktop?.platform === 'win32';
    if (win) {
      return kind === 'camera'
        ? '摄像头被系统禁止：设置 → 隐私和安全性 → 相机 → 打开「允许桌面应用访问相机」'
        : '麦克风被系统禁止：设置 → 隐私和安全性 → 麦克风 → 打开「允许桌面应用访问麦克风」';
    }
    if (!window.desktop) {
      return kind === 'camera'
        ? '摄像头权限被拒绝：请在浏览器地址栏的站点设置里允许摄像头'
        : '麦克风权限被拒绝：请在浏览器地址栏的站点设置里允许麦克风';
    }
    return kind === 'camera'
      ? '摄像头权限被拒绝：系统设置 → 隐私与安全性 → 摄像头，勾选本应用后重启'
      : '麦克风权限被拒绝：系统设置 → 隐私与安全性 → 麦克风，勾选本应用后重启';
  }

  /** 退化成语音课堂：不要因为一个设备拒绝就整场进不去 */
  async function fallbackToAudioOnly(message: string, media: 'camera' | 'microphone' = 'camera'): Promise<void> {
    try {
      const audioOnly = await acquireLocalStream({ video: false, audio: true });
      set({ localStream: audioOnly, hasVideo: false, hasAudio: hasTrack('audio'), notice: message, noticeMedia: media });
      pm?.setLocalStream(audioOnly);
    } catch {
      set({ localStream: null, hasVideo: false, hasAudio: false, notice: message, noticeMedia: media });
      pm?.setLocalStream(null);
    }
    emitPresence();
  }

  /**
   * 后台首帧检查：getUserMedia 成功不等于有画面。
   * macOS 上「协商成功但不出帧」是已知现象，界面会是全黑，用户只能报「摄像头打不开」。
   */
  async function verifyFirstFrame(stream: MediaStream): Promise<void> {
    const r = await waitForVideoFrames(stream, 3500);
    if (r.ok) {
      if (useRoom.getState().noticeMedia === 'camera') set({ notice: null, noticeMedia: null });
      return;
    }
    if (!useRoom.getState().hasVideo) return;
    set({
      notice: '摄像头已连接但没有画面（可能被其他程序占用或系统权限未生效），可点右侧按钮检查设置',
      noticeMedia: 'camera',
    });
  }

  async function setupMedia(): Promise<void> {
    const perm = await requestDevicePermission();

    // 明确被拒时不必白试一次：直接语音课堂 + 给一条能点开设置的提示
    if (perm.camera === 'denied' || perm.camera === 'restricted') {
      await fallbackToAudioOnly(permissionNotice('camera'), 'camera');
      return;
    }

    try {
      const stream = await acquireLocalStream({ video: true, audio: perm.mic !== 'denied' });
      set({ localStream: stream, hasVideo: hasTrack('video'), hasAudio: hasTrack('audio') });
      pm?.setLocalStream(stream);
      emitPresence();
      if (hasTrack('video')) void verifyFirstFrame(stream);
      else if (perm.mic === 'denied') set({ notice: permissionNotice('microphone'), noticeMedia: 'microphone' });
    } catch (err) {
      await fallbackToAudioOnly(describeMediaError(err), 'camera');
    }
  }

  function applyJoin(result: JoinRoomResult): void {
    const prev = get();
    const selfId = result.self?.userId ?? useSession.getState().user?.id ?? null;
    // socket 重连会重新 join：同一场答题的已选答案不能因为补拉历史而丢掉
    const sameQuiz = !!prev.quiz && prev.quiz.quizId === result.quiz?.quizId;
    const sharingUserId =
      (result.participants ?? []).find((p) => p.sharing && p.userId !== selfId)?.userId ?? null;
    set({
      status: 'joined',
      room: result.room ?? null,
      selfId,
      participants: result.participants ?? [],
      messages: result.history ?? [],
      allMuted: result.allMuted ?? false,
      announcement: result.announcement ?? null,
      timer: result.timer ?? null,
      quiz: result.quiz ?? null,
      quizResult: sameQuiz ? prev.quizResult : null,
      myQuizAnswer: sameQuiz ? prev.myQuizAnswer : null,
      signin: result.signin ?? null,
      awards: [],
      picked: null,
      chatTarget: null,
      sharingUserId,
      error: null,
    });
  }

  /** 把老师对「我」的静音/关摄像头约束落到真实轨道，而不只是改界面状态 */
  function enforceSelfControls(): void {
    const st = get();
    const self = st.participants.find((p) => p.userId === st.selfId);
    if (!self) return;
    if (self.forceMuted && st.hasAudio && setTrackEnabled('audio', false)) {
      set({ hasAudio: false, notice: '老师已将你静音' });
    }
    if (self.forceCameraOff && st.hasVideo && setTrackEnabled('video', false)) {
      set({ hasVideo: false, notice: '老师已关闭你的摄像头' });
    }
  }

  /** 把一路屏幕视频流接到所有 peer 的共享槽位上（选源之后调用） */
  function attachScreenStream(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('没有拿到屏幕视频轨');

    localScreenStream = stream;
    // 用户点系统「停止共享」时 track 会 ended，必须同步收回本地与房间状态
    track.addEventListener('ended', () => {
      if (useRoom.getState().sharing) useRoom.getState().stopShare();
    });

    set({ screenStream: stream, sharing: true });
    pm?.setScreenTrack(track);
    emitPresence();
  }
  attachScreenImpl = attachScreenStream;

  return {
    status: 'idle',
    error: null,
    notice: null,
    noticeMedia: null,
    room: null,
    selfId: null,
    participants: [],
    messages: [],
    peers: {},
    localStream: null,
    hasVideo: false,
    hasAudio: false,
    handRaised: false,
    allMuted: false,
    announcement: null,
    timer: null,
    quiz: null,
    quizResult: null,
    myQuizAnswer: null,
    signin: null,
    awards: [],
    picked: null,
    chatTarget: null,
    screenStream: null,
    sharing: false,
    sharingUserId: null,
    shareSources: [],
    sharePickerOpen: false,
    screenPermissionMissing: false,
    diag: null,
    diagOpen: false,
    wb: null,

    async connect(roomId, code) {
      if (socket) cleanup();

      const token = useSession.getState().rtcToken();
      if (!token) {
        set({ status: 'error', error: '登录状态已失效，请重新登录' });
        return;
      }

      set({
        status: 'connecting',
        error: null,
        notice: null,
        noticeMedia: null,
        peers: {},
        sharing: false,
        sharingUserId: null,
        diag: null,
        allMuted: false,
        announcement: null,
        timer: null,
        quiz: null,
        quizResult: null,
        myQuizAnswer: null,
        signin: null,
        awards: [],
        picked: null,
        chatTarget: null,
      });
      joinArgs = { roomId, code };

      const s = createSocket({ baseUrl: runtime.serverUrl, token, autoConnect: false });
      socket = s;

      s.on('connect', () => {
        if (!joinArgs) return;
        s.emit('room:join', { roomId: joinArgs.roomId, code: joinArgs.code ?? undefined }, (result) => {
          if (!result.ok) {
            const reasonMap: Record<string, string> = {
              not_found: '课堂不存在',
              bad_code: '入会码不正确',
              ended: '课堂已结束',
              full: '课堂人数已满',
              unauthorized: '没有进入该课堂的权限',
              not_member: '你不在该课程的花名册中',
              too_early: '距开课 15 分钟时才可进入教室',
            };
            set({ status: 'error', error: reasonMap[result.error ?? ''] ?? '进入课堂失败' });
            cleanup();
            return;
          }

          applyJoin(result);

          const selfId = result.self?.userId ?? useSession.getState().user?.id ?? '';
          const manager = buildPeerManager(result.iceServers ?? [], selfId);
          const others = (result.participants ?? []).map((p) => p.userId).filter((id) => id !== selfId);
          manager.syncPeers(others);

          const board = buildWhiteboard(
            selfId,
            result.self?.role ?? useSession.getState().user?.role ?? 'student',
          );
          set({ wb: board });
          // 全量拉一次白板快照；之后的变更靠 wb:op 增量
          s.emit('wb:resync', { pageId: '' });

          void setupMedia().then(() => enforceSelfControls());

          // 诊断采样常驻（5 秒一次，4 个 peer 的开销可忽略），面板打开时直接有数据
          stopDiagTimer();
          diagTimer = setInterval(() => {
            void get().refreshDiag();
          }, 5000);
          void get().refreshDiag();
        });
      });

      s.on('connect_error', (err) => {
        const msg = String(err?.message ?? '');
        if (msg.includes('unauthorized')) {
          void (async () => {
            const next = await tokenHolder.refresh?.();
            if (next) {
              s.auth = { token: useSession.getState().rtcToken() ?? '' };
              s.connect();
              return;
            }
            set({ status: 'error', error: '登录已失效，请重新登录' });
            cleanup();
            useNav.getState().goLobby();
          })();
          return;
        }
        set({ status: 'error', error: describeSocketError(err) });
      });

      s.on('peer:joined', ({ participant }) => {
        set((st) => {
          const rest = st.participants.filter((p) => p.userId !== participant.userId);
          return { participants: [...rest, participant] };
        });
        pm?.add(participant.userId);
        set({ notice: `${participant.displayName} 进入了课堂` });
      });

      s.on('peer:left', ({ userId }) => {
        const gone = get().participants.find((p) => p.userId === userId);
        pm?.remove(userId);
        set((st) => {
          const peers = { ...st.peers };
          delete peers[userId];
          return {
            participants: st.participants.filter((p) => p.userId !== userId),
            peers,
            sharingUserId: st.sharingUserId === userId ? null : st.sharingUserId,
          };
        });
        if (gone) set({ notice: `${gone.displayName} 离开了课堂` });
      });

      s.on('presence:media', ({ userId, hasVideo, hasAudio, sharing, handRaised }) => {
        set((st) => ({
          participants: st.participants.map((p) =>
            p.userId === userId
              ? {
                  ...p,
                  hasVideo,
                  hasAudio,
                  sharing,
                  handRaised,
                  handRaisedAt: handRaised ? (p.handRaised ? p.handRaisedAt : Date.now()) : null,
                }
              : p,
          ),
          sharingUserId: sharing ? userId : st.sharingUserId === userId ? null : st.sharingUserId,
        }));
      });

      s.on('presence:reject', ({ reason }) => {
        if (reason === 'sharing_occupied') {
          // 服务端才是权威：本地乐观开始共享后收到拒绝，要立刻收摊
          get().stopShare();
          set({ notice: '已有其他人在共享屏幕' });
        }
      });

      s.on('rtc:signal', ({ from, payload }) => {
        void pm?.handleSignal(from, payload);
      });

      /* ── 白板 ── */
      s.on('wb:sync', (payload) => {
        wb?.applySync(payload);
      });
      s.on('wb:op', (broadcast) => {
        wb?.applyBroadcast(broadcast);
      });
      s.on('wb:op:reject', (r) => {
        wb?.applyReject(r.elements);
        if (r.reason === 'rev_conflict') set({ notice: '该元素刚被其他人修改，已同步最新状态' });
        else if (r.reason === 'forbidden') set({ notice: '只能修改自己画的内容' });
        else if (r.reason === 'locked') set({ notice: '这个元素被老师锁定了' });
      });
      s.on('wb:preview', (p) => wb?.applyPreview(p));
      s.on('wb:presence', ({ cursors }) => wb?.applyCursors(cursors));
      s.on('wb:lock', (l) => {
        wb?.setLock(l.studentsCanDraw);
        set({ notice: l.studentsCanDraw ? '老师已允许学生绘制' : '老师锁定了白板' });
      });
      s.on('wb:page', (p) => {
        if (!wb) return;
        const st = useRoom.getState();
        // 主控端本地页永远比服务端回声新：连点时回声会落后好几页，
        // 照单全收会把画面拽回中间页，看起来就是翻页卡顿/回跳
        if (st.room?.hostId === st.selfId && p.pageId !== wb.activePageId) return;
        wb.setActivePage(p.pageId);
      });

      s.on('chat:message', (msg) => {
        set((st) =>
          st.messages.some((m) => m.id === msg.id) ? st : { messages: [...st.messages, msg] },
        );
      });

      s.on('member:updated', ({ participant }) => {
        set((st) => ({
          participants: st.participants.some((p) => p.userId === participant.userId)
            ? st.participants.map((p) => (p.userId === participant.userId ? participant : p))
            : [...st.participants, participant],
        }));
        if (participant.userId !== get().selfId) return;
        enforceSelfControls();
        const st = get();
        if (!participant.onStage && st.sharing) get().stopShare();
        if (participant.handRaised !== st.handRaised) set({ handRaised: participant.handRaised });
      });

      s.on('room:control', (c) => {
        const selfId = get().selfId;
        set((st) => ({ allMuted: c.allMuted ?? st.allMuted }));
        if (c.action === 'mute_all') {
          const self = get().participants.find((p) => p.userId === selfId);
          if (!self?.isStaff && get().hasAudio && setTrackEnabled('audio', false)) {
            set({ hasAudio: false });
          }
          set({ notice: c.by === selfId ? '已全体静音' : '老师开启了全员静音' });
        } else if (c.action === 'unmute_all') {
          set({ notice: c.by === selfId ? '已解除全员静音' : '老师解除了全员静音' });
        } else if (c.targetId === selfId) {
          // 不等 member:updated：静音/关摄像头必须立刻落到本地轨道
          if (c.action === 'mute' && get().hasAudio && setTrackEnabled('audio', false)) {
            set({ hasAudio: false });
          }
          if (c.action === 'camera_off' && get().hasVideo && setTrackEnabled('video', false)) {
            set({ hasVideo: false });
          }
          const map: Partial<Record<RoomControlAction, string>> = {
            mute: '老师已将你静音',
            camera_off: '老师已关闭你的摄像头',
            approve_hand: '老师同意你发言，可以打开麦克风了',
            invite_stage: '老师邀请你上台',
            remove_stage: '你已被请下台',
          };
          const msg = map[c.action];
          if (msg) set({ notice: msg });
        }
      });

      s.on('room:announce', (a) => {
        set({ announcement: a, notice: `新公告：${a.content.slice(0, 30)}` });
      });

      s.on('room:award', (a) => {
        set((st) => ({
          awards: [...st.awards.slice(-29), a],
          participants: st.participants.map((p) =>
            p.userId === a.toUserId ? { ...p, rewardCount: a.totalForUser } : p,
          ),
          notice: a.toUserId === st.selfId ? `你获得了 ${a.points} 分奖励` : `${a.toName} 获得奖励 +${a.points}`,
        }));
      });

      s.on('room:picked', (p) => set({ picked: p }));

      s.on('room:kicked', ({ reason, byName }) => {
        cleanup();
        set({ status: 'error', error: `${byName} 将你移出课堂：${reason}` });
      });

      s.on('quiz:state', (q) => {
        set((st) => ({
          quiz: q,
          quizResult: st.quiz?.quizId === q.quizId ? st.quizResult : null,
          myQuizAnswer: st.quiz?.quizId === q.quizId ? st.myQuizAnswer : null,
        }));
      });

      s.on('quiz:result', (r) => {
        set({ quizResult: r, quiz: null });
      });

      s.on('timer:state', (t) => {
        set({ timer: t });
      });

      s.on('signin:state', (v) => {
        const prev = get().signin;
        set({
          signin: v,
          notice:
            !prev && !v.done
              ? '老师发起了签到，请在规定时间内签到'
              : prev && !prev.done && v.done
                ? '签到已结束'
                : get().notice,
        });
      });

      s.on('room:ended', () => {
        set({ notice: '老师已结束课堂', status: 'idle' });
        cleanup();
        useNav.getState().goLobby();
      });

      s.on('room:error', ({ message }) => set({ notice: message }));

      s.io.on('reconnect_attempt', () => {
        // 长课堂里 rtc token 可能过期，重连前换最新的
        const fresh = useSession.getState().rtcToken();
        if (fresh) s.auth = { token: fresh };
      });

      s.connect();
    },

    async leave() {
      socket?.emit('room:leave');
      cleanup();
      set({
        status: 'idle',
        room: null,
        selfId: null,
        participants: [],
        messages: [],
        peers: {},
        localStream: null,
        hasVideo: false,
        hasAudio: false,
        handRaised: false,
        allMuted: false,
        announcement: null,
        timer: null,
        quiz: null,
        quizResult: null,
        myQuizAnswer: null,
        signin: null,
        awards: [],
        picked: null,
        chatTarget: null,
        screenStream: null,
        sharing: false,
        sharingUserId: null,
        sharePickerOpen: false,
        diag: null,
        diagOpen: false,
        wb: null,
        notice: null,
        noticeMedia: null,
        error: null,
      });
      useNav.getState().goLobby();
    },

    async toggleCamera() {
      if (!socket) return;
      const st = get();
      const self = st.participants.find((p) => p.userId === st.selfId);
      if (!st.hasVideo && self?.forceCameraOff) {
        set({ notice: '老师已关闭你的摄像头，暂时不能开启' });
        return;
      }

      if (st.hasVideo) {
        setTrackEnabled('video', false);
        set({ hasVideo: false });
        emitPresence();
        return;
      }

      if (hasTrack('video')) {
        setTrackEnabled('video', true);
        set({ hasVideo: true });
        emitPresence();
        return;
      }

      // 之前没有视频轨（首次授权被拒 / 设备被占用），重新申请
      // 注意：audio 传 false —— 麦克风没必要为了开摄像头重新协商，acquireLocalStream 会把旧音轨拼回来
      try {
        const perm = await requestDevicePermission();
        if (perm.camera === 'denied' || perm.camera === 'restricted') {
          set({ notice: permissionNotice('camera'), noticeMedia: 'camera' });
          return;
        }
        const stream = await acquireLocalStream({ video: true, audio: false });
        set({ localStream: stream, hasVideo: hasTrack('video'), hasAudio: hasTrack('audio'), notice: null, noticeMedia: null });
        pm?.setLocalStream(stream);
        emitPresence();
        void verifyFirstFrame(stream);
      } catch (err) {
        set({ notice: describeMediaError(err), noticeMedia: 'camera' });
      }
    },

    toggleMic() {
      if (!socket) return;
      const st = get();
      const self = st.participants.find((p) => p.userId === st.selfId);
      if (!st.hasAudio && self?.forceMuted) {
        set({ notice: '老师已将你静音，暂时不能开麦' });
        return;
      }
      if (st.hasAudio) {
        setTrackEnabled('audio', false);
        set({ hasAudio: false });
      } else if (hasTrack('audio')) {
        setTrackEnabled('audio', true);
        set({ hasAudio: true });
      } else {
        set({ notice: '没有可用的麦克风' });
        return;
      }
      emitPresence();
    },

    toggleHand() {
      if (!socket) return;
      set({ handRaised: !get().handRaised });
      emitPresence();
    },

    setChatTarget(target) {
      set({ chatTarget: target });
    },

    control(action, targetId) {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('room:control', { action, targetId }, (r) => {
          if (!r.ok) {
            const map: Record<string, string> = {
              forbidden: '只有老师或助教可以执行该操作',
              target_not_found: '对方已离开课堂',
              cannot_kick_staff: '不能移出教学人员',
            };
            set({ notice: map[r.error ?? ''] ?? '操作失败' });
          }
          resolve(r.ok);
        });
      });
    },

    announce(content) {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('room:announce', { content }, (r) => {
          if (!r.ok) set({ notice: '公告发送失败' });
          resolve(r.ok);
        });
      });
    },

    award(toUserId, kind, points, remark) {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('room:award', { toUserId, kind, points, remark }, (r) => {
          if (!r.ok) set({ notice: r.error === 'forbidden' ? '只有老师可以发放奖励' : '奖励发送失败' });
          resolve(r.ok);
        });
      });
    },

    randomPick() {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('room:random_pick', (r) => {
          if (!r.ok) {
            const map: Record<string, string> = {
              forbidden: '只有老师可以随机点名',
              no_students: '当前没有可点名的学生',
            };
            set({ notice: map[r.error ?? ''] ?? '点名失败' });
          }
          resolve(r.ok);
        });
      });
    },

    startQuiz(input) {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('quiz:start', input, (r) => {
          if (!r.ok) {
            const map: Record<string, string> = {
              bad_options: '选项不完整',
              bad_answer: '请设置正确答案',
              bad_stem: '题干不能为空',
            };
            set({ notice: map[r.error ?? ''] ?? '发起答题失败' });
          }
          resolve(r.ok);
        });
      });
    },

    answerQuiz(answer) {
      return new Promise<boolean>((resolve) => {
        const q = get().quiz;
        if (!socket || !q) return resolve(false);
        socket.emit('quiz:answer', { quizId: q.quizId, answer }, (r) => {
          if (!r.ok) {
            const map: Record<string, string> = {
              quiz_ended: '答题已结束',
              no_quiz: '当前没有进行中的答题',
              bad_answer: '请选择答案',
            };
            set({ notice: map[r.error ?? ''] ?? '提交答案失败' });
          } else {
            set({ myQuizAnswer: answer });
          }
          resolve(r.ok);
        });
      });
    },

    endQuiz() {
      return new Promise<boolean>((resolve) => {
        const q = get().quiz;
        if (!socket || !q) return resolve(false);
        socket.emit('quiz:end', { quizId: q.quizId }, (r) => {
          if (!r.ok) set({ notice: '结束答题失败' });
          resolve(r.ok);
        });
      });
    },

    startTimer(mode, durationSec) {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('timer:start', { mode, durationSec }, (r) => {
          if (!r.ok) set({ notice: r.error === 'forbidden' ? '只有老师可以控制计时器' : '计时器启动失败' });
          resolve(r.ok);
        });
      });
    },

    stopTimer() {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('timer:stop', (r) => {
          if (!r.ok) set({ notice: '计时器停止失败' });
          resolve(r.ok);
        });
      });
    },

    startSignin(durationSec) {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('signin:start', { durationSec }, (r) => {
          if (!r.ok) set({ notice: '签到发起失败' });
          resolve(r.ok);
        });
      });
    },

    markSignin() {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('signin:mark', (r) => {
          if (!r.ok) set({ notice: '签到失败，可能已结束' });
          resolve(r.ok);
        });
      });
    },

    endSignin() {
      return new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        socket.emit('signin:end', (r) => {
          if (!r.ok) set({ notice: '结束签到失败' });
          resolve(r.ok);
        });
      });
    },

    dismissPicked() {
      set({ picked: null });
    },

    dismissAnnouncement() {
      set({ announcement: null });
    },

    dismissQuiz() {
      set({ quiz: null, quizResult: null, myQuizAnswer: null });
    },

    async sendChat(text, toUserId) {
      const content = text.trim();
      if (!content || !socket) return false;
      return new Promise<boolean>((resolve) => {
        socket?.emit('chat:send', { content, toUserId }, (r) => {
          if (!r.ok) {
            const map: Record<string, string> = {
              rate_limited: '发得太快了，缓一缓',
              private_denied: '只能与老师或学生私聊',
              target_not_found: '对方已离开课堂',
            };
            set({ notice: map[r.error ?? ''] ?? '消息发送失败' });
          }
          resolve(r.ok);
        });
      });
    },

    async endRoom() {
      if (!socket) return;
      await new Promise<void>((resolve) => {
        socket?.emit('room:end', (r) => {
          if (!r.ok) set({ notice: r.error === 'forbidden' ? '只有老师可以结束课堂' : '结束课堂失败' });
          resolve();
        });
      });
      cleanup();
      set({
        status: 'idle',
        room: null,
        selfId: null,
        participants: [],
        messages: [],
        peers: {},
        localStream: null,
        hasVideo: false,
        hasAudio: false,
        handRaised: false,
        allMuted: false,
        announcement: null,
        timer: null,
        quiz: null,
        quizResult: null,
        myQuizAnswer: null,
        signin: null,
        awards: [],
        picked: null,
        chatTarget: null,
        screenStream: null,
        sharing: false,
        sharingUserId: null,
        wb: null,
      });
      useNav.getState().goLobby();
    },

    dismissNotice() {
      set({ notice: null, noticeMedia: null });
    },

    async openSharePicker() {
      if (!window.desktop) {
        set({ notice: '屏幕共享仅在桌面客户端可用' });
        return;
      }
      if (get().sharing) {
        get().stopShare();
        return;
      }
      const other = get().sharingUserId;
      if (other && other !== get().selfId) {
        set({ notice: '已有其他人在共享屏幕，同一时间只能一个人共享' });
        return;
      }

      const list = await window.desktop.listScreenSources();
      if (!list.hasPermission) {
        set({ notice: '需要先授予「屏幕录制」权限，授权后请重启应用', noticeMedia: 'screen', screenPermissionMissing: true });
        await window.desktop.openScreenSettings();
        return;
      }
      if (list.sources.length === 0) {
        set({ notice: '没有可共享的屏幕或窗口' });
        return;
      }
      set({ shareSources: list.sources, sharePickerOpen: true, screenPermissionMissing: false });
    },

    closeSharePicker() {
      set({ sharePickerOpen: false });
    },

    async chooseShareSource(id) {
      set({ sharePickerOpen: false });
      try {
        // 先告诉主进程选哪个源，紧接着 getDisplayMedia 才会消费这个选择
        if (window.desktop) await window.desktop.pickScreenSource(id);
        const stream = await startScreenCapture();
        attachScreenStream(stream);
      } catch (err) {
        set({ notice: describeDisplayMediaError(err) });
      }
    },

    stopShare() {
      releaseScreen();
      set({ screenStream: null, sharing: false });
      pm?.setScreenTrack(null);
      emitPresence();
    },

    toggleDiag() {
      const open = !get().diagOpen;
      set({ diagOpen: open });
      if (open) void get().refreshDiag();
    },

    async refreshDiag() {
      if (!pm) return;
      const diagPeers = await pm.refresh();
      const st = get();
      set({
        diag: {
          peers: diagPeers,
          local: {
            camera: hasTrack('video'),
            mic: hasTrack('audio'),
            screen: st.sharing,
          },
          iceServerCount: iceInfo.count,
          hasTurn: iceInfo.hasTurn,
        },
      });
    },
  };
});

/** 当前课堂内的教学权限，不能拿全局角色代替（旁听老师不应看到管控入口） */
export function useSelfStaff(): boolean {
  return useRoom(
    (s) => s.participants.find((p) => p.userId === s.selfId)?.isStaff ?? false,
  );
}

setAuthLostHandler(() => {
  if (useRoom.getState().status !== 'idle') void useRoom.getState().leave();
});

/**
 * 开发态调试句柄：自动化测试与手工排查用。
 * 生产构建里 import.meta.env.DEV 为 false，整块会被打成死代码。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__classroomDebug'] = {
    roomState: () => useRoom.getState(),
    refreshDiag: () => useRoom.getState().refreshDiag(),
    peerCount: () => pm?.size ?? 0,
    pcStates: () => pm?.debugStates() ?? [],
    wb: () => useRoom.getState().wb,
    /** 仅供自动化测试：从 URL 取一份 PDF，走与 UI 完全相同的导入路径 */
    importPdfFromUrl: async (url: string) => {
      const board = useRoom.getState().wb;
      if (!board) return -1;
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], 'test.pdf', { type: 'application/pdf' });
      const { importPdfCourseware } = await import('../lib/import');
      return importPdfCourseware(file, {
        client: board,
        roomId: useRoom.getState().room?.id,
      });
    },
    /** 用 canvas 流顶替真实屏幕采集，仅用于在没有录屏权限的环境里验证传输通路 */
    injectScreen: (stream: MediaStream) => {
      attachScreenImpl?.(stream);
      return true;
    },
    stopScreen: () => useRoom.getState().stopShare(),
    /** 仅供自动化测试：模拟重连后的强制重同步，可带过期页 id 验证服务端权威 */
    wbResync: (pageId = '') => {
      socket?.emit('wb:resync', { pageId });
    },
  };
}
