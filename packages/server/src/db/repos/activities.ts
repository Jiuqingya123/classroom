import type { DB } from '../index';

export interface ActivityRecord {
  id: string;
  roomId: string;
  userId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

interface DbActivityRow {
  id: string;
  room_id: string;
  user_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
}

function map(r: DbActivityRow): ActivityRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    roomId: r.room_id,
    userId: r.user_id,
    kind: r.kind,
    payload,
    createdAt: r.created_at,
  };
}

export interface ActivityRepo {
  add(input: {
    id: string;
    roomId: string;
    userId: string | null;
    kind: string;
    payload: Record<string, unknown>;
    at: number;
  }): Promise<void>;
  listByRoom(roomId: string, limit?: number): Promise<ActivityRecord[]>;
  countByRoom(roomId: string, kind?: string): Promise<number>;

  markSignin(roomId: string, userId: string, at: number): Promise<boolean>;
  listSignins(roomId: string): Promise<Array<{ userId: string; displayName: string; at: number }>>;
  countSignins(roomId: string): Promise<number>;

  rewardTotals(roomId: string): Promise<Map<string, number>>;
}

export function createActivityRepo(db: DB): ActivityRepo {
  const ins = db.prepare(
    `INSERT INTO room_activities (id, room_id, user_id, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const listStmt = db.prepare(
    `SELECT id, room_id, user_id, kind, payload_json, created_at
     FROM room_activities WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
  );
  const countStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM room_activities WHERE room_id = ? AND kind = ?',
  );
  const signinIns = db.prepare(
    'INSERT OR IGNORE INTO room_signins (room_id, user_id, created_at) VALUES (?, ?, ?)',
  );
  const signinList = db.prepare(
    `SELECT s.user_id AS userId, u.display_name AS displayName, s.created_at AS at
     FROM room_signins s JOIN users u ON u.id = s.user_id
     WHERE s.room_id = ? ORDER BY s.created_at ASC`,
  );
  const rewardRows = db.prepare(
    `SELECT user_id AS userId, payload_json FROM room_activities
     WHERE room_id = ? AND kind = 'award'`,
  );

  return {
    async add(input) {
      ins.run(input.id, input.roomId, input.userId, input.kind, JSON.stringify(input.payload), input.at);
    },
    async listByRoom(roomId, limit = 200) {
      return (listStmt.all(roomId, Math.min(limit, 500)) as unknown as DbActivityRow[]).map(map);
    },
    async countByRoom(roomId, kind = '') {
      if (!kind) {
        const row = db.prepare('SELECT COUNT(*) AS n FROM room_activities WHERE room_id = ?').get(roomId) as
          | { n: number } | undefined;
        return row?.n ?? 0;
      }
      const row = countStmt.get(roomId, kind) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async markSignin(roomId, userId, at) {
      return Number(signinIns.run(roomId, userId, at).changes) > 0;
    },
    async listSignins(roomId) {
      return signinList.all(roomId) as unknown as Array<{ userId: string; displayName: string; at: number }>;
    },
    async countSignins(roomId) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM room_signins WHERE room_id = ?').get(roomId) as
        | { n: number } | undefined;
      return row?.n ?? 0;
    },
    async rewardTotals(roomId) {
      const totals = new Map<string, number>();
      const rows = rewardRows.all(roomId) as Array<{ userId: string | null; payload_json: string }>;
      for (const row of rows) {
        if (!row.userId) continue;
        let points = 0;
        try {
          const p = JSON.parse(row.payload_json) as { points?: unknown };
          points = typeof p.points === 'number' ? p.points : 0;
        } catch {
          points = 0;
        }
        totals.set(row.userId, (totals.get(row.userId) ?? 0) + points);
      }
      return totals;
    },
  };
}
