// For stores without SQL subqueries (the in-memory store, the Catalyst Data Store): an `inSelect` condition is
// answered by reading the inner rows first and matching their values — the same rows as Turso's IN (SELECT …).
import type { TableName } from './schema.gen'
import type { Row, SelectOptions, Value, Where } from './types'

export async function resolveSubselects(db: { select(table: TableName, o?: SelectOptions): Promise<Row[]> }, where: Where | undefined): Promise<Where | undefined> {
  if (!where) return where
  let out: Where | null = null
  for (const [k, v] of Object.entries(where)) {
    if (!v || typeof v !== 'object' || !('inSelect' in v)) continue
    const sub = v.inSelect
    const rows = await db.select(sub.table, { where: sub.where })
    out = { ...(out ?? where), [k]: { in: [...new Set(rows.map((r) => r[sub.column] as Value))] } }
  }
  return out ?? where
}
