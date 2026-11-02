-- 001_init.sql — 首版表结构
-- 约定：所有时间戳为 Unix 毫秒（INTEGER），布尔用 0/1，JSON 用 TEXT 存

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  host_id    TEXT NOT NULL REFERENCES users(id),
  join_code  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'live', 'ended')),
  -- 白板权威快照：{ pages: PageMeta[], elements: WhiteboardElement[], seq: number }
  doc_json   TEXT NOT NULL DEFAULT '{}',
  last_seq   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at   INTEGER
);
-- 同一入会码在「未结束」的房间中唯一；结束后可回收复用
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_code_active ON rooms(join_code) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS idx_rooms_host ON rooms(host_id);

CREATE TABLE IF NOT EXISTS room_pages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  name       TEXT NOT NULL,
  bg_file_id TEXT,
  width      REAL NOT NULL,
  height     REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_room ON room_pages(room_id, idx);

CREATE TABLE IF NOT EXISTS room_participants (
  id        TEXT PRIMARY KEY,
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_part_room ON room_participants(room_id);
CREATE INDEX IF NOT EXISTS idx_part_user ON room_participants(room_id, user_id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id),
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  room_id    TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_room ON files(room_id);

CREATE TABLE IF NOT EXISTS wb_snapshots (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  doc_json   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_room ON wb_snapshots(room_id, created_at DESC);
