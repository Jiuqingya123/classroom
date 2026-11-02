import type { CourseDTO, LessonDTO, Role } from '@classroom/shared';
import type { Repos } from '../db/repos';
import { lessonToDTO } from '../db/repos/courses';
import { AppError } from './errors';

export interface Viewer {
  id: string;
  role: Role;
}

export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === 'admin';
}

export async function loadCourseOrThrow(
  repos: Repos,
  courseId: string,
  viewer: Viewer,
): Promise<CourseDTO> {
  const course = await repos.courses.get(courseId, viewer.id, isAdmin(viewer), Date.now());
  if (!course) throw AppError.notFound('课程不存在或你没有访问权限');
  return course;
}

export async function requireCourseManager(
  repos: Repos,
  courseId: string,
  viewer: Viewer,
): Promise<CourseDTO> {
  const course = await loadCourseOrThrow(repos, courseId, viewer);
  if (!(await repos.courses.isManager(courseId, viewer.id, isAdmin(viewer)))) {
    throw AppError.forbidden('只有课程老师或助教可以执行此操作');
  }
  return course;
}

export async function lessonDTOFor(
  repos: Repos,
  lesson: Parameters<typeof lessonToDTO>[0],
  viewer: Viewer,
  manager: boolean,
): Promise<LessonDTO> {
  const canSeeCode = manager || viewer.role === 'admin';
  return lessonToDTO(lesson, {
    now: Date.now(),
    canSeeCode,
    isManager: manager,
  });
}

/** 课程学生名单（不含老师），用于通知与考勤 */
export async function studentIdsOf(repos: Repos, courseId: string): Promise<string[]> {
  const members = await repos.courses.listMembers(courseId);
  return members.filter((m) => m.memberRole === 'student').map((m) => m.userId);
}
