import type { DB } from '../index';

export interface TokenRepo {
  insert(id: string, userId: string, tokenHash: string, expiresAt: number, createdAt: number): Promise<void>;
  /** 找到未撤销且未过期的 token */
  findValid(tokenHash: string, now: number): Promise<{ id: string; userId: string } | null>;
  /** 原子撤销；返回 false 表示它已经被别的请求撤销了 */
  revoke(id: string, at: number): Promise<boolean>;
  revokeAllForUser(userId: string, at: number): Promise<void>;
  purgeExpired(now: number): Promise<number>;
}

export function createTokenRepo(db: DB): TokenRepo {
  const ins = db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const find = db.prepare(
    `SELECT id, user_id FROM refresh_tokens
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
  );
  const revokeStmt = db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  );
  const revokeAll = db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
  );
  const purge = db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?');

  return {
    async insert(id, userId, tokenHash, expiresAt, createdAt) {
      ins.run(id, userId, tokenHash, expiresAt, createdAt);
    },
    async findValid(tokenHash, now) {
      const row = find.get(tokenHash, now) as { id: string; user_id: string } | undefined;
      return row ? { id: row.id, userId: row.user_id } : null;
    },
    async revoke(id, at) {
      return Number(revokeStmt.run(at, id).changes) > 0;
    },
    async revokeAllForUser(userId, at) {
      revokeAll.run(at, userId);
    },
    async purgeExpired(now) {
      return Number(purge.run(now).changes);
    },
  };
}
