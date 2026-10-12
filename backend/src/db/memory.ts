// In-memory Data Store with the same rules as Catalyst (types, defaults, mandatory, unique, FK on-delete).
// Used for local development (`npm run dev`, saved to a JSON file) and for the tests. Never used in production.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { columns, fromDs, rowFromDs, rowToDs, toDs } from './columns'
import { TABLES, type TableName } from './schema.gen'
import { Lock } from './lock'
import { DuplicateError, type AggregateOptions, type Cond, type Db, type NewRow, type Row, type SelectOptions, type Value, type Where } from './types'

type Stored = Record<string, Value>

/** The store itself — no locking. MemoryDb below adds one writer at a time and transactions. */
class MemoryStore {
  readonly inTransaction = false
  private data = new Map<string, Stored[]>()
  private seq = 3396000000000001n
  /** Rows read / written — the tests use this to check how many Data Store calls a screen costs. */
  stats = { reads: 0, inserts: 0, updates: 0, deletes: 0 }

  constructor(private file?: string) {
    for (const t of Object.keys(TABLES)) this.data.set(t, [])
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { seq: string; data: Record<string, Stored[]> }
      this.seq = BigInt(saved.seq)
      for (const [t, rows] of Object.entries(saved.data)) if (this.data.has(t)) this.data.set(t, rows)
    }
  }
  snapshot() { return { seq: this.seq, data: structuredClone(this.data) } }
  restore(s: { seq: bigint; data: Map<string, Stored[]> }) { this.seq = s.seq; this.data = s.data; this.save() }
  private save() { if (this.file) writeFileSync(this.file, JSON.stringify({ seq: String(this.seq), data: Object.fromEntries(this.data) })) }
  private rows(t: TableName) { return this.data.get(t)! }
  private nowDs() { const d = new Date(); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}:${String(d.getUTCMilliseconds()).padStart(3, '0')}` }

  private match(t: TableName, r: Stored, where?: Where) {
    if (!where) return true
    return Object.entries(where).every(([k, cond]) => test(fromDs(t, k, r[k]), conv(t, k, cond)))
  }

  async select(t: TableName, o: SelectOptions = {}): Promise<Row[]> {
    let out = this.rows(t).filter((r) => this.match(t, r, o.where)).map((r) => rowFromDs(t, r))
    for (const [col, dir] of [...(o.orderBy ?? [])].reverse()) out = out.sort((a, b) => cmp(a[col], b[col]) * (dir === 'DESC' ? -1 : 1))
    out = out.slice(o.offset ?? 0, o.limit !== undefined ? (o.offset ?? 0) + o.limit : undefined)
    this.stats.reads += out.length
    return out
  }
  async aggregate(t: TableName, o: AggregateOptions) {
    const rows = this.rows(t).filter((r) => this.match(t, r, o.where)).map((r) => rowFromDs(t, r))
    const groups = new Map<string, Row[]>()
    for (const r of rows) { const k = JSON.stringify((o.groupBy ?? []).map((g) => r[g])); groups.set(k, [...(groups.get(k) ?? []), r]) }
    if (!o.groupBy?.length && !groups.size) groups.set('[]', [])
    this.stats.reads += groups.size
    return [...groups.entries()].map(([k, rs]) => {
      const out: Record<string, Value> = {}
      ;(JSON.parse(k) as Value[]).forEach((v, i) => { out[o.groupBy![i]] = v })
      for (const [alias, [fn, col]] of Object.entries(o.fns)) {
        const vals = rs.map((r) => r[col]).filter((v) => v !== null && v !== undefined)
        out[alias] = fn === 'COUNT' ? rs.length : fn === 'SUM' ? vals.reduce((a: number, v) => a + Number(v), 0)
          : !vals.length ? null : vals.reduce((a, v) => (fn === 'MAX' ? (v! > a! ? v : a) : (v! < a! ? v : a)))
      }
      return out
    })
  }
  async describe() {
    return { tables: (Object.entries(TABLES) as [string, readonly { name: string; type: string; mandatory: boolean; unique: boolean; maxLength?: number }[]][]).map(([name, cols]) => ({
      name, columns: cols.map((c) => ({ name: c.name, type: c.type === 'fk' ? 'foreign key' : c.type === 'id' ? 'bigint' : c.type === 'encrypted' ? 'encrypted text' : c.type, mandatory: c.mandatory, unique: c.unique, maxLength: c.maxLength })),
    })) }
  }
  async first(t: TableName, where: Where, orderBy?: SelectOptions['orderBy']) { return (await this.select(t, { where, orderBy, limit: 1 }))[0] ?? null }
  async get(t: TableName, id: string) { return this.first(t, { ROWID: id }) }
  async count(t: TableName, where?: Where) { this.stats.reads++; return this.rows(t).filter((r) => this.match(t, r, where)).length }

  private checkUnique(t: TableName, row: Stored, selfId?: Value) {
    for (const c of columns(t)) {
      if (!c.unique || c.name === 'ROWID' || row[c.name] === null || row[c.name] === undefined) continue
      if (this.rows(t).some((r) => r.ROWID !== selfId && r[c.name] === row[c.name])) throw new DuplicateError(t, c.name)
    }
  }
  private checkFks(t: TableName, row: Stored) {
    for (const c of columns(t)) {
      if (c.type !== 'fk' || !c.references || row[c.name] === null || row[c.name] === undefined) continue
      if (!this.rows(c.references as TableName).some((r) => r.ROWID === row[c.name])) throw new Error(`${t}.${c.name}: no ${c.references} row ${row[c.name]}`)
    }
  }

  async insert(t: TableName, row: NewRow) { return (await this.insertMany(t, [row]))[0] }
  async insertMany(t: TableName, rows: NewRow[]) {
    const made: Stored[] = []
    for (const r of rows) {
      const ds = rowToDs(t, r, true) as Stored
      this.checkUnique(t, ds); this.checkFks(t, ds)
      for (const m of made) for (const c of columns(t)) if (c.unique && c.name !== 'ROWID' && ds[c.name] != null && m[c.name] === ds[c.name]) throw new DuplicateError(t, c.name)
      const now = this.nowDs()
      made.push({ ...ds, ROWID: String(this.seq++), CREATORID: '1', CREATEDTIME: now, MODIFIEDTIME: now })
    }
    this.rows(t).push(...made)
    this.stats.inserts += made.length
    this.save()
    return made.map((r) => rowFromDs(t, r))
  }

  async update(t: TableName, id: string, patch: NewRow) { return (await this.updateMany(t, [{ ...patch, ROWID: id }]))[0] }
  async updateMany(t: TableName, rows: (NewRow & { ROWID: string })[]) {
    const out: Row[] = []
    for (const { ROWID, ...patch } of rows) {
      const cur = this.rows(t).find((r) => r.ROWID === ROWID)
      if (!cur) throw new Error(`${t} row ${ROWID} not found`)
      const ds = rowToDs(t, patch, false) as Stored
      const next: Stored = { ...cur, ...ds, MODIFIEDTIME: this.nowDs() }
      for (const c of columns(t)) if (c.mandatory && c.name in ds && (next[c.name] === null || next[c.name] === undefined)) throw new Error(`${t}.${c.name} is required`)
      this.checkUnique(t, next, ROWID); this.checkFks(t, ds)
      Object.assign(cur, next)
      out.push(rowFromDs(t, cur))
    }
    this.stats.updates += rows.length
    this.save()
    return out
  }
  async updateIfVersion(t: TableName, id: string, version: number, patch: NewRow) {
    const cur = this.rows(t).find((r) => r.ROWID === id)
    if (!cur || Number(cur.row_version) !== version) return false
    await this.update(t, id, { ...patch, row_version: version + 1 })
    return true
  }

  async delete(t: TableName, id: string) { await this.deleteMany(t, [id]) }
  async deleteMany(t: TableName, ids: string[]) {
    const gone = new Set(ids)
    const before = this.rows(t).length
    this.data.set(t, this.rows(t).filter((r) => !gone.has(String(r.ROWID))))
    this.stats.deletes += before - this.rows(t).length
    // Foreign keys pointing here: Cascade deletes the child rows, Null clears the column.
    for (const [child, cols] of Object.entries(TABLES) as [TableName, readonly { name: string; references?: string; onDelete?: string }[]][]) {
      for (const c of cols) {
        if (c.references !== t) continue
        if (c.onDelete === 'cascade') {
          const ids2 = this.rows(child).filter((r) => gone.has(String(r[c.name]))).map((r) => String(r.ROWID))
          if (ids2.length) await this.deleteMany(child, ids2)
        } else for (const r of this.rows(child)) if (gone.has(String(r[c.name]))) r[c.name] = null
      }
    }
    this.save()
  }
}

function conv(t: TableName, k: string, cond: Cond): Cond {
  const one = (v: Value) => (v === null ? null : fromDs(t, k, toDs(t, k, v)))
  if (cond === null || typeof cond !== 'object') return one(cond as Value)
  return Object.fromEntries(Object.entries(cond).map(([op, v]) => [op, Array.isArray(v) ? v.map(one) : one(v as Value)])) as Cond
}
function cmp(a: Value, b: Value) {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}
function test(v: Value, cond: Cond): boolean {
  if (cond === null) return v === null
  if (typeof cond !== 'object') return v === cond
  const c = cond as Record<string, Value | Value[]>
  if ('in' in c) return (c.in as Value[]).includes(v)
  if ('ne' in c) return v !== c.ne
  if (v === null) return false
  const x = v as string | number
  if ('gt' in c && !(x > (c.gt as string | number))) return false
  if ('gte' in c && !(x >= (c.gte as string | number))) return false
  if ('lt' in c && !(x < (c.lt as string | number))) return false
  if ('lte' in c && !(x <= (c.lte as string | number))) return false
  return true
}

type Method = 'select' | 'aggregate' | 'describe' | 'first' | 'get' | 'count' | 'insert' | 'insertMany' | 'update' | 'updateMany' | 'updateIfVersion' | 'delete' | 'deleteMany'
const METHODS: Method[] = ['select', 'aggregate', 'describe', 'first', 'get', 'count', 'insert', 'insertMany', 'update', 'updateMany', 'updateIfVersion', 'delete', 'deleteMany']

/** A handle on the store: `locked` = each call waits its turn; otherwise it is the open transaction's handle. */
function view(store: MemoryStore, lock: Lock | null): Db {
  const out = { inTransaction: !lock } as Record<string, unknown>
  for (const m of METHODS) {
    const fn = (store[m] as (...a: unknown[]) => Promise<unknown>).bind(store)
    out[m] = lock ? async (...a: unknown[]) => { const release = await lock.acquire(); try { return await fn(...a) } finally { release() } } : fn
  }
  return out as unknown as Db
}

/**
 * In-memory Data Store with the same rules as Catalyst, plus transactions like SQLite: one writer at a time,
 * and a failed transaction puts every row back as it was.
 */
export class MemoryDb implements Db {
  private store: MemoryStore
  private lock = new Lock()
  private plain: Db
  constructor(file?: string) {
    this.store = new MemoryStore(file)
    this.plain = view(this.store, this.lock)
    for (const m of METHODS) (this as unknown as Record<string, unknown>)[m] = (this.plain as unknown as Record<string, unknown>)[m]
  }
  get stats() { return this.store.stats }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const release = await this.lock.acquire()
    const before = this.store.snapshot()
    const tx = view(this.store, null)
    tx.transaction = (f) => f(tx)
    try { return await fn(tx) } catch (e) { this.store.restore(before); throw e } finally { release() }
  }
}
export interface MemoryDb extends Pick<Db, Method> {}
