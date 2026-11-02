import type { Role } from './auth';

/** 上传后的文件元信息 */
export interface FileDTO {
  id: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  /** 相对路径（含签名），客户端拼上 serverUrl 即可直接用 */
  url: string;
  expiresAt: number;
}

export interface FileUploadResult {
  file: FileDTO;
}

/* ─────────────────────────── 课堂记录 ─────────────────────────── */

export interface ReportParticipant {
  userId: string;
  displayName: string;
  role: Role;
  joinedAt: number;
  leftAt: number | null;
  /** 累计在线时长（多次进出累加） */
  totalMs: number;
}

export interface RoomReportDTO {
  roomId: string;
  title: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  /** 课堂时长；未结束则为「距最后一次活动」 */
  durationMs: number;
  participants: ReportParticipant[];
  messageCount: number;
  pageCount: number;
  /** 白板元素数（含已删除的墓碑，反映真实产生量） */
  elementCount: number;
}
