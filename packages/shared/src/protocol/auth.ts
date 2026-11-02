/** 账号与鉴权协议。 */

/**
 * admin      机构管理员：管理账号、课程与全局数据
 * teacher    授课老师：创建课程/课节、主持课堂
 * assistant  助教：协助管理课堂，可执行课堂管控
 * student    学生：加入课程、进入课堂
 */
export type Role = 'admin' | 'teacher' | 'assistant' | 'student';

/** 允许自助注册的角色；admin / assistant 只能由管理员分配 */
export type SignupRole = 'teacher' | 'student';

export const STAFF_ROLES: readonly Role[] = ['admin', 'teacher', 'assistant'];

export function isStaff(role: Role | null | undefined): boolean {
  return role === 'admin' || role === 'teacher' || role === 'assistant';
}

export function isAdmin(role: Role | null | undefined): boolean {
  return role === 'admin';
}

/** 可以管理白板页、锁定、结束课堂等教学动作 */
export function canTeach(role: Role | null | undefined): boolean {
  return role === 'teacher' || role === 'assistant' || role === 'admin';
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  teacher: '老师',
  assistant: '助教',
  student: '学生',
};

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  phone: string | null;
  bio: string;
  createdAt: number;
}

export interface AuthTokens {
  /** 15 分钟，仅存渲染进程内存，用于 REST 调用 */
  accessToken: string;
  /** 2 小时，socket 握手专用 —— 避免 20 分钟课堂中途 token 过期导致重连 */
  rtcToken: string;
  /** 7 天，单次使用即轮换，落 Electron safeStorage */
  refreshToken: string;
  accessExpiresIn: number;
  rtcExpiresIn: number;
}

export interface AuthResult {
  user: UserDTO;
  tokens: AuthTokens;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  role: SignupRole;
}

export interface LoginInput {
  /** 邮箱或手机号 */
  email: string;
  password: string;
}

export interface UpdateProfileInput {
  displayName?: string;
  phone?: string;
  bio?: string;
}

export interface ChangePasswordInput {
  oldPassword: string;
  newPassword: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
