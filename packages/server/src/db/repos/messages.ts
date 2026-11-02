import type { ChatMessageDTO, ChatKind } from '@classroom/shared';
import type { DB } from '../index';

interface DbMessageRow {
  id: string;
  room_id: string;
  user_id: string | null;
  display_name: string;
  kind: ChatKind;
  content: string;
  to_user_id: string | null;
  to_name: string | null;
  created_at: number;
}

export interface MessageRepo {
  insert(m: ChatMessageDTO): Promise<void>;
  listByRoom(roomId: string, limit?: number): Promise<ChatMessageDTO[]>;
  /** 只返回该用户可见的消息：全班消息 + 自己收发的私聊 */
  listForUser(roomId: string, userId: string, limit?: number): Promise<ChatMessageDTO[]>;
  countByRoom(roomId: string): Promise<number>;
  countAll(): Promise<number>;
}

export function createMessageRepo(db: DB): MessageRepo {
  const ins = db.prepare(
    `INSERT INTO messages (id, room_id, user_id, display_name, kind, content, to_user_id, created_at)
     VALUES (@id, @roomId, @userId, @displayName, @kind, @content, @toUserId, @createdAt)`,
  );
  const list = db.prepare(
    `SELECT * FROM (
       SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
     ) ORDER BY created_at ASC`,
  );
  const visible = db.prepare(
    `SELECT * FROM (
       SELECT m.*, tu.display_name AS to_name
       FROM messages m LEFT JOIN users tu ON tu.id = m.to_user_id
       WHERE m.room_id = ? AND (m.to_user_id IS NULL OR m.user_id = ? OR m.to_user_id = ?)
       ORDER BY m.created_at DESC LIMIT ?
     ) ORDER BY created_at ASC`,
  );

  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?');
  const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM messages');

  function map(r: DbMessageRow): ChatMessageDTO {
    return {
      id: r.id,
      roomId: r.room_id,
      userId: r.user_id,
      displayName: r.display_name,
      kind: r.kind,
      content: r.content,
      toUserId: r.to_user_id ?? null,
      toName: r.to_name ?? null,
      createdAt: r.created_at,
    };
  }

  return {
    async insert(m) {
      // toName 来自 users 联表，表里没有该列；node:sqlite 会拒绝多余的命名参数
      ins.run({
        id: m.id,
        roomId: m.roomId,
        userId: m.userId,
        displayName: m.displayName,
        kind: m.kind,
        content: m.content,
        toUserId: m.toUserId,
        createdAt: m.createdAt,
      });
    },
    async countByRoom(roomId) {
      const row = countStmt.get(roomId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async countAll() {
      const row = countAllStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async listByRoom(roomId, limit = 200) {
      const rows = list.all(roomId, limit) as unknown as DbMessageRow[];
      return rows.map(map);
    },
    async listForUser(roomId, userId, limit = 200) {
      const rows = visible.all(roomId, userId, userId, limit) as unknown as DbMessageRow[];
      return rows.map(map);
    },
  };
}
