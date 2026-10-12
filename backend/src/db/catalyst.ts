// Catalyst Data Store implementation of Db (zcatalyst-sdk-node). Reads use ZCQL, writes use the table API.
// ZCQL has no query parameters, so every value is checked before it goes into a query (see literal()).
import { columns, fromDs, rowFromDs, rowToDs, toDs } from './columns'
import type { TableName } from './schema.gen'
import { DuplicateError, type AggregateOptions, type Cond, type Db, type NewRow, type Row, type SchemaInfo, type SelectOptions, type Value, type Where } from './types'

/* Minimal shape of the SDK objects we use (keeps the SDK out of the tests). */
export interface CatalystAppLike {
  zcql(): { executeZCQLQuery(q: string): Promise<Record<string, Record<string, unknown>>[]> }
  datastore(): {
    getAllTables?(): Promise<{ _tableDetails?: { table_name?: string }; toJSON?(): { table_name?: string }; getAllColumns(): Promise<{ column_name: string; data_type: string; is_mandatory: boolean; is_unique: boolean; max_length?: string }[]> }[]>
    table(name: string): {
    insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>
    updateRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>
    deleteRows(ids: string[]): Promise<boolean>
  } }
}

const PAGE = 300 // ZCQL returns at most 300 rows per query
const CHUNK = 200 // insertRows / updateRows / deleteRows accept up to 200 rows per call
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A value inside a ZCQL query. Strings may not contain quotes or backslashes, so a query can't be broken out of. */
function literal(table: TableName, col: string, v: Value): string {
  const ds = toDs(table, col, v)
  if (ds === null || ds === undefined) return 'null'
  if (typeof ds === 'number') { if (!Number.isFinite(ds)) throw new Error('Bad number'); return String(ds) }
  if (typeof ds === 'boolean') return ds ? 'true' : 'false'
  if (/['\\\n\r\0]/.test(ds)) throw new Error(`Unsafe value for ${table}.${col}`)
  if (col === 'ROWID' || ['fk', 'id'].includes(columns(table).find((c) => c.name === col)?.type ?? '')) {
    if (!/^\d{1,20}$/.test(ds)) throw new Error(`Bad id for ${table}.${col}`)
    return ds
  }
  return `'${ds}'`
}
function condSql(table: TableName, col: string, cond: Cond): string {
  if (!IDENT.test(col)) throw new Error('Bad column')
  if (cond === null) return `${col} is null`
  if (typeof cond !== 'object') return `${col} = ${literal(table, col, cond)}`
  const c = cond as Record<string, Value | Value[]>
  if ('in' in c) {
    const list = c.in as Value[]
    if (!list.length) return '1 = 0'
    return `${col} IN (${list.map((v) => literal(table, col, v)).join(', ')})`
  }
  const parts: string[] = []
  if ('ne' in c) parts.push(c.ne === null ? `${col} is not null` : `${col} != ${literal(table, col, c.ne as Value)}`)
  if ('gt' in c) parts.push(`${col} > ${literal(table, col, c.gt as Value)}`)
  if ('gte' in c) parts.push(`${col} >= ${literal(table, col, c.gte as Value)}`)
  if ('lt' in c) parts.push(`${col} < ${literal(table, col, c.lt as Value)}`)
  if ('lte' in c) parts.push(`${col} <= ${literal(table, col, c.lte as Value)}`)
  return parts.join(' AND ')
}
export function whereSql(table: TableName, where?: Where) {
  const parts = Object.entries(where ?? {}).map(([k, v]) => condSql(table, k, v))
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
}

export class CatalystDb implements Db {
  constructor(private app: CatalystAppLike) {}

  /** The Data Store has no transactions: fn runs directly, and the code keeps its own undo steps. */
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return fn(this) }

  private async query(table: TableName, sql: string): Promise<Row[]> {
    const res = await this.app.zcql().executeZCQLQuery(sql)
    return res.map((r) => rowFromDs(table, (r[table] ?? Object.values(r)[0]) as Record<string, unknown>))
  }

  async select(table: TableName, o: SelectOptions = {}): Promise<Row[]> {
    if (!IDENT.test(table)) throw new Error('Bad table')
    const order = o.orderBy?.length ? ` ORDER BY ${o.orderBy.map(([c, d]) => { if (!IDENT.test(c)) throw new Error('Bad column'); return `${c} ${d === 'DESC' ? 'DESC' : 'ASC'}` }).join(', ')}` : ''
    const base = `SELECT * FROM ${table}${whereSql(table, o.where)}${order}`
    const want = o.limit ?? Infinity
    const out: Row[] = []
    let offset = o.offset ?? 0
    while (out.length < want) {
      const n = Math.min(PAGE, want - out.length)
      const page = await this.query(table, `${base} LIMIT ${offset}, ${n}`)
      out.push(...page)
      if (page.length < n) break
      offset += page.length
    }
    return out
  }
  async aggregate(table: TableName, o: AggregateOptions) {
    const groups = o.groupBy ?? []
    for (const g of groups) if (!IDENT.test(g)) throw new Error('Bad column')
    const fns = Object.entries(o.fns).map(([alias, [fn, col]]) => { if (!IDENT.test(col)) throw new Error('Bad column'); return { alias, fn, col: fn === 'COUNT' ? 'ROWID' : col } })
    const sql = `SELECT ${[...groups, ...fns.map((f) => `${f.fn}(${f.col})`)].join(', ')} FROM ${table}${whereSql(table, o.where)}${groups.length ? ` GROUP BY ${groups.join(', ')}` : ''}`
    // GROUP BY results are paged like any other ZCQL result (300 rows per query).
    const res: Record<string, Record<string, unknown>>[] = []
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.app.zcql().executeZCQLQuery(groups.length ? `${sql} LIMIT ${offset}, ${PAGE}` : sql)
      res.push(...page)
      if (!groups.length || page.length < PAGE) break
    }
    return res.map((r) => {
      const flat: Record<string, unknown> = Object.assign({}, ...Object.values(r))
      const out: Record<string, Value> = {}
      for (const g of groups) out[g] = fromDs(table, g, flat[g])
      for (const f of fns) {
        // ZCQL names the column like "SUM(total_minor)" — match it without caring about case or spaces.
        const want = `${f.fn}(${f.col})`.toLowerCase()
        const key = Object.keys(flat).find((k) => k.replace(/\s/g, '').toLowerCase() === want) ?? Object.keys(flat).find((k) => k.toLowerCase().includes(f.col.toLowerCase()) && k.toLowerCase().includes(f.fn.toLowerCase()))
        const v = key ? flat[key] : null
        out[f.alias] = f.fn === 'COUNT' || f.fn === 'SUM' ? Number(v ?? 0) : v == null ? null : fromDs(table, f.col, v)
      }
      return out
    })
  }
  async first(table: TableName, where: Where, orderBy?: SelectOptions['orderBy']) { return (await this.select(table, { where, orderBy, limit: 1 }))[0] ?? null }
  async describe(): Promise<SchemaInfo> {
    const tables = await this.app.datastore().getAllTables?.() ?? []
    const out: SchemaInfo['tables'] = []
    for (const t of tables) {
      const name = t._tableDetails?.table_name ?? t.toJSON?.().table_name ?? ''
      const cols = await t.getAllColumns()
      out.push({ name, columns: cols.map((c) => ({ name: c.column_name, type: String(c.data_type).toLowerCase(), mandatory: !!c.is_mandatory, unique: !!c.is_unique, ...(c.max_length ? { maxLength: Number(c.max_length) } : {}) })) })
    }
    return { tables: out }
  }
  async get(table: TableName, id: string) { return this.first(table, { ROWID: id }) }
  async count(table: TableName, where?: Where) {
    const res = await this.app.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${table}${whereSql(table, where)}`)
    const v = Object.values(Object.values(res[0] ?? {})[0] ?? {})[0]
    return Number(v ?? 0)
  }

  async insert(table: TableName, row: NewRow) { return (await this.insertMany(table, [row]))[0] }
  async insertMany(table: TableName, rows: NewRow[]) {
    const out: Row[] = []
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => rowToDs(table, r, true))
      try {
        const res = await this.app.datastore().table(table).insertRows(chunk)
        out.push(...res.map((r) => rowFromDs(table, r)))
      } catch (e) { throw mapError(e, table) }
    }
    return out
  }
  async update(table: TableName, id: string, patch: NewRow) { return (await this.updateMany(table, [{ ...patch, ROWID: id }]))[0] }
  async updateMany(table: TableName, rows: (NewRow & { ROWID: string })[]) {
    const out: Row[] = []
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map(({ ROWID, ...p }) => ({ ...rowToDs(table, p, false), ROWID }))
      try {
        const res = await this.app.datastore().table(table).updateRows(chunk)
        out.push(...res.map((r) => rowFromDs(table, r)))
      } catch (e) { throw mapError(e, table) }
    }
    return out
  }
  /** ZCQL UPDATE … WHERE row_version = v: only one device can win; the others get false and retry. */
  async updateIfVersion(table: TableName, id: string, version: number, patch: NewRow) {
    // Values go inside the query, so this is for counters and numbers (no free text with quotes).
    const set = Object.entries({ ...patch, row_version: version + 1 }).filter(([, v]) => v !== undefined)
      .map(([k, v]) => { if (!IDENT.test(k)) throw new Error('Bad column'); return `${k} = ${literal(table, k, v as Value)}` }).join(', ')
    try {
      const res = await this.app.zcql().executeZCQLQuery(`UPDATE ${table} SET ${set}${whereSql(table, { ROWID: id, row_version: version })}`)
      return Array.isArray(res) && res.length > 0
    } catch (e) { throw mapError(e, table) }
  }
  async delete(table: TableName, id: string) { await this.deleteMany(table, [id]) }
  async deleteMany(table: TableName, ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) await this.app.datastore().table(table).deleteRows(ids.slice(i, i + CHUNK))
  }
}

function mapError(e: unknown, table: string): Error {
  const err = e as { code?: string; message?: string; statusCode?: number }
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`
  if (/DUPLICATE_VALUE|DUPLICATE_ENTRY|already exists/i.test(text)) return new DuplicateError(table)
  return e instanceof Error ? e : new Error(text.trim() || 'Data Store error')
}
