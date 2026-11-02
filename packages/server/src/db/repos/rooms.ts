import type { RoomStatus } from '@classroom/shared';
import type { DB } from '../index';

export interface RoomRecord {
  id: string;
  title: string;
  hostId: string;
  joinCode: string;
  status: RoomStatus;
  docJson: string;
  lastSeq: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  courseId: string | null;
  lessonId: string | null;
}

export interface RoomListRow extends RoomRecord {
  hostName: string;
  activeCount: number;
  courseTitle: string | null;
  lessonTitle: string | null;
}

interface DbRoomRow {
  id: string;
  title: string;
  host_id: string;
  join_code: string;
  status: RoomStatus;
  doc_json: string;
  last_seq: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  course_id: string | null;
  lesson_id: string | null;
  course_title?: string | null;
  lesson_title?: string | null;
  host_name?: string;
  active_count?: number;
}

function map(row: DbRoomRow): RoomRecord {
  return {
    id: row.id,
    title: row.title,
    hostId: row.host_id,
    joinCode: row.join_code,
    status: row.status,
    docJson: row.doc_json,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    courseId: row.course_id ?? null,
    lessonId: row.lesson_id ?? null,
  };
}

function toListRow(row: DbRoomRow): RoomListRow {
  return {
    ...map(row),
    hostName: row.host_name ?? '',
    activeCount: row.active_count ?? 0,
    courseTitle: row.course_title ?? null,
    lessonTitle: row.lesson_title ?? null,
  };
}

export interface RoomRepo {
  insert(r: RoomRecord): Promise<void>;
  findById(id: string): Promise<RoomListRow | null>;
  /** 未结束且 code 匹配的房间 */
  findByCode(code: string): Promise<RoomListRow | null>;
  codeTaken(code: string): Promise<boolean>;
  listForUser(userId: string): Promise<RoomListRow[]>;
  setStatus(id: string, status: RoomStatus, at: number): Promise<void>;
  saveDoc(id: string, docJson: string, lastSeq: number): Promise<void>;
  bindLesson(roomId: string, lessonId: string): Promise<void>;
  count(): Promise<number>;
  countLive(): Promise<number>;
}

export function createRoomRepo(db: DB): RoomRepo {
  const ins = db.prepare(
    `INSERT INTO rooms (id, title, host_id, join_code, status, doc_json, last_seq, created_at, course_id, lesson_id)
     VALUES (@id, @title, @hostId, @joinCode, @status, @docJson, @lastSeq, @createdAt, @courseId, @lessonId)`,
  );
  const ROOM_SELECT = `
    SELECT r.*, u.display_name AS host_name,
      c.title AS course_title, l.title AS lesson_title,
      (SELECT COUNT(*) FROM room_participants p WHERE p.room_id = r.id AND p.left_at IS NULL) AS active_count
    FROM rooms r
    JOIN users u ON u.id = r.host_id
    LEFT JOIN courses c ON c.id = r.course_id
    LEFT JOIN lessons l ON l.id = r.lesson_id`;
  const byId = db.prepare(`${ROOM_SELECT} WHERE r.id = ?`);
  const byCode = db.prepare(
    `${ROOM_SELECT} WHERE r.join_code = ? AND r.status <> 'ended' LIMIT 1`,
  );
  const codeTakenStmt = db.prepare(
    `SELECT 1 AS x FROM rooms WHERE join_code = ? AND status <> 'ended' LIMIT 1`,
  );
  const listStmt = db.prepare(
    `${ROOM_SELECT}
     WHERE r.host_id = @uid
        OR EXISTS (SELECT 1 FROM room_participants p2 WHERE p2.room_id = r.id AND p2.user_id = @uid)
     ORDER BY r.created_at DESC
     LIMIT 100`,
  );
  const setStatusStmt = db.prepare(
    `UPDATE rooms SET status = ?,
       started_at = CASE WHEN ? = 'live' AND started_at IS NULL THEN ? ELSE started_at END,
       ended_at   = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END
     WHERE id = ?`,
  );
  const saveDocStmt = db.prepare('UPDATE rooms SET doc_json = ?, last_seq = ? WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM rooms');
  const countLiveStmt = db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE status = 'live'");

  return {
    async insert(r) {
      ins.run({
        id: r.id,
        title: r.title,
        hostId: r.hostId,
        joinCode: r.joinCode,
        status: r.status,
        docJson: r.docJson,
        lastSeq: r.lastSeq,
        createdAt: r.createdAt,
        courseId: r.courseId,
        lessonId: r.lessonId,
      });
    },
    async findById(id) {
      const row = byId.get(id) as DbRoomRow | undefined;
      return row ? toListRow(row) : null;
    },
    async findByCode(code) {
      const row = byCode.get(code) as DbRoomRow | undefined;
      return row ? toListRow(row) : null;
    },
    async codeTaken(code) {
      return codeTakenStmt.get(code) !== undefined;
    },
    async listForUser(userId) {
      const rows = listStmt.all({ uid: userId }) as unknown as DbRoomRow[];
      return rows.map(toListRow);
    },
    async setStatus(id, status, at) {
      setStatusStmt.run(status, status, at, status, at, id);
    },
    async saveDoc(id, docJson, lastSeq) {
      saveDocStmt.run(docJson, lastSeq, id);
    },
    async bindLesson(roomId, lessonId) {
      db.prepare('UPDATE rooms SET lesson_id = ? WHERE id = ?').run(lessonId, roomId);
    },
    async count() {
      const row = countStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async countLive() {
      const row = countLiveStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
  };
}
