import type { DB } from '../index';
import { createActivityRepo, type ActivityRepo } from './activities';
import {
  createCourseRepo,
  createCoursewareRepo,
  createLessonRepo,
  createQuestionRepo,
  type CourseRepo,
  type CoursewareRepo,
  type LessonRepo,
  type QuestionRepo,
} from './courses';
import { createFileRepo, type FileRepo } from './files';
import { createHomeworkRepo, type HomeworkRepo } from './homework';
import { createLcicRepo, type LcicRepo } from './lcic';
import { createMessageRepo, type MessageRepo } from './messages';
import { createNotificationRepo, type NotificationRepo } from './notifications';
import { createParticipantRepo, type ParticipantRepo } from './participants';
import { createRoomRepo, type RoomRepo } from './rooms';
import { createTokenRepo, type TokenRepo } from './tokens';
import { createUserRepo, type UserRepo } from './users';

export interface Repos {
  users: UserRepo;
  rooms: RoomRepo;
  participants: ParticipantRepo;
  messages: MessageRepo;
  tokens: TokenRepo;
  files: FileRepo;
  courses: CourseRepo;
  lessons: LessonRepo;
  courseware: CoursewareRepo;
  questions: QuestionRepo;
  homework: HomeworkRepo;
  notifications: NotificationRepo;
  activities: ActivityRepo;
  lcic: LcicRepo;
}

/**
 * 所有 repo 方法都返回 Promise —— 即使 better-sqlite3 是同步 API。
 * 这是将来换 Postgres 时唯一无法机械替换的差异点，提前抹平。
 */
export function createRepos(db: DB): Repos {
  return {
    users: createUserRepo(db),
    rooms: createRoomRepo(db),
    participants: createParticipantRepo(db),
    messages: createMessageRepo(db),
    tokens: createTokenRepo(db),
    files: createFileRepo(db),
    courses: createCourseRepo(db),
    lessons: createLessonRepo(db),
    courseware: createCoursewareRepo(db),
    questions: createQuestionRepo(db),
    homework: createHomeworkRepo(db),
    notifications: createNotificationRepo(db),
    activities: createActivityRepo(db),
    lcic: createLcicRepo(db),
  };
}

export type {
  ActivityRepo,
  CourseRepo,
  CoursewareRepo,
  FileRepo,
  HomeworkRepo,
  LcicRepo,
  LessonRepo,
  MessageRepo,
  NotificationRepo,
  ParticipantRepo,
  QuestionRepo,
  RoomRepo,
  TokenRepo,
  UserRepo,
};
