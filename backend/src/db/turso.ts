// Turso (libSQL / SQLite) implementation of Db. Same rows as the other implementations: the app still sees
// ROWID / CREATEDTIME / MODIFIEDTIME and ids as strings; the tables use id / created_at / updated_at.
// Every value is a query parameter (never put into the SQL text), and every column name is checked against
// the schema before it is used.
import { decryptSecret, encryptSecret } from '../core/crypto'
import { ApiError } from '../core/errors'
import { column, columns } from './columns'
import { type TableName, TABLES } from './schema.gen'
import { SqlError, type SqlDriver, type SqlRunner, type SqlTx, type SqlValue, type Stmt } from './sql/driver'
import { DuplicateError, type AggregateOptions, type Cond, type Db, type NewRow, type Row, type SchemaInfo, type SelectOptions, type SqlRow, type Value, type Where } from './types'

const SYSTEM_SQL: Record<string, string> = { ROWID: 'id', CREATEDTIME: 'created_at', MODIFIEDTIME: 'updated_at' }
const SQL_SYSTEM: Record<string, string> = { id: 'ROWID', created_at: 'CREATEDTIME', updated_at: 'MODIFIEDTIME' }
const MAX_VARS = 30_000 // SQLite allows 32,766 parameters per statement
const BUSY_RETRY_MS = Number(process.env.DB_BUSY_RETRY_MS ?? 8000)

const q = (s: string) => `"${s}"`
/** App column name → quoted SQL column (checked against the schema). */
function col(table: TableName, name: string) {
  if (name in SYSTEM_SQL) return q(SYSTEM_SQL[name])
  column(table, name) // throws on an unknown column
  return q(name)
}
function tbl(table: TableName) {
  if (!(table in TABLES)) throw new Error(`Unknown table ${table}`)
  return q(table)
}

/** JavaScript value → SQLite value, with the same checks as the Data Store (types, lengths). */
export function toSql(table: TableName, name: string, v: Value | undefined): SqlValue {
  if (v === undefined || v === null) return null
  const c = column(table, name)
  switch (c.type) {
    case 'int': case 'bigint': {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isSafeInteger(n)) throw new Error(`${table}.${name} must be a whole number (got ${v})`)
      return n
    }
    case 'double': {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`${table}.${name} must be a number (got ${v})`)
      return n
    }
    case 'boolean': return v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0
    case 'datetime': {
      const d = new Date(typeof v === 'number' ? v : String(v))
      if (Number.isNaN(d.getTime())) throw new ApiError('Invalid date')
      return d.toISOString()
    }
    case 'date': {
      const s = String(v)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${table}.${name} must be YYYY-MM-DD`)
      return s
    }
    case 'fk': case 'id': {
      const s = String(v)
      if (!/^\d{1,16}$/.test(s) || !Number.isSafeInteger(Number(s))) throw new Error(`Bad id for ${table}.${name}`)
      return Number(s)
    }
    default: {
      const s = String(v)
      if (c.maxLength && s.length > c.maxLength) throw new ApiError(`Too long (${c.maxLength} characters at most)`)
      if ((c.type === 'text' || c.type === 'encrypted') && s.length > 10_000) throw new ApiError('Text is too long (10,000 characters at most)')
      // SQLite doesn't encrypt: ENCRYPTED columns are encrypted here (Catalyst does it by itself).
      return c.type === 'encrypted' ? encryptSecret(s) : s
    }
  }
}
function fromSql(table: TableName, name: string, v: SqlValue): Value {
  if (v === null || v === undefined) return null
  const c = column(table, name)
  switch (c.type) {
    case 'int': case 'bigint': case 'double': return Number(v)
    case 'boolean': return v === 1 || v === '1'
    case 'fk': case 'id': return String(v)
    case 'encrypted': return decryptSecret(String(v))
    default: return String(v)
  }
}
function rowFrom(table: TableName, columns_: string[], values: SqlValue[]): Row {
  const out: Record<string, Value> = {}
  columns_.forEach((c, i) => { const name = SQL_SYSTEM[c] ?? c; out[name] = fromSql(table, name, values[i]) })
  return out as Row
}

/** Insert: schema defaults filled in and NOT NULL columns checked here, so the message is clear. */
function forInsert(table: TableName, row: NewRow): Record<string, SqlValue> {
  for (const k of Object.keys(row)) if (!['CREATEDTIME', 'MODIFIEDTIME', 'CREATORID', 'ROWID'].includes(k)) column(table, k)
  const out: Record<string, SqlValue> = {}
  for (const c of columns(table)) {
    if (['ROWID', 'CREATORID', 'CREATEDTIME', 'MODIFIEDTIME'].includes(c.name)) continue
    let v = row[c.name]
    if (v === undefined && c.default !== undefined) v = c.type === 'boolean' ? c.default === 'true' : c.type === 'int' || c.type === 'bigint' ? Number(c.default) : c.default
    out[c.name] = toSql(table, c.name, v as Value)
    if (c.mandatory && out[c.name] === null) throw new Error(`${table}.${c.name} is required`)
  }
  return out
}
function forUpdate(table: TableName, patch: NewRow): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || ['ROWID', 'CREATEDTIME', 'MODIFIEDTIME', 'CREATORID'].includes(k)) continue
    const c = column(table, k)
    out[k] = toSql(table, k, v)
    if (c.mandatory && out[k] === null) throw new Error(`${table}.${k} is required`)
  }
  return out
}

function condSql(table: TableName, name: string, cond: Cond, args: SqlValue[]): string {
  const c = col(table, name)
  const one = (v: Value) => { args.push(toSql(table, name, v)); return '?' }
  if (cond === null) return `${c} IS NULL`
  if (typeof cond !== 'object') return `${c} = ${one(cond)}`
  const o = cond as Record<string, Value | Value[]>
  if ('in' in o) {
    const list = o.in as Value[]
    if (!list.length) return '0'
    return `${c} IN (${list.map(one).join(', ')})`
  }
  const parts: string[] = []
  // "not equal" includes NULLs (same as the in-memory store): IS NOT compares NULL like a value.
  if ('ne' in o) parts.push(o.ne === null ? `${c} IS NOT NULL` : `${c} IS NOT ${one(o.ne as Value)}`)
  if ('gt' in o) parts.push(`${c} > ${one(o.gt as Value)}`)
  if ('gte' in o) parts.push(`${c} >= ${one(o.gte as Value)}`)
  if ('lt' in o) parts.push(`${c} < ${one(o.lt as Value)}`)
  if ('lte' in o) parts.push(`${c} <= ${one(o.lte as Value)}`)
  return parts.join(' AND ') || '1'
}
function whereSql(table: TableName, where: Where | undefined, args: SqlValue[]) {
  const parts = Object.entries(where ?? {}).map(([k, v]) => condSql(table, k, v, args))
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
}

function mapError(e: unknown, table: TableName): Error {
  if (e instanceof SqlError) {
    if (e.kind === 'unique') return new DuplicateError(e.table ?? table, e.column)
    if (e.kind === 'busy') return new ApiError('The shop is busy — please try again', 409, 'BUSY')
    if (e.kind === 'network') return new ApiError('Can’t reach the database right now — please try again', 503, 'DB_UNAVAILABLE')
    if (e.kind === 'gone') return new ApiError('This shop’s data is no longer available. Please sign in again.', 401, 'UNAUTHORIZED')
  }
  return e as Error
}

/** Calls on one transaction go one after another (one connection), even when the code uses Promise.all. */
class Serial implements SqlRunner {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private tx: SqlTx) {}
  private next<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn)
    this.tail = p.catch(() => {})
    return p
  }
  run(stmts: Stmt[]) { return this.next(() => this.tx.run(stmts)) }
  script(sql: string) { return this.next(() => this.tx.script(sql)) }
}

export class TursoDb implements Db {
  readonly inTransaction: boolean
  constructor(private driver: SqlDriver, private runner: SqlRunner = driver, inTx = false) { this.inTransaction = inTx }

  private async exec(table: TableName, stmts: Stmt[]) {
    try { return await this.runner.run(stmts) } catch (e) { throw mapError(e, table) }
  }
  /** Several writes that must all happen: one round trip, atomic (inside a transaction: part of it). */
  private async execAll(table: TableName, stmts: Stmt[]) {
    if (stmts.length <= 1 || this.inTransaction) return this.exec(table, stmts)
    try { return await this.driver.batch(stmts) } catch (e) { throw mapError(e, table) }
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this)
    const started = Date.now()
    let tx: SqlTx
    for (let attempt = 0; ; attempt++) {
      try { tx = await this.driver.begin(); break } catch (e) {
        // Another device is saving in this shop. Nothing has run yet, so waiting and trying again is safe.
        if (e instanceof SqlError && e.kind === 'busy' && Date.now() - started < BUSY_RETRY_MS) { await sleep(Math.min(400, 25 * 2 ** attempt) * (0.5 + Math.random())); continue }
        throw mapError(e, 'businesses')
      }
    }
    const handle = new TursoDb(this.driver, new Serial(tx), true)
    try {
      const out = await fn(handle)
      await tx.commit()
      return out
    } catch (e) {
      await tx.rollback()
      throw e instanceof SqlError ? mapError(e, 'businesses') : e
    }
  }

  async sql(sql: string, args: (string | number | null)[] = []): Promise<SqlRow[]> {
    const [r] = await this.exec('businesses', [{ sql, args }])
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])))
  }

  async sqlMany(stmts: { sql: string; args?: (string | number | null)[] }[]): Promise<SqlRow[][]> {
    if (!stmts.length) return []
    const results = await this.execAll('businesses', stmts.map((x) => ({ sql: x.sql, args: x.args ?? [] })))
    return results.map((r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))))
  }

  async select(table: TableName, o: SelectOptions = {}): Promise<Row[]> {
    const args: SqlValue[] = []
    let sql = `SELECT * FROM ${tbl(table)}${whereSql(table, o.where, args)}`
    if (o.orderBy?.length) sql += ` ORDER BY ${o.orderBy.map(([c, d]) => `${col(table, c)} ${d === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`
    if (o.limit !== undefined || o.offset) { sql += ' LIMIT ? OFFSET ?'; args.push(o.limit ?? -1, o.offset ?? 0) }
    const [r] = await this.exec(table, [{ sql, args }])
    return r.rows.map((v) => rowFrom(table, r.columns, v))
  }
  async first(table: TableName, where: Where, orderBy?: SelectOptions['orderBy']) { return (await this.select(table, { where, orderBy, limit: 1 }))[0] ?? null }
  async get(table: TableName, id: string) {
    if (!/^\d{1,16}$/.test(String(id))) return null
    return this.first(table, { ROWID: id })
  }
  async count(table: TableName, where?: Where) {
    const args: SqlValue[] = []
    const [r] = await this.exec(table, [{ sql: `SELECT COUNT(*) FROM ${tbl(table)}${whereSql(table, where, args)}`, args }])
    return Number(r.rows[0]?.[0] ?? 0)
  }
  async aggregate(table: TableName, o: AggregateOptions) {
    const groups = o.groupBy ?? []
    const fns = Object.entries(o.fns)
    const args: SqlValue[] = []
    const sel = [
      ...groups.map((g) => col(table, g)),
      ...fns.map(([, [fn, c]], i) => {
        if (!['SUM', 'COUNT', 'MAX', 'MIN'].includes(fn)) throw new Error('Bad aggregate')
        return `${fn === 'COUNT' ? 'COUNT(*)' : fn === 'SUM' ? `COALESCE(SUM(${col(table, c)}), 0)` : `${fn}(${col(table, c)})`} AS "f${i}"`
      }),
    ]
    const sql = `SELECT ${sel.join(', ')} FROM ${tbl(table)}${whereSql(table, o.where, args)}${groups.length ? ` GROUP BY ${groups.map((g) => col(table, g)).join(', ')}` : ''}`
    const [r] = await this.exec(table, [{ sql, args }])
    return r.rows.map((row) => {
      const out: Record<string, Value> = {}
      groups.forEach((g, i) => { out[g] = fromSql(table, g, row[i]) })
      fns.forEach(([alias, [fn, c]], i) => {
        const v = row[groups.length + i]
        out[alias] = fn === 'COUNT' || fn === 'SUM' ? Number(v ?? 0) : fromSql(table, c, v)
      })
      return out
    })
  }
  async describe(): Promise<SchemaInfo> {
    const [list] = await this.exec('businesses', [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name" }])
    const names = list.rows.map((r) => String(r[0]))
    const infos = await this.exec('businesses', names.map((n) => ({ sql: `SELECT name, type, "notnull" FROM pragma_table_info(?)`, args: [n] })))
    return {
      tables: names.map((name, i) => ({
        name, columns: infos[i].rows.map((r) => ({ name: SQL_SYSTEM[String(r[0])] ?? String(r[0]), type: String(r[1]).toLowerCase(), mandatory: r[2] === 1, unique: false })),
      })),
    }
  }

  async insert(table: TableName, row: NewRow) { return (await this.insertMany(table, [row]))[0] }
  async insertMany(table: TableName, rows: NewRow[]): Promise<Row[]> {
    if (!rows.length) return []
    const prepared = rows.map((r) => forInsert(table, r))
    const names = Object.keys(prepared[0])
    const per = Math.max(1, Math.min(500, Math.floor(MAX_VARS / Math.max(1, names.length))))
    const stmts: Stmt[] = []
    for (let i = 0; i < prepared.length; i += per) {
      const chunk = prepared.slice(i, i + per)
      const one = `(${names.map(() => '?').join(', ')})`
      stmts.push({
        sql: `INSERT INTO ${tbl(table)} (${names.map(q).join(', ')}) VALUES ${chunk.map(() => one).join(', ')} RETURNING *`,
        args: chunk.flatMap((r) => names.map((n) => r[n])),
      })
    }
    const results = await this.execAll(table, stmts)
    // New ids only grow (AUTOINCREMENT), so sorting by id gives the rows back in the order they were given.
    return results.flatMap((r) => r.rows.map((v) => rowFrom(table, r.columns, v))).sort((a, b) => Number(a.ROWID) - Number(b.ROWID))
  }

  private updateStmt(table: TableName, id: string, patch: NewRow): Stmt {
    const set = forUpdate(table, patch)
    const names = Object.keys(set)
    const args: SqlValue[] = names.map((n) => set[n])
    args.push(toSql(table, 'ROWID', id))
    // Always touch updated_at, even when the values are the same (the trigger only runs when it didn't change).
    const assign = [...names.map((n) => `${q(n)} = ?`), `"updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`]
    return { sql: `UPDATE ${tbl(table)} SET ${assign.join(', ')} WHERE "id" = ? RETURNING *`, args }
  }
  async update(table: TableName, id: string, patch: NewRow) { return (await this.updateMany(table, [{ ...patch, ROWID: id }]))[0] }
  async updateMany(table: TableName, rows: (NewRow & { ROWID: string })[]): Promise<Row[]> {
    if (!rows.length) return []
    const results = await this.execAll(table, rows.map(({ ROWID, ...p }) => this.updateStmt(table, ROWID, p)))
    return results.map((r, i) => {
      if (!r.rows.length) throw new Error(`${table} row ${rows[i].ROWID} not found`)
      return rowFrom(table, r.columns, r.rows[0])
    })
  }
  async updateIfVersion(table: TableName, id: string, version: number, patch: NewRow) {
    const set = forUpdate(table, { ...patch, row_version: version + 1 })
    const names = Object.keys(set)
    const args: SqlValue[] = [...names.map((n) => set[n]), toSql(table, 'ROWID', id), version]
    const [r] = await this.exec(table, [{ sql: `UPDATE ${tbl(table)} SET ${names.map((n) => `${q(n)} = ?`).join(', ')}, "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "id" = ? AND "row_version" = ?`, args }])
    return r.changes > 0
  }

  async delete(table: TableName, id: string) { await this.deleteMany(table, [id]) }
  /** Child rows go with the foreign keys (ON DELETE CASCADE / SET NULL). */
  async deleteMany(table: TableName, ids: string[]) {
    if (!ids.length) return
    const stmts: Stmt[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      stmts.push({ sql: `DELETE FROM ${tbl(table)} WHERE "id" IN (${chunk.map(() => '?').join(', ')})`, args: chunk.map((id) => toSql(table, 'ROWID', id)) })
    }
    await this.execAll(table, stmts)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
