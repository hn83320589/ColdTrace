import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

type Statement = ReturnType<Db['prepare']>;

/** node:sqlite 的具名參數與位置參數是不同 overload，在這裡統一 */
function exec<R>(
  db: Db,
  sql: string,
  params: Params | undefined,
  call: (stmt: Statement, args: SQLInputValue[], named?: Record<string, SQLInputValue>) => R,
): R {
  const stmt = db.prepare(sql);
  if (params === undefined) return call(stmt, []);
  return Array.isArray(params) ? call(stmt, params) : call(stmt, [], params);
}

export function all<T>(db: Db, sql: string, params?: Params): T[] {
  return exec(db, sql, params, (s, args, named) =>
    named ? s.all(named, ...args) : s.all(...args),
  ) as T[];
}

export function get<T>(db: Db, sql: string, params?: Params): T | undefined {
  return exec(db, sql, params, (s, args, named) =>
    named ? s.get(named, ...args) : s.get(...args),
  ) as T | undefined;
}

export function run(db: Db, sql: string, params?: Params): { changes: number; lastId: number } {
  const result = exec(db, sql, params, (s, args, named) =>
    named ? s.run(named, ...args) : s.run(...args),
  );
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}

const depthByDb = new WeakMap<Db, number>();

/**
 * 以 SAVEPOINT 實作可巢狀的 transaction。
 * 例外會往上拋，並回滾到這一層的 savepoint。
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const depth = depthByDb.get(db) ?? 0;
  const name = `sp_${depth}`;
  db.exec(`SAVEPOINT ${name}`);
  depthByDb.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  } finally {
    depthByDb.set(db, depth);
  }
}
