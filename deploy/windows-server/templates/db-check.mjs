import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify({ ok: false, error: 'usage: node db-check.mjs <app.db>' }));
  process.exit(2);
}

try {
  const db = new DatabaseSync(file, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  const users = db.prepare('SELECT count(*) AS n FROM users').get();
  let courses = null;
  try {
    courses = db.prepare('SELECT count(*) AS n FROM courses').get().n;
  } catch {
    // 旧版数据库可能还没有 002 迁移，启动时服务端会补上
  }
  db.close();

  const ok = integrity.integrity_check === 'ok';
  console.log(
    JSON.stringify({
      ok,
      integrity: integrity.integrity_check,
      tables: tables.n,
      users: users.n,
      courses,
    }),
  );
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
  process.exit(1);
}
