import type { DB } from '../index';

export interface FileRow {
  id: string;
  ownerId: string;
  roomId: string | null;
  courseId: string | null;
  purpose: string;
  mime: string;
  size: number;
  path: string;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface NewFile {
  /** 由调用方生成：落盘路径要用到它，必须先于写库确定 */
  id: string;
  ownerId: string;
  roomId: string | null;
  courseId: string | null;
  purpose: string;
  mime: string;
  size: number;
  path: string;
  width: number | null;
  height: number | null;
  at: number;
}

export interface FileRepo {
  create(input: NewFile): Promise<void>;
  getById(id: string): Promise<FileRow | null>;
  /** 统计某房间已占用字节数，用于配额 */
  totalBytesForRoom(roomId: string): Promise<number>;
}

export function createFileRepo(db: DB): FileRepo {
  const ins = db.prepare(
    `INSERT INTO files (id, owner_id, room_id, course_id, purpose, mime, size, path, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare(
    `SELECT id, owner_id AS ownerId, room_id AS roomId, course_id AS courseId,
            purpose, mime, size, path, width, height, created_at AS createdAt
     FROM files WHERE id = ?`,
  );
  const totalStmt = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE room_id = ?');

  return {
    async create(input) {
      ins.run(
        input.id,
        input.ownerId,
        input.roomId,
        input.courseId,
        input.purpose,
        input.mime,
        input.size,
        input.path,
        input.width,
        input.height,
        input.at,
      );
    },
    async getById(id) {
      return (get.get(id) as FileRow | undefined) ?? null;
    },
    async totalBytesForRoom(roomId) {
      const row = totalStmt.get(roomId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
  };
}
