/** WebRTC 信令与 ICE 配置协议。刻意不使用 DOM 的 RTCIceServer 类型，保证 shared 可在 Node 侧编译。 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceServersResponse {
  iceServers: IceServerConfig[];
  ttlSeconds: number;
  /** all = 正常直连优先；relay = 强制中继（用于诊断「NAT 问题」还是「TURN 挂了」） */
  policy: 'all' | 'relay';
}

export interface SignalCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalPayload =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: SignalCandidate | null };

export type PeerConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';

/**
 * 单个 PeerConnection 的诊断快照。
 *
 * 排查「看得见自己看不见别人」时，唯一有区分度的信息就是 candidate 类型：
 *   host  = 同一台机器/局域网直连
 *   srflx = 打洞成功（P2P 直连）
 *   relay = 走了 TURN 中继（说明打洞失败，或网络是对称 NAT）
 * 三者都为 null 则表示 ICE 压根没开始收集 → 信令没通。
 */
export interface PeerDiag {
  userId: string;
  connectionState: string;
  iceConnectionState: string;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  rttMs: number | null;
  outboundKbps: number | null;
  inboundKbps: number | null;
  /** 收发选的档位，带宽自适应后可能降级 */
  sendScale: number;
}

export interface DiagSnapshot {
  peers: PeerDiag[];
  /** 本地媒体自检 */
  local: {
    camera: boolean;
    mic: boolean;
    screen: boolean;
  };
  iceServerCount: number;
  hasTurn: boolean;
}

