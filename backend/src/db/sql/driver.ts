// The small SQL interface the Turso database code needs. Two implementations:
//   HranaDriver  — Turso over HTTPS (production; plain fetch, no packages)
//   SqlJsDriver  — the SQLite engine in-process (local development and tests)
// Both behave like one SQLite database: one writer at a time, BEGIN IMMEDIATE takes the write lock.

export type SqlValue = null | number | string
export interface Stmt { sql: string; args?: SqlValue[] }
export interface SqlResult { columns: string[]; rows: SqlValue[][]; changes: number; lastId: number | null }

export interface SqlRunner {
  /** Runs the statements in order, in one round trip. Not atomic on its own (use batch or a transaction). */
  run(stmts: Stmt[]): Promise<SqlResult[]>
  /** Several statements in one string, no results (migrations). */
  script(sql: string): Promise<void>
}
export interface SqlTx extends SqlRunner {
  commit(): Promise<void>
  rollback(): Promise<void>
}
export interface SqlDriver extends SqlRunner {
  /** All statements or none, in one round trip. */
  batch(stmts: Stmt[]): Promise<SqlResult[]>
  /** Interactive write transaction. Throws SqlError kind 'busy' when another writer holds the lock too long. */
  begin(): Promise<SqlTx>
  close?(): Promise<void>
}

export type SqlErrorKind = 'unique' | 'foreign_key' | 'not_null' | 'check' | 'busy' | 'network' | 'auth' | 'gone' | 'other'
export class SqlError extends Error {
  constructor(readonly kind: SqlErrorKind, message: string, readonly table?: string, readonly column?: string) { super(message) }
}

/** SQLite's error text → a kind the API can act on ("UNIQUE constraint failed: users.username"). */
export function sqlError(message: string, code?: string): SqlError {
  const text = `${code ?? ''} ${message}`
  const uq = /UNIQUE constraint failed: ([\w]+)\.([\w]+)/.exec(text)
  if (uq) return new SqlError('unique', message, uq[1], uq[2])
  if (/PRIMARY KEY|UNIQUE constraint/i.test(text)) return new SqlError('unique', message)
  if (/FOREIGN KEY constraint/i.test(text)) return new SqlError('foreign_key', message)
  const nn = /NOT NULL constraint failed: ([\w]+)\.([\w]+)/.exec(text)
  if (nn) return new SqlError('not_null', message, nn[1], nn[2])
  if (/CHECK constraint/i.test(text)) return new SqlError('check', message)
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(text)) return new SqlError('busy', message)
  return new SqlError('other', message)
}
