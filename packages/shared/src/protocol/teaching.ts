import type { Role, SignupRole } from './auth';

/* ─────────────────────────── 课程与课节 ─────────────────────────── */

export type CourseMemberRole = 'student' | 'assistant';
export type LessonStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';

export interface CourseDTO {
  id: string;
  title: string;
  subject: string;
  description: string;
  teacherId: string;
  teacherName: string;
  cover: string;
  archived: boolean;
  createdAt: number;
  /** 当前用户在课程中的身份 */
  myRole: SignupRole | 'assistant';
  memberCount: number;
  lessonCount: number;
  nextLessonAt: number | null;
}

export interface CourseMemberDTO {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  memberRole: 'teacher' | CourseMemberRole;
  joinedAt: number;
}

export interface LessonDTO {
  id: string;
  courseId: string;
  courseTitle: string;
  title: string;
  startsAt: number;
  durationMin: number;
  roomId: string;
  joinCode: string | null;
  status: LessonStatus;
  /** 距离可进入教室的时间（毫秒）；<= 0 表示现在可进 */
  enterInMs: number;
  canEnter: boolean;
  hostName: string;
  attendanceCount: number;
}

export interface CoursewareDTO {
  id: string;
  courseId: string;
  fileId: string;
  title: string;
  mime: string;
  size: number;
  createdAt: number;
  /** 签名下载地址；列表接口按需签发 */
  url?: string;
  expiresAt?: number;
}

export type QuestionType = 'single' | 'multiple' | 'judge';

export interface QuestionOption {
  key: string;
  text: string;
}

export interface QuestionDTO {
  id: string;
  courseId: string;
  type: QuestionType;
  stem: string;
  options: QuestionOption[];
  answer: string[];
  analysis: string;
  createdAt: number;
}

export interface CourseDetailDTO {
  course: CourseDTO;
  members: CourseMemberDTO[];
  lessons: LessonDTO[];
  courseware: CoursewareDTO[];
  questions: QuestionDTO[];
}

export interface CreateCourseInput {
  title: string;
  subject?: string;
  description?: string;
  cover?: string;
}

export interface CreateLessonInput {
  title?: string;
  startsAt: number;
  durationMin?: number;
}

export interface AddCourseMembersInput {
  emails: string[];
  role?: CourseMemberRole;
}

export interface CreateQuestionInput {
  type: QuestionType;
  stem: string;
  options?: QuestionOption[];
  answer: string[];
  analysis?: string;
}

/* ─────────────────────────── 作业 ─────────────────────────── */

export interface SubmissionDTO {
  id: string;
  assignmentId: string;
  studentId: string;
  studentName: string;
  content: string;
  fileIds: string[];
  status: 'submitted' | 'graded';
  score: number | null;
  feedback: string;
  submittedAt: number;
  gradedAt: number | null;
}

export interface AssignmentDTO {
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
  /** 学生视角：自己的提交 */
  mySubmission: SubmissionDTO | null;
  /** 老师视角：提交人数与已批改数 */
  submissionCount: number;
  gradedCount: number;
}

export interface CreateAssignmentInput {
  title: string;
  description?: string;
  dueAt: number;
  lessonId?: string;
  maxScore?: number;
}

export interface SubmitAssignmentInput {
  content?: string;
  fileIds?: string[];
}

export interface GradeSubmissionInput {
  score: number;
  feedback?: string;
}

/* ─────────────────────────── 通知 ─────────────────────────── */

export type NotificationKind =
  | 'lesson'
  | 'course'
  | 'assignment'
  | 'grade'
  | 'classroom'
  | 'system';

export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** 前端路由提示，例如 course:<id> / assignment:<id> / room:<id> */
  link: string;
  readAt: number | null;
  createdAt: number;
}

/* ─────────────────────────── 腾讯课堂并列入口 ─────────────────────────── */

export interface LcicStatusDTO {
  enabled: boolean;
  sdkAppId: string | null;
}

export interface LcicLaunchDTO {
  provider: 'lcic';
  /** 一次性进入地址，含短期 token，不要缓存或落库 */
  url: string;
  roomId: string;
  userId: string;
  /** url 的失效时间（毫秒时间戳）；取 token 与房间的较早者 */
  expiresAt: number;
}

/* ─────────────────────────── 管理后台 ─────────────────────────── */

export interface AdminStatsDTO {
  users: number;
  admins: number;
  teachers: number;
  assistants: number;
  students: number;
  courses: number;
  lessons: number;
  rooms: number;
  liveRooms: number;
  assignments: number;
  messages: number;
}

export interface AdminOverviewDTO {
  stats: AdminStatsDTO;
  recentUsers: Array<{
    id: string;
    email: string;
    displayName: string;
    role: Role;
    createdAt: number;
  }>;
  recentCourses: CourseDTO[];
}

export interface AdminUserDTO {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  phone: string | null;
  createdAt: number;
  courseCount: number;
}
