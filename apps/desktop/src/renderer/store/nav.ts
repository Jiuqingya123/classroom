import { create } from 'zustand';

export type View =
  | 'dashboard'
  | 'lobby'
  | 'courses'
  | 'course'
  | 'schedule'
  | 'assignments'
  | 'notifications'
  | 'admin'
  | 'profile'
  | 'room';

interface NavState {
  view: View;
  roomId: string | null;
  /** 学生进房需要 6 位码；房主/曾加入过的学生可为 null */
  code: string | null;
  courseId: string | null;
  assignmentId: string | null;
  go(view: Exclude<View, 'room'>): void;
  goCourse(courseId: string): void;
  goAssignment(assignmentId: string): void;
  goLobby(): void;
  goRoom(roomId: string, code?: string | null): void;
}

export const useNav = create<NavState>((set) => ({
  view: 'dashboard',
  roomId: null,
  code: null,
  courseId: null,
  assignmentId: null,
  // 普通导航不带具体作业；否则删掉作业后仍会去加载已不存在的 id
  go: (view) => set({ view, assignmentId: null }),
  goCourse: (courseId) => set({ view: 'course', courseId }),
  goAssignment: (assignmentId) => set({ view: 'assignments', assignmentId }),
  goLobby: () => set({ view: 'lobby', roomId: null, code: null }),
  goRoom: (roomId, code = null) => set({ view: 'room', roomId, code }),
}));
