import type { IceServerConfig, PeerDiag, SignalPayload } from '@classroom/shared';
import { readPeerStats, type StatsSample } from './stats';
import { applyEncoding, scaleForAvailableBitrate, tuneCameraSender, tuneScreenSender } from './tuning';

/**
 * 三个固定槽位。为什么固定：屏幕共享要能「随时开、不重新协商」，
 * 就必须在首次协商时就预留一个 video transceiver，之后只 replaceTrack。
 * 槽位号即 transceiver.mid，双端一致，所以远端靠 mid 就能分辨这是摄像头还是屏幕。
 */
const SLOT_AUDIO = 0;
const SLOT_CAMERA = 1;
const SLOT_SCREEN = 2;

export type RemoteKind = 'camera' | 'screen';

export interface PeerManagerDeps {
  selfId: string;
  iceServers: IceServerConfig[];
  send(to: string, payload: SignalPayload): void;
  onRemoteStream(userId: string, kind: RemoteKind, stream: MediaStream): void;
  onStateChange(userId: string, state: RTCPeerConnectionState, ice: RTCIceConnectionState): void;
  log?(message: string, detail?: unknown): void;
}

interface Entry {
  pc: RTCPeerConnection;
  /** 远端音频 + 摄像头合成一个流，方便单个 <video> 播放 */
  camera: MediaStream;
  screen: MediaStream;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingAnswer: boolean;
  pendingCandidates: (RTCIceCandidateInit | null)[];
  sendScale: number;
  lastSample?: StatsSample;
  iceRestartTimer: ReturnType<typeof setTimeout> | null;
  /** 埋点：协商次数，用于排查重复 renegotiation */
  negotiationCount: number;
  offersSent: number;
  answersSent: number;
  signalsIgnored: number;
}

const CAMERA_FRAMERATE = 24;

export class PeerManager {
  private readonly peers = new Map<string, Entry>();
  private micTrack: MediaStreamTrack | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private destroyed = false;

  constructor(private readonly deps: PeerManagerDeps) {}

  private log(message: string, detail?: unknown): void {
    this.deps.log?.(message, detail);
  }

  has(userId: string): boolean {
    return this.peers.has(userId);
  }

  get size(): number {
    return this.peers.size;
  }

  /** 与房间名单对齐：补齐缺失的、清掉已离开的 */
  syncPeers(userIds: string[]): void {
    for (const id of userIds) {
      if (id === this.deps.selfId) continue;
      this.ensure(id);
    }
    for (const id of [...this.peers.keys()]) {
      if (!userIds.includes(id)) this.remove(id);
    }
  }

  add(userId: string): void {
    if (userId !== this.deps.selfId) this.ensure(userId);
  }

  remove(userId: string): void {
    const entry = this.peers.get(userId);
    if (!entry) return;
    this.peers.delete(userId);
    if (entry.iceRestartTimer) clearTimeout(entry.iceRestartTimer);
    try {
      entry.pc.onnegotiationneeded = null;
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      entry.pc.close();
    } catch {
      /* 已关闭 */
    }
  }

  /** 本地音视频流变化（首次授权、切换设备、采集失败） */
  setLocalStream(stream: MediaStream | null): void {
    this.micTrack = stream?.getAudioTracks()[0] ?? null;
    this.camTrack = stream?.getVideoTracks()[0] ?? null;
    for (const entry of this.peers.values()) void this.attachLocalTracks(entry);
  }

  setScreenTrack(track: MediaStreamTrack | null): void {
    this.screenTrack = track;
    for (const entry of this.peers.values()) {
      const sender = entry.pc.getTransceivers()[SLOT_SCREEN]?.sender;
      if (!sender) continue;
      void sender.replaceTrack(track).catch((err: unknown) => this.log('screen replaceTrack failed', err));
    }
  }

  private ensure(userId: string): Entry {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: this.deps.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    const entry: Entry = {
      pc,
      camera: new MediaStream(),
      screen: new MediaStream(),
      // 双端用同一规则判定谁让步，保证恰好一方 polite
      polite: this.deps.selfId > userId,
      makingOffer: false,
      ignoreOffer: false,
      pendingAnswer: false,
      pendingCandidates: [],
      sendScale: 2,
      iceRestartTimer: null,
      negotiationCount: 0,
      offersSent: 0,
      answersSent: 0,
      signalsIgnored: 0,
    };

    // 只有发起方预建三个槽位。
    //
    // 如果两端都预建，双方会在同一时刻各自触发 negotiationneeded → 必然 glare。
    // 而 Chromium 在隐式回滚后并不会释放已关联的 transceiver，于是会再多开出
    // 一组 m-line，最后 SDP 里出现 6 条 m-line、两端连接状态彻底分叉。
    // 让发起方唯一，首轮协商就不会有碰撞；之后所有媒体切换都走 replaceTrack，永不重协商。
    const initiator = this.deps.selfId < userId;
    if (initiator) {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
    }

    pc.onnegotiationneeded = () => {
      entry.negotiationCount += 1;
      void (async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription();
          if (pc.localDescription) {
            entry.offersSent += 1;
            this.deps.send(userId, { type: 'offer', sdp: pc.localDescription.sdp });
            void this.tune(entry);
          }
        } catch (err) {
          this.log('create offer failed', err);
        } finally {
          entry.makingOffer = false;
        }
      })();
    };

    pc.onicecandidate = ({ candidate }) => {
      this.deps.send(userId, {
        type: 'candidate',
        candidate: candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              usernameFragment: candidate.usernameFragment,
            }
          : null,
      });
    };

    pc.ontrack = (ev) => {
      const mid = ev.transceiver.mid;
      const slot = mid === null ? -1 : Number(mid);
      const kind: RemoteKind = slot === SLOT_SCREEN ? 'screen' : 'camera';
      const target = kind === 'screen' ? entry.screen : entry.camera;

      // 同一路换轨后会有多个 Track 对象，只保留最新那个
      for (const t of target.getTracks()) {
        if (t.kind === ev.track.kind) target.removeTrack(t);
      }
      target.addTrack(ev.track);
      ev.track.addEventListener('ended', () => {
        target.removeTrack(ev.track);
        this.deps.onRemoteStream(userId, kind, target);
      });
      this.deps.onRemoteStream(userId, kind, target);
    };

    pc.onconnectionstatechange = () => {
      this.deps.onStateChange(userId, pc.connectionState, pc.iceConnectionState);
      if (pc.connectionState === 'failed') {
        this.log(`peer ${userId} connection failed → ICE restart`);
        try {
          pc.restartIce();
        } catch {
          /* 已关闭 */
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      // disconnected 是可恢复的（切网、短暂丢包）。等 3 秒还不回来才重协商，
      // 立刻 restart 会在网络抖动时反复打断课堂。
      if (pc.iceConnectionState === 'disconnected') {
        if (entry.iceRestartTimer) clearTimeout(entry.iceRestartTimer);
        entry.iceRestartTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            this.log(`peer ${userId} 仍 disconnected → ICE restart`);
            try {
              pc.restartIce();
            } catch {
              /* 已关闭 */
            }
          }
        }, 3000);
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (entry.iceRestartTimer) {
          clearTimeout(entry.iceRestartTimer);
          entry.iceRestartTimer = null;
        }
      }
    };

    this.peers.set(userId, entry);
    // 非发起方此刻还没有 transceiver，等收到 offer、setRemoteDescription 之后才挂本地轨道
    if (initiator) void this.attachLocalTracks(entry);
    return entry;
  }

  private async attachLocalTracks(entry: Entry): Promise<void> {
    const tr = entry.pc.getTransceivers();
    const audioSender = tr[SLOT_AUDIO]?.sender;
    const camSender = tr[SLOT_CAMERA]?.sender;
    if (audioSender) {
      await audioSender.replaceTrack(this.micTrack).catch((e: unknown) => this.log('mic replace failed', e));
    }
    if (camSender) {
      await camSender.replaceTrack(this.camTrack).catch((e: unknown) => this.log('cam replace failed', e));
    }
    // 屏幕槽位默认空着，共享时再换轨
    const screenSender = tr[SLOT_SCREEN]?.sender;
    if (screenSender) {
      await screenSender.replaceTrack(this.screenTrack).catch(() => {
        /* 初始为空是正常的 */
      });
    }
  }

  private async tune(entry: Entry): Promise<void> {
    const tr = entry.pc.getTransceivers();
    const camSender = tr[SLOT_CAMERA]?.sender;
    const screenSender = tr[SLOT_SCREEN]?.sender;
    if (camSender && this.camTrack) {
      await applyEncoding(camSender, {
        maxBitrate: entry.sendScale >= 4 ? 120_000 : entry.sendScale === 2 ? 250_000 : 500_000,
        scaleResolutionDownBy: entry.sendScale,
        maxFramerate: CAMERA_FRAMERATE,
      });
    }
    if (screenSender) await tuneScreenSender(screenSender, 'smooth');
  }

  async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    if (this.destroyed) return;
    const entry = this.ensure(from);
    const { pc } = entry;

    if (payload.type === 'candidate') {
      const init: RTCIceCandidateInit | null = payload.candidate
        ? {
            candidate: payload.candidate.candidate,
            sdpMid: payload.candidate.sdpMid ?? null,
            sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
            usernameFragment: payload.candidate.usernameFragment ?? null,
          }
        : null;

      if (!pc.remoteDescription) {
        // 还没拿到 offer 就先到的候选，必须缓冲，否则 addIceCandidate 会直接抛
        entry.pendingCandidates.push(init);
        return;
      }
      try {
        await pc.addIceCandidate(init);
      } catch (err) {
        // 被忽略的 offer 会连带产生无效候选，这类报错属正常噪音
        if (!entry.ignoreOffer) this.log('addIceCandidate failed', err);
      }
      return;
    }

    const desc: RTCSessionDescriptionInit = { type: payload.type, sdp: payload.sdp };

    // Perfect Negotiation 的三守卫
    const readyForOffer =
      !entry.makingOffer && (pc.signalingState === 'stable' || entry.pendingAnswer);
    const offerCollision = desc.type === 'offer' && !readyForOffer;
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) {
      entry.signalsIgnored += 1;
      return;
    }

    try {
      entry.pendingAnswer = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      entry.pendingAnswer = false;

      for (const c of entry.pendingCandidates.splice(0)) {
        try {
          await pc.addIceCandidate(c);
        } catch {
          /* 同上 */
        }
      }

      if (desc.type === 'offer') {
        // 非发起方的 transceiver 是在上一步 setRemoteDescription 时由 offer 创建的，
        // 所以本地轨道必须在拿到 offer 之后才挂上去，否则 answer 里没有我们的媒体。
        await this.attachLocalTracks(entry);

        // 显式纠正方向：避免「当前没有屏幕轨道」时 answer 被算成 recvonly，
        // 那样之后想开屏幕共享就必须重新协商。
        for (const t of pc.getTransceivers()) {
          if (t.direction !== 'stopped' && t.direction !== 'sendrecv') {
            t.direction = 'sendrecv';
          }
        }

        await pc.setLocalDescription();
        if (pc.localDescription) {
          entry.answersSent += 1;
          this.deps.send(from, { type: 'answer', sdp: pc.localDescription.sdp });
          void this.tune(entry);
        }
      }
    } catch (err) {
      entry.pendingAnswer = false;
      this.log('setRemoteDescription failed', err);
    }
  }

  /** 采样所有 peer 的统计，同时做带宽自适应。返回可直接喂给诊断面板的数据 */
  async refresh(): Promise<PeerDiag[]> {
    const out: PeerDiag[] = [];
    for (const [userId, entry] of this.peers) {
      const res = await readPeerStats(entry.pc, entry.lastSample);
      entry.lastSample = res.sample;

      const camSender = entry.pc.getTransceivers()[SLOT_CAMERA]?.sender;
      if (camSender && res.availableOutgoingBitrate !== null && this.camTrack) {
        const nextScale = scaleForAvailableBitrate(res.availableOutgoingBitrate);
        if (nextScale !== entry.sendScale) {
          entry.sendScale = nextScale;
          void applyEncoding(camSender, {
            maxBitrate: nextScale >= 4 ? 120_000 : nextScale === 2 ? 250_000 : 500_000,
            scaleResolutionDownBy: nextScale,
            maxFramerate: CAMERA_FRAMERATE,
          });
          this.log(`peer ${userId} 降级到 1/${nextScale}`, res.availableOutgoingBitrate);
        }
      }

      out.push({
        userId,
        connectionState: entry.pc.connectionState,
        iceConnectionState: entry.pc.iceConnectionState,
        localCandidateType: res.localCandidateType,
        remoteCandidateType: res.remoteCandidateType,
        rttMs: res.rttMs,
        outboundKbps: res.outboundKbps,
        inboundKbps: res.inboundKbps,
        sendScale: entry.sendScale,
      });
    }
    return out;
  }

  destroy(): void {
    this.destroyed = true;
    for (const id of [...this.peers.keys()]) this.remove(id);
    this.micTrack = null;
    this.camTrack = null;
    this.screenTrack = null;
  }

  /** 直接读 PeerConnection 的真实状态，供自动化测试比对 store 里的缓存值 */
  debugStates(): Array<{
    userId: string;
    connection: string;
    ice: string;
    signaling: string;
    polite: boolean;
    camTracks: number;
    screenTracks: number;
    negotiationCount: number;
    offersSent: number;
    answersSent: number;
    signalsIgnored: number;
    sdpMLines: number;
    transceivers: Array<{
      mid: string | null;
      direction: string;
      currentDirection: string | null;
      kind: string;
      senderTrack: string | null;
    }>;
  }> {
    return [...this.peers.entries()].map(([userId, e]) => ({
      userId,
      connection: e.pc.connectionState,
      ice: e.pc.iceConnectionState,
      signaling: e.pc.signalingState,
      polite: e.polite,
      camTracks: e.camera.getTracks().length,
      screenTracks: e.screen.getTracks().length,
      negotiationCount: e.negotiationCount,
      offersSent: e.offersSent,
      answersSent: e.answersSent,
      signalsIgnored: e.signalsIgnored,
      sdpMLines: (e.pc.localDescription?.sdp ?? '').split('\r\nm=').length - 1,
      transceivers: e.pc.getTransceivers().map((t) => ({
        mid: t.mid,
        direction: t.direction,
        currentDirection: t.currentDirection,
        kind: t.receiver.track?.kind ?? 'unknown',
        senderTrack: t.sender.track?.kind ?? null,
      })),
    }));
  }
}
