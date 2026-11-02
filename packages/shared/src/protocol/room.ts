import type { Role } from './auth';

export type RoomStatus = 'open' | 'live' | 'ended';

export interface RoomDTO {
  id: string;
  title: string;
  hostId: string;
  hostName: string;
  /** 6 位数字入会码，学生凭此进房 */
  joinCode: string;
  status: RoomStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  participantCount: number;
  courseId: string | null;
  lessonId: string | null;
  courseTitle: string | null;
  lessonTitle: string | null;
}

export interface ParticipantDTO {
  userId: string;
  displayName: string;
  role: Role;
  hasVideo: boolean;
  hasAudio: boolean;
  sharing: boolean;
  handRaised: boolean;
  handRaisedAt: number | null;
  /** 是否在台上（被请下台的学生不显示视频） */
  onStage: boolean;
  /** 在当前课堂是否具备教学管理权限（创建者/管理员/课程助教），而不是看全局角色 */
  isStaff: boolean;
  /** 被老师强制静音：客户端据此禁用麦克风 */
  forceMuted: boolean;
  /** 被老师强制关闭摄像头 */
  forceCameraOff: boolean;
  rewardCount: number;
  joinedAt: number;
}

export interface MediaState {
  hasVideo: boolean;
  hasAudio: boolean;
  sharing: boolean;
}

export interface CreateRoomInput {
  title: string;
}

/* ─────────────────────────── 课堂互动 ─────────────────────────── */

export type RoomControlAction =
  | 'mute_all'
  | 'unmute_all'
  | 'mute'
  | 'unmute'
  | 'camera_off'
  | 'camera_on'
  | 'approve_hand'
  | 'reject_hand'
  | 'invite_stage'
  | 'remove_stage'
  | 'kick';

export interface RoomControlPayload {
  action: RoomControlAction;
  targetId?: string;
}

export interface RoomControlBroadcast {
  action: RoomControlAction;
  by: string;
  byName: string;
  targetId?: string;
  /** 全员静音等动作后的权威值 */
  allMuted?: boolean;
}

export type AwardKind = 'star' | 'trophy' | 'flower';

export interface RoomAwardPayload {
  toUserId: string;
  kind: AwardKind;
  points: number;
  remark?: string;
}

export interface RoomAwardBroadcast {
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
}

export interface RoomAnnouncement {
  id: string;
  content: string;
  by: string;
  byName: string;
  at: number;
}

export type RoomTimerMode = 'countdown' | 'stopwatch';

export interface RoomTimerState {
  mode: RoomTimerMode;
  /** 倒计时总秒数；正计时为 0 */
  durationSec: number;
  startedAt: number;
  endsAt: number | null;
  running: boolean;
  byName: string;
}

export interface QuizPublicState {
  quizId: string;
  questionId: string | null;
  stem: string;
  type: 'single' | 'multiple' | 'judge';
  options: Array<{ key: string; text: string }>;
  durationSec: number;
  startedAt: number;
  endsAt: number;
  byName: string;
  answeredCount: number;
  totalStudents: number;
  counts: Array<{ key: string; count: number }>;
}

export interface QuizResultState extends QuizPublicState {
  correctAnswer: string[];
  analysis: string;
  /** 仅老师可见：每个学生的作答 */
  answers?: Array<{ userId: string; displayName: string; answer: string[]; correct: boolean }>;
}

export interface RoomSigninState {
  signinId: string;
  startedAt: number;
  endsAt: number;
  done: boolean;
  signedCount: number;
  totalStudents: number;
  /** 仅老师可见 */
  signed?: Array<{ userId: string; displayName: string; at: number }>;
}
