// The real SQLite engine in-process (sql.js), for local development and the tests. Never used in production.
// One lock per database, like SQLite's single writer: a transaction holds it from BEGIN to COMMIT, and every
// other statement waits (see lock.ts).
import type { Database, SqlJsStatic } from 'sql.js'
import { Lock } from '../lock'
import { sqlError, SqlError, type SqlDriver, type SqlResult, type SqlTx, type SqlValue, type Stmt } from './driver'

let engine: Promise<SqlJsStatic> | null = null
export function sqlJs(): Promise<SqlJsStatic> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  engine ??= (require('sql.js') as (o?: object) => Promise<SqlJsStatic>)()
  return engine
}

export class SqlJsDriver implements SqlDriver {
  private lock = new Lock()
  /** For the tests: round trips (calls) made inside the last committed transaction, i.e. how long it held the lock. */
  stats = { lastTxCalls: 0, maxTxCalls: 0 }
  /** Called after every committed change (local development saves the file). */
  constructor(private db: Database, private onCommit?: (db: Database) => void) {
    db.exec('PRAGMA foreign_keys = ON')
  }

  private exec(stmts: Stmt[]): SqlResult[] {
    const out: SqlResult[] = []
    for (const s of stmts) {
      let st
      try {
        st = this.db.prepare(s.sql)
        st.bind((s.args ?? []).map((v) => (v === undefined ? null : v)) as SqlValue[])
        const rows: SqlValue[][] = []
        while (st.step()) rows.push(st.get() as SqlValue[])
        const columns = st.getColumnNames()
        const changes = this.db.getRowsModified()
        const lastId = /^\s*INSERT/i.test(s.sql) ? Number(this.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0) : null
        out.push({ columns, rows, changes, lastId })
      } catch (e) {
        throw e instanceof SqlError ? e : sqlError((e as Error).message)
      } finally { st?.free() }
    }
    return out
  }
  private writes = (stmts: Stmt[]) => stmts.some((s) => !/^\s*(SELECT|PRAGMA|WITH)\b/i.test(s.sql))

  async run(stmts: Stmt[]) {
    const release = await this.lock.acquire()
    try {
      const r = this.exec(stmts)
      if (this.writes(stmts)) this.onCommit?.(this.db)
      return r
    } finally { release() }
  }
  async script(sql: string) {
    const release = await this.lock.acquire()
    try { this.db.exec(sql); this.onCommit?.(this.db) } catch (e) { throw sqlError((e as Error).message) } finally { release() }
  }
  async batch(stmts: Stmt[]) {
    const release = await this.lock.acquire()
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try { const r = this.exec(stmts); this.db.exec('COMMIT'); this.onCommit?.(this.db); return r }
      catch (e) { this.db.exec('ROLLBACK'); throw e }
    } finally { release() }
  }
  async begin(): Promise<SqlTx> {
    const release = await this.lock.acquire()
    this.db.exec('BEGIN IMMEDIATE')
    let done = false, calls = 2 // BEGIN and COMMIT are round trips too
    const end = (sql: 'COMMIT' | 'ROLLBACK') => {
      if (done) return
      done = true
      try {
        this.db.exec(sql)
        if (sql === 'COMMIT') { this.onCommit?.(this.db); this.stats.lastTxCalls = calls; this.stats.maxTxCalls = Math.max(this.stats.maxTxCalls, calls) }
      } finally { release() }
    }
    const live = () => { if (done) throw new SqlError('other', 'Transaction already finished') }
    return {
      run: async (stmts) => { live(); calls++; if (process.env.DEBUG_TX) console.log('TX', stmts.map((x) => x.sql.slice(0, 90)).join(' ;; ')); return this.exec(stmts) },
      script: async (sql) => { live(); calls++; try { this.db.exec(sql) } catch (e) { throw sqlError((e as Error).message) } },
      commit: async () => { try { end('COMMIT') } catch (e) { throw sqlError((e as Error).message) } },
      rollback: async () => { try { end('ROLLBACK') } catch { /* already rolled back */ } },
    }
  }
}
