import type { Role, UserDTO } from '@classroom/shared';
import type { DB } from '../index';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  phone: string | null;
  bio: string;
  createdAt: number;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  password_hash: string;
  phone: string | null;
  bio: string;
  created_at: number;
}

function map(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    passwordHash: row.password_hash,
    phone: row.phone,
    bio: row.bio,
    createdAt: row.created_at,
  };
}

export function toUserDTO(u: UserRecord): UserDTO {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    phone: u.phone,
    bio: u.bio,
    createdAt: u.createdAt,
  };
}

export interface UpdateUserProfile {
  displayName?: string;
  phone?: string | null;
  bio?: string;
}

export interface UserListFilter {
  search?: string;
  role?: Role;
}

/** 列表与计数共用同一套筛选条件，避免总数和分页对不上 */
function buildUserFilter(opts: UserListFilter): { where: string; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.search) {
    where.push('(email LIKE ? OR display_name LIKE ? OR phone LIKE ?)');
    const q = `%${opts.search}%`;
    params.push(q, q, q);
  }
  if (opts.role) {
    where.push('role = ?');
    params.push(opts.role);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export interface UserRepo {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByPhone(phone: string): Promise<UserRecord | null>;
  insert(u: UserRecord): Promise<void>;
  updatePassword(id: string, hash: string): Promise<void>;
  updateProfile(id: string, patch: UpdateUserProfile): Promise<void>;
  setRole(id: string, role: Role): Promise<void>;
  /**
   * 事务内修改角色，并重新校验「至少保留一名管理员」。
   * 返回 unchanged 表示角色已被其他请求改成了目标值。
   */
  setRoleGuarded(id: string, role: Role): Promise<'ok' | 'unchanged' | 'not_found' | 'last_admin'>;
  countByRole(role: Role): Promise<number>;
  list(opts: UserListFilter & { limit?: number; offset?: number }): Promise<UserRecord[]>;
  count(opts?: UserListFilter): Promise<number>;
  courseCount(userId: string): Promise<number>;
}

export function createUserRepo(db: DB): UserRepo {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const byPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
  const ins = db.prepare(
    `INSERT INTO users (id, email, display_name, role, password_hash, phone, bio, created_at)
     VALUES (@id, @email, @displayName, @role, @passwordHash, @phone, @bio, @createdAt)`,
  );
  const upd = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  const roleById = db.prepare('SELECT role FROM users WHERE id = ?');
  const updRole = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?');
  const phoneTaken = db.prepare('SELECT 1 AS x FROM users WHERE phone = ? AND id <> ? LIMIT 1');

  return {
    async findById(id) {
      const row = byId.get(id) as UserRow | undefined;
      return row ? map(row) : null;
    },
    async findByEmail(email) {
      const row = byEmail.get(email) as UserRow | undefined;
      return row ? map(row) : null;
    },
    async findByPhone(phone) {
      const row = byPhone.get(phone) as UserRow | undefined;
      return row ? map(row) : null;
    },
    async insert(u) {
      ins.run({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        passwordHash: u.passwordHash,
        phone: u.phone,
        bio: u.bio,
        createdAt: u.createdAt,
      });
    },
    async updatePassword(id, hash) {
      upd.run(hash, id);
    },
    async updateProfile(id, patch) {
      if (patch.phone && phoneTaken.get(patch.phone, id)) {
        throw new Error('phone_taken');
      }
      const sets: string[] = [];
      const values: Array<string | null> = [];
      if (patch.displayName !== undefined) {
        sets.push('display_name = ?');
        values.push(patch.displayName);
      }
      if (patch.phone !== undefined) {
        sets.push('phone = ?');
        values.push(patch.phone);
      }
      if (patch.bio !== undefined) {
        sets.push('bio = ?');
        values.push(patch.bio);
      }
      if (sets.length === 0) return;
      values.push(id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    },
    async setRole(id, role) {
      updRole.run(role, id);
    },
    async setRoleGuarded(id, role) {
      // DatabaseSync 是同步 API，事务体内没有 await，检查与更新不会被其他请求插入。
      // BEGIN IMMEDIATE 先拿写锁，多连接/多进程并发降级时也会串行化。
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = roleById.get(id) as { role: Role } | undefined;
        if (!row) {
          db.exec('ROLLBACK');
          return 'not_found';
        }
        if (row.role === role) {
          db.exec('COMMIT');
          return 'unchanged';
        }
        if (row.role === 'admin' && role !== 'admin') {
          const admins = (cnt.get('admin') as { n: number } | undefined)?.n ?? 0;
          if (admins <= 1) {
            db.exec('ROLLBACK');
            return 'last_admin';
          }
        }
        updRole.run(role, id);
        db.exec('COMMIT');
        return 'ok';
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* 事务可能已经结束 */
        }
        throw err;
      }
    },
    async countByRole(role) {
      const row = cnt.get(role) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async count(opts = {}) {
      const { where, params } = buildUserFilter(opts);
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM users ${where}`)
        .get(...params) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async courseCount(userId) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM courses c
           WHERE c.teacher_id = ?
              OR EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?)`,
        )
        .get(userId, userId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async list(opts) {
      const { where, params } = buildUserFilter(opts);
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const offset = Math.max(opts.offset ?? 0, 0);
      const sql = `SELECT * FROM users ${where}
        ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      const rows = db.prepare(sql).all(...params, limit, offset) as unknown as UserRow[];
      return rows.map(map);
    },
  };
}
