-- 002_teaching_platform.sql — 角色扩展 + 课程/课节/作业/通知/课堂活动
-- 约定同 001：时间戳为 Unix 毫秒，布尔用 0/1，JSON 用 TEXT 存

PRAGMA defer_foreign_keys = ON;

-- ── 角色扩容：admin / teacher / assistant / student ──
-- SQLite 无法修改 CHECK，只能重建表。迁移器在事务外关闭了外键并在提交前
-- 执行 foreign_key_check，其他表按名字引用 users，重命名后会自动恢复。
CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'assistant', 'student')),
  password_hash TEXT NOT NULL,
  phone         TEXT,
  bio           TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
INSERT INTO users_new (id, email, display_name, role, password_hash, phone, bio, created_at)
SELECT id, email, display_name, role, password_hash, NULL, '', created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL AND phone <> '';

-- ── 课程 ──
CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  teacher_id  TEXT NOT NULL REFERENCES users(id),
  cover       TEXT NOT NULL DEFAULT '#3b82f6',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_teacher ON courses(teacher_id);

CREATE TABLE IF NOT EXISTS course_members (
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL CHECK (member_role IN ('student', 'assistant')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_course_members_user ON course_members(user_id);

-- ── 课节：一个课节绑定一间教室 ──
CREATE TABLE IF NOT EXISTS lessons (
  id           TEXT PRIMARY KEY,
  course_id    TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  starts_at    INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  status       TEXT NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled', 'ended', 'cancelled')),
  created_at   INTEGER NOT NULL,
  UNIQUE(room_id)
);
CREATE INDEX IF NOT EXISTS idx_lessons_course_time ON lessons(course_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_lessons_time ON lessons(starts_at);

ALTER TABLE rooms ADD COLUMN course_id TEXT;
ALTER TABLE rooms ADD COLUMN lesson_id TEXT;
CREATE INDEX IF NOT EXISTS idx_rooms_lesson ON rooms(lesson_id);

-- ── 课件库 ──
CREATE TABLE IF NOT EXISTS courseware (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL REFERENCES files(id),
  title      TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courseware_course ON courseware(course_id, created_at DESC);

-- ── 题库 ──
CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  course_id    TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by   TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'judge')),
  stem         TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  answer_json  TEXT NOT NULL DEFAULT '[]',
  analysis     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id, created_at DESC);

-- ── 作业 ──
CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id   TEXT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at      INTEGER NOT NULL,
  max_score   INTEGER NOT NULL DEFAULT 100,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assignment_submissions (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id),
  content       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted', 'graded')),
  score         INTEGER,
  feedback      TEXT NOT NULL DEFAULT '',
  submitted_at  INTEGER NOT NULL,
  graded_at     INTEGER,
  graded_by     TEXT REFERENCES users(id),
  UNIQUE(assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON assignment_submissions(student_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS submission_files (
  submission_id TEXT NOT NULL REFERENCES assignment_submissions(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES files(id),
  PRIMARY KEY (submission_id, file_id)
);

-- ── 通知 ──
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'system',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);

-- ── 课堂活动与签到 ──
CREATE TABLE IF NOT EXISTS room_activities (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id),
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_room ON room_activities(room_id, created_at);

CREATE TABLE IF NOT EXISTS room_signins (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

-- ── 文件扩展：课件与作业附件 ──
ALTER TABLE files ADD COLUMN course_id TEXT;
ALTER TABLE files ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_files_course ON files(course_id);

-- ── 私聊 ──
ALTER TABLE messages ADD COLUMN to_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(room_id, to_user_id, created_at);
