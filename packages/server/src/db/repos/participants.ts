import type { Role } from '@classroom/shared';
import { randomUUID } from 'node:crypto';
import type { DB } from '../index';

export interface ParticipantRow {
  id: string;
  roomId: string;
  userId: string;
  role: Role;
  joinedAt: number;
  leftAt: number | null;
}

export interface ParticipantRepo {
  open(roomId: string, userId: string, role: Role, at: number): Promise<string>;
  close(roomId: string, userId: string, at: number): Promise<void>;
  closeAll(roomId: string, at: number): Promise<void>;
  /** 进程重启后清掉上一次运行遗留的未关闭记录，否则在线人数会虚高 */
  closeAllOpen(at: number): Promise<void>;
  hasJoined(roomId: string, userId: string): Promise<boolean>;
  countActive(roomId: string): Promise<number>;
  /** 课堂记录用：带昵称的历史进出记录（按首次进入时间排序） */
  listByRoom(roomId: string): Promise<ParticipantRow[]>;
}

export interface ParticipantRowWithName extends ParticipantRow {
  displayName: string;
}

export function createParticipantRepo(db: DB): ParticipantRepo {
  const ins = db.prepare(
    `INSERT INTO room_participants (id, room_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const closeStmt = db.prepare(
    `UPDATE room_participants SET left_at = ?
     WHERE room_id = ? AND user_id = ? AND left_at IS NULL`,
  );
  const closeAllStmt = db.prepare(
    `UPDATE room_participants SET left_at = ? WHERE room_id = ? AND left_at IS NULL`,
  );
  const closeAllOpenStmt = db.prepare(
    'UPDATE room_participants SET left_at = ? WHERE left_at IS NULL',
  );
  const hasStmt = db.prepare(
    'SELECT 1 AS x FROM room_participants WHERE room_id = ? AND user_id = ? LIMIT 1',
  );
  const countStmt = db.prepare(
    'SELECT COUNT(DISTINCT user_id) AS n FROM room_participants WHERE room_id = ? AND left_at IS NULL',
  );
  const listStmt = db.prepare(
    `SELECT p.id, p.room_id AS roomId, p.user_id AS userId, p.role,
            p.joined_at AS joinedAt, p.left_at AS leftAt, u.display_name AS displayName
     FROM room_participants p
     JOIN users u ON u.id = p.user_id
     WHERE p.room_id = ?
     ORDER BY p.joined_at ASC`,
  );

  return {
    async open(roomId, userId, role, at) {
      const id = randomUUID();
      ins.run(id, roomId, userId, role, at);
      return id;
    },
    async close(roomId, userId, at) {
      closeStmt.run(at, roomId, userId);
    },
    async closeAll(roomId, at) {
      closeAllStmt.run(at, roomId);
    },
    async closeAllOpen(at) {
      closeAllOpenStmt.run(at);
    },
    async hasJoined(roomId, userId) {
      return hasStmt.get(roomId, userId) !== undefined;
    },
    async countActive(roomId) {
      const row = countStmt.get(roomId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async listByRoom(roomId) {
      return listStmt.all(roomId) as unknown as ParticipantRow[];
    },
  };
}
