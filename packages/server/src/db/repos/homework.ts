import type { DB } from '../index';

export interface AssignmentRecord {
  id: string;
  courseId: string;
  courseTitle: string;
  lessonId: string | null;
  title: string;
  description: string;
  dueAt: number;
  maxScore: number;
  createdBy: string;
  teacherName: string;
  createdAt: number;
}

export interface SubmissionRecord {
  id: string;
  assignmentId: string;
  studentId: string;
  studentName: string;
  content: string;
  status: 'submitted' | 'graded';
  score: number | null;
  feedback: string;
  submittedAt: number;
  gradedAt: number | null;
  gradedBy: string | null;
}

interface DbAssignmentRow {
  id: string;
  course_id: string;
  course_title: string;
  lesson_id: string | null;
  title: string;
  description: string;
  due_at: number;
  max_score: number;
  created_by: string;
  teacher_name: string;
  created_at: number;
  submission_count?: number;
  graded_count?: number;
}

interface DbSubmissionRow {
  id: string;
  assignment_id: string;
  student_id: string;
  student_name: string;
  content: string;
  status: 'submitted' | 'graded';
  score: number | null;
  feedback: string;
  submitted_at: number;
  graded_at: number | null;
  graded_by: string | null;
}

function mapAssignment(r: DbAssignmentRow): AssignmentRecord {
  return {
    id: r.id,
    courseId: r.course_id,
    courseTitle: r.course_title,
    lessonId: r.lesson_id,
    title: r.title,
    description: r.description,
    dueAt: r.due_at,
    maxScore: r.max_score,
    createdBy: r.created_by,
    teacherName: r.teacher_name,
    createdAt: r.created_at,
  };
}

function mapSubmission(r: DbSubmissionRow): SubmissionRecord {
  return {
    id: r.id,
    assignmentId: r.assignment_id,
    studentId: r.student_id,
    studentName: r.student_name,
    content: r.content,
    status: r.status,
    score: r.score,
    feedback: r.feedback,
    submittedAt: r.submitted_at,
    gradedAt: r.graded_at,
    gradedBy: r.graded_by,
  };
}

const ASSIGNMENT_SELECT = `
  SELECT a.*, c.title AS course_title, u.display_name AS teacher_name,
    (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id) AS submission_count,
    (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.status = 'graded') AS graded_count
  FROM assignments a
  JOIN courses c ON c.id = a.course_id
  JOIN users u ON u.id = a.created_by
`;

export interface HomeworkRepo {
  insertAssignment(input: {
    id: string; courseId: string; lessonId: string | null; title: string; description: string;
    dueAt: number; maxScore: number; createdBy: string; createdAt: number;
  }): Promise<void>;
  getAssignment(id: string): Promise<{ assignment: AssignmentRecord; submissionCount: number; gradedCount: number } | null>;
  listByCourse(courseId: string): Promise<AssignmentRecord[]>;
  listForUser(userId: string, isAdmin: boolean): Promise<AssignmentRecord[]>;
  removeAssignment(id: string): Promise<void>;
  count(): Promise<number>;

  getSubmission(assignmentId: string, studentId: string): Promise<SubmissionRecord | null>;
  getSubmissionById(id: string): Promise<SubmissionRecord | null>;
  listSubmissions(assignmentId: string): Promise<SubmissionRecord[]>;
  upsertSubmission(input: {
    id: string; assignmentId: string; studentId: string; content: string; submittedAt: number; fileIds: string[];
  }): Promise<void>;
  gradeSubmission(id: string, score: number, feedback: string, gradedBy: string, at: number): Promise<void>;
  fileIdsForSubmission(submissionId: string): Promise<string[]>;
  isSubmissionFile(fileId: string): Promise<boolean>;
}

export function createHomeworkRepo(db: DB): HomeworkRepo {
  const insAssignment = db.prepare(
    `INSERT INTO assignments (id, course_id, lesson_id, title, description, due_at, max_score, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const assignmentById = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`);
  const assignmentsByCourse = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.course_id = ? ORDER BY a.created_at DESC`);
  const assignmentsForUser = db.prepare(
    `${ASSIGNMENT_SELECT}
     WHERE c.teacher_id = ? OR EXISTS (
       SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?)
     ORDER BY a.due_at DESC LIMIT 300`,
  );
  const assignmentsAll = db.prepare(`${ASSIGNMENT_SELECT} ORDER BY a.created_at DESC LIMIT 300`);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM assignments');

  const submissionByStudent = db.prepare(
    `SELECT s.*, u.display_name AS student_name
     FROM assignment_submissions s JOIN users u ON u.id = s.student_id
     WHERE s.assignment_id = ? AND s.student_id = ?`,
  );
  const submissionById = db.prepare(
    `SELECT s.*, u.display_name AS student_name
     FROM assignment_submissions s JOIN users u ON u.id = s.student_id
     WHERE s.id = ?`,
  );
  const submissionsByAssignment = db.prepare(
    `SELECT s.*, u.display_name AS student_name
     FROM assignment_submissions s JOIN users u ON u.id = s.student_id
     WHERE s.assignment_id = ? ORDER BY s.submitted_at ASC`,
  );
  // 冲突时只更新「提交内容」本身：status / score / feedback / graded_at / graded_by
  // 是批改结果，重交（即使路由层漏判）也不能被重置。新行才写默认的未批改字段。
  const upsertSubmissionStmt = db.prepare(
    `INSERT INTO assignment_submissions
       (id, assignment_id, student_id, content, status, score, feedback, submitted_at, graded_at, graded_by)
     VALUES (?, ?, ?, ?, 'submitted', NULL, '', ?, NULL, NULL)
     ON CONFLICT(assignment_id, student_id) DO UPDATE SET
       content = excluded.content,
       submitted_at = excluded.submitted_at`,
  );
  const filesForSubmissionStmt = db.prepare(
    'SELECT file_id AS fileId FROM submission_files WHERE submission_id = ?',
  );

  return {
    async insertAssignment(input) {
      insAssignment.run(
        input.id, input.courseId, input.lessonId, input.title, input.description,
        input.dueAt, input.maxScore, input.createdBy, input.createdAt,
      );
    },
    async getAssignment(id) {
      const row = assignmentById.get(id) as DbAssignmentRow | undefined;
      if (!row) return null;
      return {
        assignment: mapAssignment(row),
        submissionCount: row.submission_count ?? 0,
        gradedCount: row.graded_count ?? 0,
      };
    },
    async listByCourse(courseId) {
      return (assignmentsByCourse.all(courseId) as unknown as DbAssignmentRow[]).map(mapAssignment);
    },
    async listForUser(userId, isAdmin) {
      const rows = isAdmin
        ? assignmentsAll.all()
        : assignmentsForUser.all(userId, userId);
      return (rows as unknown as DbAssignmentRow[]).map(mapAssignment);
    },
    async removeAssignment(id) {
      db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
    },
    async count() {
      const row = countStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async getSubmission(assignmentId, studentId) {
      const row = submissionByStudent.get(assignmentId, studentId) as DbSubmissionRow | undefined;
      return row ? mapSubmission(row) : null;
    },
    async getSubmissionById(id) {
      const row = submissionById.get(id) as DbSubmissionRow | undefined;
      return row ? mapSubmission(row) : null;
    },
    async listSubmissions(assignmentId) {
      return (submissionsByAssignment.all(assignmentId) as unknown as DbSubmissionRow[]).map(mapSubmission);
    },
    async upsertSubmission(input) {
      db.exec('BEGIN');
      try {
        upsertSubmissionStmt.run(
          input.id, input.assignmentId, input.studentId, input.content, input.submittedAt,
        );
        const row = submissionByStudent.get(input.assignmentId, input.studentId) as
          | { id: string } | undefined;
        if (!row) throw new Error('submission_not_found');
        db.prepare('DELETE FROM submission_files WHERE submission_id = ?').run(row.id);
        const insFile = db.prepare('INSERT OR IGNORE INTO submission_files (submission_id, file_id) VALUES (?, ?)');
        for (const fileId of input.fileIds) insFile.run(row.id, fileId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async gradeSubmission(id, score, feedback, gradedBy, at) {
      db.prepare(
        `UPDATE assignment_submissions
         SET status = 'graded', score = ?, feedback = ?, graded_at = ?, graded_by = ?
         WHERE id = ?`,
      ).run(score, feedback, at, gradedBy, id);
    },
    async fileIdsForSubmission(submissionId) {
      const rows = filesForSubmissionStmt.all(submissionId) as Array<{ fileId: string }>;
      return rows.map((r) => r.fileId);
    },
    async isSubmissionFile(fileId) {
      return db.prepare('SELECT 1 AS x FROM submission_files WHERE file_id = ? LIMIT 1').get(fileId) !== undefined;
    },
  };
}
