import type { NotificationDTO, NotificationKind } from '@classroom/shared';
import type { DB } from '../index';

interface DbNotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  read_at: number | null;
  created_at: number;
}

function map(r: DbNotificationRow): NotificationDTO {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export interface NotificationRepo {
  create(input: {
    id: string;
    userId: string;
    kind: NotificationKind;
    title: string;
    body?: string;
    link?: string;
    at: number;
  }): Promise<void>;
  list(userId: string, limit?: number): Promise<NotificationDTO[]>;
  unreadCount(userId: string): Promise<number>;
  markRead(id: string, userId: string, at: number): Promise<void>;
  markAllRead(userId: string, at: number): Promise<void>;
}

export function createNotificationRepo(db: DB): NotificationRepo {
  const ins = db.prepare(
    `INSERT INTO notifications (id, user_id, kind, title, body, link, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const listStmt = db.prepare(
    `SELECT id, kind, title, body, link, read_at, created_at
     FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  );
  const unreadStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
  );
  return {
    async create(input) {
      ins.run(input.id, input.userId, input.kind, input.title, input.body ?? '', input.link ?? '', input.at);
    },
    async list(userId, limit = 50) {
      return (listStmt.all(userId, Math.min(limit, 200)) as unknown as DbNotificationRow[]).map(map);
    },
    async unreadCount(userId) {
      const row = unreadStmt.get(userId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async markRead(id, userId, at) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(at, id, userId);
    },
    async markAllRead(userId, at) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId);
    },
  };
}
