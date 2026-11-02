export type ChatKind = 'text' | 'system';

export interface ChatMessageDTO {
  id: string;
  roomId: string;
  userId: string | null;
  displayName: string;
  kind: ChatKind;
  content: string;
  /** 私聊接收者；null 为全班消息 */
  toUserId: string | null;
  toName: string | null;
  createdAt: number;
}
