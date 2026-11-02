-- 003_lcic.sql — 腾讯云实时互动-教育版（LCIC）并列入口
-- 只存映射与短期凭据；课堂内容（音视频/白板/聊天）都在腾讯侧，不落本地。

CREATE TABLE IF NOT EXISTS lcic_users (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lcic_user_id     TEXT NOT NULL UNIQUE,
  origin_id        TEXT NOT NULL,
  token            TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lcic_users_origin ON lcic_users(origin_id);

CREATE TABLE IF NOT EXISTS lcic_rooms (
  course_id  TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lcic_rooms_room ON lcic_rooms(room_id);
