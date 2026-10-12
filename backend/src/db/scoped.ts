// A Db handle limited to the tables of one kind of database. With one database per shop, a query on the
// wrong handle would look in the wrong database — this turns that mistake into a clear error everywhere,
// including the single-database setups (Catalyst, tests) where it would otherwise go unnoticed.
import type { DbKind } from './migrate'
import { PLATFORM_TABLES, SHARED_TABLES, TABLES, type TableName } from './schema.gen'
import type { Db } from './types'

const ALL = Object.keys(TABLES) as TableName[]
const ON: Record<DbKind, Set<string>> = {
  platform: new Set([...PLATFORM_TABLES, ...SHARED_TABLES]),
  shop: new Set(ALL.filter((t) => !PLATFORM_TABLES.includes(t))),
}
export const tablesOf = (kind: DbKind) => ALL.filter((t) => ON[kind].has(t))
export const isOn = (kind: DbKind, table: TableName) => ON[kind].has(table)

export function scoped(db: Db, kind: DbKind): Db {
  const check = (t: TableName) => {
    if (!ON[kind].has(t)) throw new Error(`Table ${t} is not in the ${kind} database — use ${kind === 'platform' ? 'c.db (the shop database)' : 'c.platform'}`)
  }
  return {
    inTransaction: db.inTransaction,
    transaction: (fn) => db.transaction((tx) => fn(scoped(tx, kind))),
    ...(db.sql ? { sql: (s: string, a?: (string | number | null)[]) => db.sql!(s, a) } : {}),
    ...(db.sqlMany ? { sqlMany: (x: { sql: string; args?: (string | number | null)[] }[]) => db.sqlMany!(x) } : {}),
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
  const wrote = (t: TableName) => { if (MEMO.has(t)) for (const k of [...memo.keys()]) if (k.split('|')[1] === t) memo.delete(k) }
  const w = <T>(t: TableName, run: () => Promise<T>) => { wrote(t); return run() }
  return {
    ...db,
    transaction: (fn) => db.transaction((tx) => fn(memoized(tx, memo))),
    select: (t, o) => read('select', t, [o], () => db.select(t, o)),
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
