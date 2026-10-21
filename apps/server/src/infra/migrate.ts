import { all, run, transaction, type Db } from './db';
import { migrations as defaultMigrations, type Migration } from './migrations';

export function migrate(
  db: Db,
  now: number,
  migrations: Migration[] = defaultMigrations,
): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    all<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((r) => r.version),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));

  for (const migration of pending) {
    transaction(db, () => {
      db.exec(migration.sql);
      run(db, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        now,
      ]);
    });
  }
  return pending.map((m) => m.version);
}
