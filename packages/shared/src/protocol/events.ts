import type { Role } from './auth';
import type { ChatMessageDTO } from './chat';
import type {
  AwardKind,
  MediaState,
  ParticipantDTO,
  QuizPublicState,
  QuizResultState,
  RoomAnnouncement,
  RoomControlBroadcast,
  RoomControlPayload,
  RoomDTO,
  RoomSigninState,
  RoomTimerMode,
  RoomTimerState,
} from './room';
import type { IceServerConfig, SignalPayload } from './rtc';
import type {
  PageMeta,
  WbBroadcast,
  WbCursor,
  WbLockState,
  WbOpPayload,
  WbPreviewBroadcast,
  WbPreviewPayload,
  WbRejectReason,
  WbSyncPayload,
  WhiteboardElement,
} from './whiteboard';

/* ─────────────────────────── 房间 ─────────────────────────── */

export interface JoinRoomPayload {
  roomId: string;
  /** 非房主进房必须带 6 位入会码 */
  code?: string;
}

export type JoinErrorReason =
  | 'not_found'
  | 'bad_code'
  | 'ended'
  | 'full'
  | 'unauthorized'
  | 'not_member'
  | 'too_early';

export interface JoinRoomResult {
  ok: boolean;
  error?: JoinErrorReason;
  room?: RoomDTO;
  self?: ParticipantDTO;
  participants?: ParticipantDTO[];
  iceServers?: IceServerConfig[];
  studentsCanDraw?: boolean;
  history?: ChatMessageDTO[];
  announcement?: RoomAnnouncement | null;
  timer?: RoomTimerState | null;
  quiz?: QuizPublicState | null;
  signin?: RoomSigninState | null;
  allMuted?: boolean;
}

export type Ack<T> = (result: T) => void;

export type SimpleAck = Ack<{ ok: boolean; error?: string }>;

export interface PresenceMediaPayload extends MediaState {
  handRaised: boolean;
}

export interface QuizStartInput {
  questionId?: string | null;
  stem: string;
  type: 'single' | 'multiple' | 'judge';
  options: Array<{ key: string; text: string }>;
  correctAnswer: string[];
  analysis?: string;
  durationSec?: number;
}

/* ─────────────────────────── 事件表 ─────────────────────────── */

export interface ClientToServerEvents {
  'room:join': (payload: JoinRoomPayload, ack: Ack<JoinRoomResult>) => void;
  'room:leave': () => void;
  'room:end': (ack: SimpleAck) => void;
  'room:control': (payload: RoomControlPayload, ack: SimpleAck) => void;
  'room:announce': (payload: { content: string }, ack: SimpleAck) => void;
  'room:award': (payload: { toUserId: string; kind: AwardKind; points: number; remark?: string }, ack: SimpleAck) => void;
  'room:random_pick': (ack: Ack<{ ok: boolean; userId?: string; displayName?: string; error?: string }>) => void;

  'quiz:start': (payload: QuizStartInput, ack: SimpleAck) => void;
  'quiz:answer': (payload: { quizId: string; answer: string[] }, ack: SimpleAck) => void;
  'quiz:end': (payload: { quizId: string }, ack: SimpleAck) => void;

  'timer:start': (payload: { mode: RoomTimerMode; durationSec?: number }, ack: SimpleAck) => void;
  'timer:stop': (ack: SimpleAck) => void;

  'signin:start': (payload: { durationSec?: number }, ack: SimpleAck) => void;
  'signin:mark': (ack: SimpleAck) => void;
  'signin:end': (ack: SimpleAck) => void;

  'presence:media': (payload: PresenceMediaPayload) => void;

  'chat:send': (
    payload: { content: string; toUserId?: string },
    ack: Ack<{ ok: boolean; message?: ChatMessageDTO; error?: string }>,
  ) => void;

  'rtc:signal': (payload: { to: string; payload: SignalPayload }) => void;

  'wb:op': (payload: WbOpPayload, ack: Ack<{ ok: boolean; seq?: number; error?: WbRejectReason }>) => void;
  'wb:resync': (payload: { pageId: string }) => void;
  'wb:preview': (payload: WbPreviewPayload) => void;
  'wb:presence': (payload: { pageId: string; x: number | null; y: number | null; tool: string }) => void;
  'wb:lock': (payload: { studentsCanDraw: boolean }, ack: SimpleAck) => void;
  'wb:page': (payload: { pageId: string }) => void;
}

export interface ServerToClientEvents {
  'peer:joined': (payload: { participant: ParticipantDTO }) => void;
  'peer:left': (payload: { userId: string; reason: string }) => void;
  'member:updated': (payload: { participant: ParticipantDTO }) => void;
  'presence:media': (payload: { userId: string } & PresenceMediaPayload) => void;
  'presence:reject': (payload: { reason: 'sharing_occupied' }) => void;

  'room:control': (payload: RoomControlBroadcast) => void;
  'room:announce': (payload: RoomAnnouncement) => void;
  'room:award': (payload: {
    id: string;
    toUserId: string;
    toName: string;
    kind: AwardKind;
    points: number;
    remark: string;
    by: string;
    byName: string;
    totalForUser: number;
    at: number;
  }) => void;
  'room:picked': (payload: { userId: string; displayName: string; byName: string }) => void;
  'room:kicked': (payload: { reason: string; byName: string }) => void;

  'quiz:state': (payload: QuizPublicState) => void;
  'quiz:result': (payload: QuizResultState) => void;

  'timer:state': (payload: RoomTimerState | null) => void;
  'signin:state': (payload: RoomSigninState) => void;

  'chat:message': (payload: ChatMessageDTO) => void;

  'rtc:signal': (payload: { from: string; payload: SignalPayload }) => void;

  'room:ended': (payload: { by: string }) => void;
  'room:error': (payload: { code: string; message: string }) => void;

  'wb:sync': (payload: WbSyncPayload) => void;
  'wb:op': (payload: WbBroadcast) => void;
  'wb:op:reject': (payload: {
    opId: string;
    reason: WbRejectReason;
    elements: WhiteboardElement[];
  }) => void;
  'wb:preview': (payload: WbPreviewBroadcast) => void;
  'wb:presence': (payload: { cursors: WbCursor[] }) => void;
  'wb:lock': (payload: WbLockState) => void;
  'wb:page': (payload: { pageId: string; pages: PageMeta[] }) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

/** socket.data —— 服务端唯一可信的身份来源，永不读取客户端传来的 role */
export interface SocketData {
  user: { id: string; role: Role; displayName: string };
  roomId?: string;
}
