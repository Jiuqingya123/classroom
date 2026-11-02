import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * 打开 SQLite 并设置生产可用的 PRAGMA。
 * WAL 让「读」不被「写」阻塞 —— 教室里 5 个人同时读写白板也不会互相卡住。
 *
 * 用 Node 内置的 node:sqlite 而不是 better-sqlite3：
 * 后者是原生模块，官方预编译包要求 glibc ≥ 2.33，而阿里云 Linux 3 只有 2.32，
 * 从源码编译又依赖完整 C++ 工具链。内置模块没有这些约束，部署只需 npm install。
 */
export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** 顺序执行 migrations/*.sql，已执行的记在 _migrations 里。 */
export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    // 表重建（DROP + RENAME）必须在关闭外键的情况下做，否则子表会阻止 DROP。
    // PRAGMA foreign_keys 在事务内无效，所以只能在 BEGIN 之前切换。
    db.exec('PRAGMA foreign_keys = OFF');
    // node:sqlite 没有 db.transaction() 包装器，手写事务；迁移失败必须整体回滚，
    // 否则会留下「表建了一半、_migrations 却没记录」的半截状态。
    db.exec('BEGIN');
    try {
      db.exec(sql);
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`迁移 ${file} 留下 ${violations.length} 条外键违规`);
      }
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    ran.push(file);
  }
  return ran;
}
