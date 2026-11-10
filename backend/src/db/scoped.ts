// A Db handle limited to the tables of one kind of database. With one database per shop, a query on the
// wrong handle would look in the wrong database — this turns that mistake into a clear error everywhere,
// including the single-database setups (Catalyst, tests) where it would otherwise go unnoticed.
import type { DbKind } from './migrate'
import { PLATFORM_TABLES, SHARED_TABLES, TABLES, type TableName } from './schema.gen'
import type { Db, Row, SelectOptions, Value, WriteOp } from './types'

const ALL = Object.keys(TABLES) as TableName[]
const ON: Record<DbKind, Set<string>> = {
  platform: new Set([...PLATFORM_TABLES, ...SHARED_TABLES]),
  shop: new Set(ALL.filter((t) => !PLATFORM_TABLES.includes(t))),
}
export const tablesOf = (kind: DbKind) => ALL.filter((t) => ON[kind].has(t))

export function scoped(db: Db, kind: DbKind): Db {
  const check = (t: TableName) => {
    if (!ON[kind].has(t)) throw new Error(`Table ${t} is not in the ${kind} database — use ${kind === 'platform' ? 'c.db (the shop database)' : 'c.platform'}`)
  }
  return {
    inTransaction: db.inTransaction,
    transaction: (fn) => db.transaction((tx) => fn(scoped(tx, kind))),
    ...(db.sql ? { sql: (s: string, a?: (string | number | null)[]) => db.sql!(s, a) } : {}),
    ...(db.sqlMany ? { sqlMany: (x: { sql: string; args?: (string | number | null)[] }[]) => db.sqlMany!(x) } : {}),
    ...(db.sqlReads ? { sqlReads: (x: { sql: string; args?: (string | number | null)[] }[]) => db.sqlReads!(x) } : {}),
    ...(db.writeBatch ? { writeBatch: (ops: WriteOp[]) => (ops.forEach((o) => { if (!('sql' in o)) check('insert' in o ? o.insert : o.update) }), db.writeBatch!(ops)) } : {}),
    ...(db.describe ? { describe: () => db.describe!() } : {}),
    aggregate: (t, o) => (check(t), db.aggregate(t, o)),
    select: (t, o) => (check(t), db.select(t, o)),
    first: (t, w, o) => (check(t), db.first(t, w, o)),
    get: (t, id) => (check(t), db.get(t, id)),
    count: (t, w) => (check(t), db.count(t, w)),
    insert: (t, r) => (check(t), db.insert(t, r)),
    insertMany: (t, r) => (check(t), db.insertMany(t, r)),
    update: (t, id, p) => (check(t), db.update(t, id, p)),
    updateMany: (t, r) => (check(t), db.updateMany(t, r)),
    updateIfVersion: (t, id, v, p) => (check(t), db.updateIfVersion(t, id, v, p)),
    delete: (t, id) => (check(t), db.delete(t, id)),
    deleteMany: (t, ids) => (check(t), db.deleteMany(t, ids)),
  }
}

/** Catalogue tables a bill only reads: kept for the rest of the request once read (Ctx.memoCatalog). */

const productRows = new WeakMap<Map<string, Promise<unknown>>, Map<string, Row>>()
/** `{ business_id, ROWID: id | { in: ids } }` and nothing else (no order, limit or other filter) → those ids; otherwise null. */
function idsOnly(o: SelectOptions | undefined): { biz: Value; ids: string[] } | null {
  const w = o?.where
  if (!w || o.orderBy?.length || o.limit !== undefined || o.offset) return null
  const keys = Object.keys(w)
  if (keys.length !== 2 || !('business_id' in w) || !('ROWID' in w)) return null
  const biz = w.business_id, id = w.ROWID
  if (biz === null || typeof biz === 'object') return null
  const ids: string[] | null = typeof id === 'string' ? [id] : id && typeof id === 'object' && 'in' in id ? id.in.map((x) => String(x)) : null
  return ids && ids.length ? { biz, ids: [...new Set(ids)] } : null
}
const MEMO = new Set<string>(['products', 'product_variants', 'product_addons', 'product_prices', 'price_lists', 'daily_specials', 'categories', 'tax_rates', 'media_files'])

/**
 * Same handle, but reads of the catalogue tables are answered from `memo` when the exact same read was made
 * earlier in this request. A write to one of them forgets that table's reads.
 */
export function memoized(db: Db, memo: Map<string, Promise<unknown>>): Db {
  const read = <T>(method: string, t: TableName, args: unknown[], run: () => Promise<T>): Promise<T> => {
    if (!MEMO.has(t)) return run()
    const key = `${method}|${t}|${JSON.stringify(args)}`
    let hit = memo.get(key) as Promise<T> | undefined
    if (!hit) { hit = run(); memo.set(key, hit); hit.catch(() => memo.delete(key)) }
    return hit.then((v) => structuredClone(v))
  }
  // Product rows already read in this request, by id: a later "these products by id" read (the bill's stock step
  // after its pricing read) is answered from them — the same rows, one round trip less.
  let byId = productRows.get(memo)
  if (!byId) productRows.set(memo, (byId = new Map()))
  const products = byId
  const selectProducts = async (o: SelectOptions | undefined): Promise<Row[]> => {
    const ids = idsOnly(o)
    if (ids && ids.ids.every((id) => { const r = products.get(id); return !!r && String(r.business_id) === String(ids.biz) })) return ids.ids.map((id) => structuredClone(products.get(id)!))
    const rows = await read('select', 'products', [o], () => db.select('products', o))
    for (const r of rows) products.set(String(r.ROWID), r)
    return rows
  }
  const wrote = (t: TableName) => {
    if (MEMO.has(t)) for (const k of [...memo.keys()]) if (k.split('|')[1] === t) memo.delete(k)
    if (t === 'products') products.clear()
  }
  const w = <T>(t: TableName, run: () => Promise<T>) => { wrote(t); return run() }
  return {
    ...db,
    transaction: (fn) => db.transaction((tx) => fn(memoized(tx, memo))),
    select: (t, o) => (t === 'products' ? selectProducts(o) : read('select', t, [o], () => db.select(t, o))),
    first: (t, wh, o) => read('first', t, [wh, o], () => db.first(t, wh, o)),
    get: (t, id) => read('get', t, [id], () => db.get(t, id)),
    insert: (t, r) => w(t, () => db.insert(t, r)),
    insertMany: (t, r) => w(t, () => db.insertMany(t, r)),
    update: (t, id, p) => w(t, () => db.update(t, id, p)),
    updateMany: (t, r) => w(t, () => db.updateMany(t, r)),
    updateIfVersion: (t, id, v, p) => w(t, () => db.updateIfVersion(t, id, v, p)),
    delete: (t, id) => w(t, () => db.delete(t, id)),
    deleteMany: (t, ids) => w(t, () => db.deleteMany(t, ids)),
  }
}
