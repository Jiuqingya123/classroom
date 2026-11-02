import type {
  CourseDTO,
  CourseMemberDTO,
  CourseMemberRole,
  CoursewareDTO,
  LessonDTO,
  LessonStatus,
  QuestionDTO,
  QuestionOption,
  QuestionType,
  SignupRole,
} from '@classroom/shared';
import type { DB } from '../index';

/* ─────────────────────────── 课程 ─────────────────────────── */

interface DbCourseRow {
  id: string;
  title: string;
  subject: string;
  description: string;
  teacher_id: string;
  cover: string;
  archived: number;
  created_at: number;
  teacher_name: string;
  member_count: number;
  lesson_count: number;
  next_lesson_at: number | null;
  my_role: string | null;
}

function mapCourse(row: DbCourseRow, isAdmin: boolean): CourseDTO {
  const myRole = (isAdmin ? 'teacher' : row.my_role) as SignupRole | 'assistant';
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    description: row.description,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    cover: row.cover,
    archived: row.archived === 1,
    createdAt: row.created_at,
    myRole: myRole === 'assistant' ? 'assistant' : (myRole ?? 'student'),
    memberCount: row.member_count ?? 0,
    lessonCount: row.lesson_count ?? 0,
    nextLessonAt: row.next_lesson_at ?? null,
  };
}

const COURSE_SELECT = `
  SELECT c.*, u.display_name AS teacher_name,
    (SELECT COUNT(*) FROM course_members cm WHERE cm.course_id = c.id) AS member_count,
    (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.status <> 'cancelled') AS lesson_count,
    (SELECT MIN(l.starts_at) FROM lessons l
      WHERE l.course_id = c.id AND l.status = 'scheduled' AND l.starts_at >= ?) AS next_lesson_at,
    CASE WHEN c.teacher_id = ? THEN 'teacher'
      ELSE (SELECT cm.member_role FROM course_members cm
            WHERE cm.course_id = c.id AND cm.user_id = ?) END AS my_role
  FROM courses c JOIN users u ON u.id = c.teacher_id
`;

export interface CourseRepo {
  create(input: {
    id: string;
    title: string;
    subject: string;
    description: string;
    teacherId: string;
    cover: string;
    createdAt: number;
  }): Promise<void>;
  get(courseId: string, viewerId: string, isAdmin: boolean, now: number): Promise<CourseDTO | null>;
  listForUser(userId: string, isAdmin: boolean, now: number): Promise<CourseDTO[]>;
  listAll(now: number, limit?: number): Promise<CourseDTO[]>;
  update(courseId: string, patch: { title?: string; subject?: string; description?: string; cover?: string; archived?: boolean }): Promise<void>;
  remove(courseId: string): Promise<void>;
  isManager(courseId: string, userId: string, isAdmin: boolean): Promise<boolean>;
  isMember(courseId: string, userId: string): Promise<boolean>;
  canView(courseId: string, userId: string, isAdmin: boolean): Promise<boolean>;
  count(): Promise<number>;
  listMembers(courseId: string): Promise<CourseMemberDTO[]>;
  addMember(courseId: string, userId: string, role: CourseMemberRole): Promise<boolean>;
  removeMember(courseId: string, userId: string): Promise<void>;
  findUserByEmail(email: string): Promise<{ id: string; displayName: string; email: string; role: string } | null>;
}

export function createCourseRepo(db: DB): CourseRepo {
  const ins = db.prepare(
    `INSERT INTO courses (id, title, subject, description, teacher_id, cover, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const byIdStmt = db.prepare(`${COURSE_SELECT} WHERE c.id = ?`);
  const listStmt = db.prepare(
    `${COURSE_SELECT}
     WHERE c.teacher_id = ?
        OR EXISTS (SELECT 1 FROM course_members cm2 WHERE cm2.course_id = c.id AND cm2.user_id = ?)
     ORDER BY c.created_at DESC LIMIT 200`,
  );
  const managerStmt = db.prepare(
    `SELECT 1 AS x FROM courses c
     WHERE c.id = ?
       AND (c.teacher_id = ? OR EXISTS (
         SELECT 1 FROM course_members cm
         WHERE cm.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'assistant'))
     LIMIT 1`,
  );
  const memberStmt = db.prepare(
    'SELECT 1 AS x FROM course_members WHERE course_id = ? AND user_id = ? LIMIT 1',
  );
  const membersStmt = db.prepare(
    `SELECT u.id AS user_id, u.email, u.display_name, u.role, cm.member_role, cm.created_at
     FROM course_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.course_id = ? ORDER BY cm.created_at ASC`,
  );
  const addMemberStmt = db.prepare(
    `INSERT OR IGNORE INTO course_members (course_id, user_id, member_role, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const removeMemberStmt = db.prepare('DELETE FROM course_members WHERE course_id = ? AND user_id = ?');
  const userByEmailStmt = db.prepare(
    'SELECT id, display_name AS displayName, email, role FROM users WHERE email = ?',
  );

  return {
    async create(input) {
      ins.run(input.id, input.title, input.subject, input.description, input.teacherId, input.cover, input.createdAt);
    },
    async get(courseId, viewerId, isAdmin, now) {
      const row = byIdStmt.get(now, viewerId, viewerId, courseId) as DbCourseRow | undefined;
      if (!row) return null;
      if (!isAdmin && row.teacher_id !== viewerId && !row.my_role) return null;
      return mapCourse(row, isAdmin);
    },
    async listForUser(userId, isAdmin, now) {
      if (isAdmin) return this.listAll(now);
      // COURSE_SELECT 自带 3 个占位符（下次课时间、老师身份、成员身份），WHERE 再用 2 个
      const rows = listStmt.all(now, userId, userId, userId, userId) as unknown as DbCourseRow[];
      return rows.map((r) => mapCourse(r, false));
    },
    async listAll(now, limit = 200) {
      const rows = db.prepare(
        `${COURSE_SELECT} WHERE c.archived = 0 ORDER BY c.created_at DESC LIMIT ?`,
      ).all(now, '', '', Math.min(limit, 200)) as unknown as DbCourseRow[];
      return rows.map((r) => mapCourse(r, true));
    },
    async update(courseId, patch) {
      const sets: string[] = [];
      const values: Array<string | number> = [];
      if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
      if (patch.subject !== undefined) { sets.push('subject = ?'); values.push(patch.subject); }
      if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
      if (patch.cover !== undefined) { sets.push('cover = ?'); values.push(patch.cover); }
      if (patch.archived !== undefined) { sets.push('archived = ?'); values.push(patch.archived ? 1 : 0); }
      if (sets.length === 0) return;
      values.push(courseId);
      db.prepare(`UPDATE courses SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    },
    async remove(courseId) {
      db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
    },
    async isManager(courseId, userId, isAdmin) {
      if (isAdmin) return true;
      return managerStmt.get(courseId, userId, userId) !== undefined;
    },
    async isMember(courseId, userId) {
      return memberStmt.get(courseId, userId) !== undefined;
    },
    async canView(courseId, userId, isAdmin) {
      if (isAdmin) return true;
      if (await this.isManager(courseId, userId, false)) return true;
      return this.isMember(courseId, userId);
    },
    async count() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM courses').get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async listMembers(courseId) {
      const rows = membersStmt.all(courseId) as Array<{
        user_id: string; email: string; display_name: string; role: string; member_role: string; created_at: number;
      }>;
      return rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role as CourseMemberDTO['role'],
        memberRole: r.member_role as CourseMemberRole,
        joinedAt: r.created_at,
      }));
    },
    async addMember(courseId, userId, role) {
      return Number(addMemberStmt.run(courseId, userId, role, Date.now()).changes) > 0;
    },
    async removeMember(courseId, userId) {
      removeMemberStmt.run(courseId, userId);
    },
    async findUserByEmail(email) {
      const row = userByEmailStmt.get(email) as
        | { id: string; displayName: string; email: string; role: string }
        | undefined;
      return row ?? null;
    },
  };
}

/* ─────────────────────────── 课节 ─────────────────────────── */

export interface LessonRecord {
  id: string;
  courseId: string;
  courseTitle: string;
  title: string;
  startsAt: number;
  durationMin: number;
  roomId: string;
  joinCode: string;
  roomStatus: string;
  status: LessonStatus;
  hostName: string;
  attendanceCount: number;
  createdAt: number;
}

interface DbLessonRow {
  id: string;
  course_id: string;
  course_title: string;
  title: string;
  starts_at: number;
  duration_min: number;
  room_id: string;
  join_code: string;
  room_status: string;
  status: LessonStatus;
  host_name: string;
  attendance_count: number;
  created_at: number;
}

function mapLesson(r: DbLessonRow): LessonRecord {
  return {
    id: r.id,
    courseId: r.course_id,
    courseTitle: r.course_title,
    title: r.title,
    startsAt: r.starts_at,
    durationMin: r.duration_min,
    roomId: r.room_id,
    joinCode: r.join_code,
    roomStatus: r.room_status,
    status: r.status,
    hostName: r.host_name,
    attendanceCount: r.attendance_count ?? 0,
    createdAt: r.created_at,
  };
}

const LESSON_SELECT = `
  SELECT l.*, c.title AS course_title, u.display_name AS host_name, r.join_code, r.status AS room_status,
    (SELECT COUNT(DISTINCT p.user_id) FROM room_participants p WHERE p.room_id = l.room_id) AS attendance_count
  FROM lessons l
  JOIN courses c ON c.id = l.course_id
  JOIN users u ON u.id = c.teacher_id
  JOIN rooms r ON r.id = l.room_id
`;

export interface NewLessonInput {
  id: string;
  courseId: string;
  title: string;
  startsAt: number;
  durationMin: number;
  roomId: string;
  status: LessonStatus;
  createdAt: number;
}

export interface LessonPatch {
  title?: string;
  startsAt?: number;
  durationMin?: number;
  status?: LessonStatus;
}

export interface LessonRepo {
  insert(input: NewLessonInput): Promise<void>;
  /**
   * 在同一个 IMMEDIATE 事务里完成「冲突查询 + 插入」。
   * 返回 false 表示同一老师在该时段已有其他 scheduled 课节。
   */
  insertIfNoConflict(input: NewLessonInput, teacherId: string): Promise<boolean>;
  get(id: string): Promise<LessonRecord | null>;
  getByRoomId(roomId: string): Promise<LessonRecord | null>;
  listByCourse(courseId: string, limit?: number): Promise<LessonRecord[]>;
  listForUser(userId: string, isAdmin: boolean, from: number, limit?: number): Promise<LessonRecord[]>;
  listPastForUser(userId: string, isAdmin: boolean, before: number, limit?: number): Promise<LessonRecord[]>;
  update(id: string, patch: LessonPatch): Promise<void>;
  /**
   * 在同一个 IMMEDIATE 事务里完成「冲突查询 + 更新」。
   * patch 必须带最终的开课时间与时长；返回 false 表示冲突。
   */
  updateIfNoConflict(
    id: string,
    patch: LessonPatch & { startsAt: number; durationMin: number },
    teacherId: string,
  ): Promise<boolean>;
  markEndedByRoom(roomId: string): Promise<void>;
  /** 同一老师的时间段冲突（排除自己） */
  hasConflict(teacherId: string, startsAt: number, durationMin: number, excludeId?: string): Promise<boolean>;
  count(): Promise<number>;
}

export function createLessonRepo(db: DB): LessonRepo {
  const ins = db.prepare(
    `INSERT INTO lessons (id, course_id, title, starts_at, duration_min, room_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`${LESSON_SELECT} WHERE l.id = ?`);
  const byRoom = db.prepare(`${LESSON_SELECT} WHERE l.room_id = ?`);
  const byCourse = db.prepare(`${LESSON_SELECT} WHERE l.course_id = ? ORDER BY l.starts_at DESC LIMIT ?`);
  const forUser = db.prepare(
    `${LESSON_SELECT}
     WHERE l.starts_at >= ? AND l.status <> 'cancelled'
       AND (c.teacher_id = ? OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?))
     ORDER BY l.starts_at ASC LIMIT ?`,
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM lessons');
  const conflictStmt = db.prepare(
    `SELECT 1 AS x FROM lessons l JOIN courses c ON c.id = l.course_id
     WHERE c.teacher_id = ? AND l.status = 'scheduled' AND l.id <> ?
       AND l.starts_at < ? AND l.starts_at + l.duration_min * 60000 > ?
     LIMIT 1`,
  );

  function conflicts(
    teacherId: string,
    startsAt: number,
    durationMin: number,
    excludeId: string,
  ): boolean {
    const end = startsAt + durationMin * 60_000;
    return conflictStmt.get(teacherId, excludeId, end, startsAt) !== undefined;
  }

  function runInsert(input: NewLessonInput): void {
    ins.run(
      input.id, input.courseId, input.title, input.startsAt,
      input.durationMin, input.roomId, input.status, input.createdAt,
    );
  }

  function runUpdate(id: string, patch: LessonPatch): void {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
    if (patch.startsAt !== undefined) { sets.push('starts_at = ?'); values.push(patch.startsAt); }
    if (patch.durationMin !== undefined) { sets.push('duration_min = ?'); values.push(patch.durationMin); }
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (sets.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE lessons SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 只允许包同步 SQL：node:sqlite 是同步 API，事务内一旦 await 就会让出事件循环，
   * 其他请求的语句会混进同一事务。BEGIN IMMEDIATE 让「查冲突 + 写入」串行化。
   */
  function immediate<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      // SQLite 可能已自动回滚；此处失败不应掩盖原始错误
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no active transaction */
      }
      throw err;
    }
  }

  return {
    async insert(input) {
      runInsert(input);
    },
    async insertIfNoConflict(input, teacherId) {
      return immediate(() => {
        if (conflicts(teacherId, input.startsAt, input.durationMin, '')) return false;
        runInsert(input);
        return true;
      });
    },
    async get(id) {
      const row = byId.get(id) as DbLessonRow | undefined;
      return row ? mapLesson(row) : null;
    },
    async getByRoomId(roomId) {
      const row = byRoom.get(roomId) as DbLessonRow | undefined;
      return row ? mapLesson(row) : null;
    },
    async listByCourse(courseId, limit = 200) {
      const rows = byCourse.all(courseId, Math.min(limit, 200)) as unknown as DbLessonRow[];
      return rows.map(mapLesson);
    },
    async listForUser(userId, isAdmin, from, limit = 50) {
      if (isAdmin) {
        const rows = db.prepare(`${LESSON_SELECT} WHERE l.starts_at >= ? AND l.status <> 'cancelled' ORDER BY l.starts_at ASC LIMIT ?`)
          .all(from, Math.min(limit, 200)) as unknown as DbLessonRow[];
        return rows.map(mapLesson);
      }
      const rows = forUser.all(from, userId, userId, Math.min(limit, 200)) as unknown as DbLessonRow[];
      return rows.map(mapLesson);
    },
    async listPastForUser(userId, isAdmin, before, limit = 50) {
      const select = `${LESSON_SELECT} WHERE l.starts_at < ? AND l.status <> 'cancelled'`;
      const rows = isAdmin
        ? db.prepare(`${select} ORDER BY l.starts_at DESC LIMIT ?`).all(before, Math.min(limit, 200))
        : db.prepare(
            `${select}
             AND (c.teacher_id = ? OR EXISTS (
               SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?))
             ORDER BY l.starts_at DESC LIMIT ?`,
          ).all(before, userId, userId, Math.min(limit, 200));
      return (rows as unknown as DbLessonRow[]).map(mapLesson);
    },
    async update(id, patch) {
      runUpdate(id, patch);
    },
    async updateIfNoConflict(id, patch, teacherId) {
      return immediate(() => {
        if (conflicts(teacherId, patch.startsAt, patch.durationMin, id)) return false;
        runUpdate(id, patch);
        return true;
      });
    },
    async markEndedByRoom(roomId) {
      db.prepare("UPDATE lessons SET status = 'ended' WHERE room_id = ? AND status <> 'cancelled'").run(roomId);
    },
    async hasConflict(teacherId, startsAt, durationMin, excludeId = '') {
      return conflicts(teacherId, startsAt, durationMin, excludeId);
    },
    async count() {
      const row = countStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
  };
}

/* ─────────────────────────── 课件 ─────────────────────────── */

export interface CoursewareRecord {
  id: string;
  courseId: string;
  fileId: string;
  title: string;
  mime: string;
  size: number;
  createdBy: string;
  createdAt: number;
}

export interface CoursewareRepo {
  insert(input: CoursewareRecord): Promise<void>;
  listByCourse(courseId: string): Promise<CoursewareRecord[]>;
  get(id: string): Promise<CoursewareRecord | null>;
  remove(id: string): Promise<void>;
  hasFile(fileId: string): Promise<boolean>;
}

export function createCoursewareRepo(db: DB): CoursewareRepo {
  const ins = db.prepare(
    `INSERT INTO courseware (id, course_id, file_id, title, mime, size, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listStmt = db.prepare(
    `SELECT id, course_id AS courseId, file_id AS fileId, title, mime, size,
            created_by AS createdBy, created_at AS createdAt
     FROM courseware WHERE course_id = ? ORDER BY created_at DESC`,
  );
  const byId = db.prepare(
    `SELECT id, course_id AS courseId, file_id AS fileId, title, mime, size,
            created_by AS createdBy, created_at AS createdAt
     FROM courseware WHERE id = ?`,
  );
  return {
    async insert(input) {
      ins.run(input.id, input.courseId, input.fileId, input.title, input.mime, input.size, input.createdBy, input.createdAt);
    },
    async listByCourse(courseId) {
      return listStmt.all(courseId) as unknown as CoursewareRecord[];
    },
    async get(id) {
      return (byId.get(id) as CoursewareRecord | undefined) ?? null;
    },
    async remove(id) {
      db.prepare('DELETE FROM courseware WHERE id = ?').run(id);
    },
    async hasFile(fileId) {
      return db.prepare('SELECT 1 AS x FROM courseware WHERE file_id = ? LIMIT 1').get(fileId) !== undefined;
    },
  };
}

/* ─────────────────────────── 题库 ─────────────────────────── */

interface DbQuestionRow {
  id: string;
  course_id: string;
  type: QuestionType;
  stem: string;
  options_json: string;
  answer_json: string;
  analysis: string;
  created_at: number;
}

function mapQuestion(r: DbQuestionRow): QuestionDTO {
  let options: QuestionOption[] = [];
  let answer: string[] = [];
  try { options = JSON.parse(r.options_json) as QuestionOption[]; } catch { options = []; }
  try { answer = JSON.parse(r.answer_json) as string[]; } catch { answer = []; }
  return {
    id: r.id,
    courseId: r.course_id,
    type: r.type,
    stem: r.stem,
    options,
    answer,
    analysis: r.analysis,
    createdAt: r.created_at,
  };
}

export interface QuestionRepo {
  insert(input: {
    id: string; courseId: string; createdBy: string; type: QuestionType; stem: string;
    options: QuestionOption[]; answer: string[]; analysis: string; createdAt: number;
  }): Promise<void>;
  listByCourse(courseId: string): Promise<QuestionDTO[]>;
  get(id: string): Promise<QuestionDTO | null>;
  remove(id: string): Promise<void>;
}

export function createQuestionRepo(db: DB): QuestionRepo {
  const ins = db.prepare(
    `INSERT INTO questions (id, course_id, created_by, type, stem, options_json, answer_json, analysis, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listStmt = db.prepare('SELECT * FROM questions WHERE course_id = ? ORDER BY created_at DESC');
  const byId = db.prepare('SELECT * FROM questions WHERE id = ?');
  return {
    async insert(input) {
      ins.run(
        input.id, input.courseId, input.createdBy, input.type, input.stem,
        JSON.stringify(input.options), JSON.stringify(input.answer), input.analysis, input.createdAt,
      );
    },
    async listByCourse(courseId) {
      return (listStmt.all(courseId) as unknown as DbQuestionRow[]).map(mapQuestion);
    },
    async get(id) {
      const row = byId.get(id) as DbQuestionRow | undefined;
      return row ? mapQuestion(row) : null;
    },
    async remove(id) {
      db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    },
  };
}

export function lessonToDTO(
  l: LessonRecord,
  opts: { now: number; canSeeCode: boolean; isManager: boolean },
): LessonDTO {
  const enterAt = l.startsAt - 15 * 60 * 1000;
  const status: LessonStatus =
    l.status === 'cancelled' || l.status === 'ended'
      ? l.status
      : l.roomStatus === 'live'
        ? 'live'
        : l.status;
  // 与服务端 POST /lessons/:id/enter 的校验保持一致：课节取消/结束，
  // 或教室本身已结束（即使课节又被改回 scheduled），都不能再进。
  const closed = status === 'cancelled' || status === 'ended' || l.roomStatus === 'ended';
  return {
    id: l.id,
    courseId: l.courseId,
    courseTitle: l.courseTitle,
    title: l.title,
    startsAt: l.startsAt,
    durationMin: l.durationMin,
    roomId: l.roomId,
    joinCode: opts.canSeeCode ? l.joinCode : null,
    status,
    enterInMs: Math.max(0, enterAt - opts.now),
    canEnter: !closed && (opts.isManager || opts.now >= enterAt),
    hostName: l.hostName,
    attendanceCount: l.attendanceCount,
  };
}
