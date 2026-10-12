// Schema check: compares the tables that exist with server/catalyst/schema.sql (via the generated list).
//   Catalyst Data Store — run it after creating the tables in the console: it lists what is missing or different.
//   Turso — checks the platform database, and how many shop databases are ready / on the newest migration.
import type { Env } from '../../core/context'
import { ApiError } from '../../core/errors'
import { adminRead, define } from '../../core/registry'
import { latestVersion } from '../../db/migrate'
import { tablesOf } from '../../db/scoped'
import { TABLES, type ColumnDef } from '../../db/schema.gen'
import type { Db, SchemaInfo } from '../../db/types'
import { E, nameOf } from '../../domain/util'

const SQLITE_TYPE: Record<ColumnDef['type'], string> = {
  varchar: 'text', text: 'text', encrypted: 'text', datetime: 'text', date: 'text', bigint: 'integer', int: 'integer', boolean: 'integer', fk: 'integer', id: 'integer', double: 'real',
}

/** Catalyst's names for our column types (the console shows these in "Data Type"). */
const CATALYST_TYPE: Record<ColumnDef['type'], string[]> = {
  varchar: ['varchar'], text: ['text'], encrypted: ['encrypted text', 'encrypted', 'encryptedtext'], bigint: ['bigint'], int: ['int', 'integer'],
  double: ['double'], boolean: ['boolean'], datetime: ['datetime'], date: ['date'], fk: ['foreign key', 'foreignkey', 'fk'], id: ['bigint'],
}

export interface SchemaReport {
  ok: boolean
  tables: number
  missingTables: string[]
  missingColumns: { table: string; column: string; type: string }[]
  wrongType: { table: string; column: string; want: string; got: string }[]
  /** Settings that matter for correctness: unique keys and mandatory columns. */
  wrongRules: { table: string; column: string; want: string; got: string }[]
}

export async function checkSchema(env: Pick<Env, 'dbs'>): Promise<SchemaReport & { shops?: Record<string, number>; shopsBehind?: number; latest?: string }> {
  const db = await env.dbs.platform()
  if (!env.dbs.perShop) return checkCatalyst(db)
  const live = await db.describe!()
  const byName = new Map(live.tables.map((t) => [t.name, new Map(t.columns.map((c) => [c.name, c]))]))
  const rep: SchemaReport = { ok: true, tables: 0, missingTables: [], missingColumns: [], wrongType: [], wrongRules: [] }
  for (const table of tablesOf('platform')) {
    rep.tables++
    const have = byName.get(table)
    if (!have) { rep.missingTables.push(table); continue }
    for (const c of TABLES[table] as readonly ColumnDef[]) {
      const got = have.get(c.name)
      if (!got) rep.missingColumns.push({ table, column: c.name, type: c.type })
      else if (got.type !== SQLITE_TYPE[c.type]) rep.wrongType.push({ table, column: c.name, want: SQLITE_TYPE[c.type], got: got.type })
    }
  }
  const rows = await db.select('shop_databases')
  const shops: Record<string, number> = {}
  for (const r of rows) { const k = nameOf(E.ShopDbStatus, r.status); shops[k] = (shops[k] ?? 0) + 1 }
  const latest = latestVersion('shop')
  const shopsBehind = rows.filter((r) => Number(r.status) === E.ShopDbStatus.ready && r.schema_version !== latest).length
  rep.ok = !rep.missingTables.length && !rep.missingColumns.length && !rep.wrongType.length && !shops.failed
  return { ...rep, shops, shopsBehind, latest }
}

async function checkCatalyst(db: Db): Promise<SchemaReport> {
  if (!db.describe) throw new ApiError('Schema check is not available for this database')
  const live: SchemaInfo = await db.describe()
  const byName = new Map(live.tables.map((t) => [t.name, new Map(t.columns.map((c) => [c.name, c]))]))
  const rep: SchemaReport = { ok: true, tables: Object.keys(TABLES).length, missingTables: [], missingColumns: [], wrongType: [], wrongRules: [] }
  for (const [table, cols] of Object.entries(TABLES) as [string, readonly ColumnDef[]][]) {
    const have = byName.get(table)
    if (!have) { rep.missingTables.push(table); continue }
    for (const c of cols) {
      const got = have.get(c.name)
      if (!got) { rep.missingColumns.push({ table, column: c.name, type: c.type }); continue }
      if (!CATALYST_TYPE[c.type].includes(got.type.replace(/_/g, ' '))) rep.wrongType.push({ table, column: c.name, want: CATALYST_TYPE[c.type][0], got: got.type })
      if (c.unique && !got.unique) rep.wrongRules.push({ table, column: c.name, want: 'IsUnique on', got: 'IsUnique off' })
      if (c.mandatory && !got.mandatory) rep.wrongRules.push({ table, column: c.name, want: 'IsMandatory on', got: 'IsMandatory off' })
    }
  }
  rep.ok = !rep.missingTables.length && !rep.missingColumns.length && !rep.wrongType.length && !rep.wrongRules.length
  return rep
}

define('admin', {
  schemaCheck: adminRead('pricing.manage', async (c) => checkSchema(c)),
})
