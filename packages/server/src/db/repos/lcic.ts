import type { DB } from '../index';

export interface LcicUserBinding {
  userId: string;
  lcicUserId: string;
  originId: string;
  token: string;
  tokenExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

interface LcicUserRow {
  user_id: string;
  lcic_user_id: string;
  origin_id: string;
  token: string;
  token_expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface LcicRoomBinding {
  courseId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  createdAt: number;
  updatedAt: number;
}

interface LcicRoomRow {
  course_id: string;
  room_id: string;
  starts_at: number;
  ends_at: number;
  created_at: number;
  updated_at: number;
}

function mapUser(row: LcicUserRow): LcicUserBinding {
  return {
    userId: row.user_id,
    lcicUserId: row.lcic_user_id,
    originId: row.origin_id,
    token: row.token,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoom(row: LcicRoomRow): LcicRoomBinding {
  return {
    courseId: row.course_id,
    roomId: row.room_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LcicRepo {
  findUser(userId: string): Promise<LcicUserBinding | null>;
  upsertUser(binding: LcicUserBinding): Promise<void>;
  findRoom(courseId: string): Promise<LcicRoomBinding | null>;
  upsertRoom(binding: LcicRoomBinding): Promise<void>;
}

export function createLcicRepo(db: DB): LcicRepo {
  const getUser = db.prepare('SELECT * FROM lcic_users WHERE user_id = ?');
  const putUser = db.prepare(
    `INSERT INTO lcic_users
       (user_id, lcic_user_id, origin_id, token, token_expires_at, created_at, updated_at)
     VALUES
       (@userId, @lcicUserId, @originId, @token, @tokenExpiresAt, @createdAt, @updatedAt)
     ON CONFLICT(user_id) DO UPDATE SET
       lcic_user_id     = excluded.lcic_user_id,
       origin_id        = excluded.origin_id,
       token            = excluded.token,
       token_expires_at = excluded.token_expires_at,
       updated_at       = excluded.updated_at`,
  );
  const getRoom = db.prepare('SELECT * FROM lcic_rooms WHERE course_id = ?');
  const putRoom = db.prepare(
    `INSERT INTO lcic_rooms
       (course_id, room_id, starts_at, ends_at, created_at, updated_at)
     VALUES
       (@courseId, @roomId, @startsAt, @endsAt, @createdAt, @updatedAt)
     ON CONFLICT(course_id) DO UPDATE SET
       room_id    = excluded.room_id,
       starts_at  = excluded.starts_at,
       ends_at    = excluded.ends_at,
       updated_at = excluded.updated_at`,
  );

  return {
    async findUser(userId) {
      const row = getUser.get(userId) as LcicUserRow | undefined;
      return row ? mapUser(row) : null;
    },
    async upsertUser(binding) {
      putUser.run({
        userId: binding.userId,
        lcicUserId: binding.lcicUserId,
        originId: binding.originId,
        token: binding.token,
        tokenExpiresAt: binding.tokenExpiresAt,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    },
    async findRoom(courseId) {
      const row = getRoom.get(courseId) as LcicRoomRow | undefined;
      return row ? mapRoom(row) : null;
    },
    async upsertRoom(binding) {
      putRoom.run({
        courseId: binding.courseId,
        roomId: binding.roomId,
        startsAt: binding.startsAt,
        endsAt: binding.endsAt,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    },
  };
}
