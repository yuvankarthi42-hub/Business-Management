// Column metadata from the generated schema + value conversion between JavaScript and the Data Store.
import { ApiError } from '../core/errors'
import { TABLES, type ColumnDef, type TableName } from './schema.gen'
import type { NewRow, Row, Value } from './types'

const SYSTEM: Record<string, ColumnDef> = {
  ROWID: { name: 'ROWID', type: 'fk', mandatory: false, unique: true, search: false, pii: false },
  CREATORID: { name: 'CREATORID', type: 'fk', mandatory: false, unique: false, search: false, pii: false },
  CREATEDTIME: { name: 'CREATEDTIME', type: 'datetime', mandatory: false, unique: false, search: false, pii: false },
  MODIFIEDTIME: { name: 'MODIFIEDTIME', type: 'datetime', mandatory: false, unique: false, search: false, pii: false },
}
const byTable = new Map<string, Map<string, ColumnDef>>()
for (const [t, cols] of Object.entries(TABLES)) byTable.set(t, new Map([...Object.entries(SYSTEM), ...(cols as readonly ColumnDef[]).map((c) => [c.name, c] as const)]))

export function column(table: TableName, name: string): ColumnDef {
  const c = byTable.get(table)?.get(name)
  if (!c) throw new Error(`Unknown column ${table}.${name}`)
  return c
}
export const columns = (table: TableName) => [...byTable.get(table)!.values()]

/** Catalyst DATETIME ↔ ISO. We always write UTC; system columns use the project time zone (CATALYST_TZ_OFFSET_MIN). */
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
export function toDsDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new ApiError('Invalid date')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
export function fromDsDateTime(v: string, system = false): string {
  // '2026-10-12 09:30:00' or '2026-10-12 09:30:00:123' (system columns add milliseconds)
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[:.](\d{1,3}))?/)
  if (!m) return v
  const [, y, mo, d, h, mi, s, ms] = m
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.padEnd(3, '0') : 0)
  if (system) t -= Number(process.env.CATALYST_TZ_OFFSET_MIN ?? 0) * 60_000
  return new Date(t).toISOString()
}

/** JavaScript value → what we send to the Data Store. */
export function toDs(table: TableName, name: string, v: Value | undefined): Value | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const c = column(table, name)
  switch (c.type) {
    case 'int': case 'bigint': {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${table}.${name} must be a whole number (got ${v})`)
      return n
    }
    case 'double': return Number(v)
    case 'boolean': return v === true || v === 'true'
    case 'datetime': return toDsDateTime(String(v))
    case 'date': {
      const s = String(v)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${table}.${name} must be YYYY-MM-DD`)
      return s
    }
    case 'fk': case 'id': return String(v)
    default: {
      const s = String(v)
      if (c.maxLength && s.length > c.maxLength) throw new ApiError(`Too long (${c.maxLength} characters at most)`)
      if ((c.type === 'text' || c.type === 'encrypted') && s.length > 10_000) throw new ApiError('Text is too long (10,000 characters at most)')
      return s
    }
  }
}

/** Data Store value (ZCQL returns most values as strings) → JavaScript. */
export function fromDs(table: TableName, name: string, v: unknown): Value {
  if (v === null || v === undefined || v === '') {
    const c = byTable.get(table)?.get(name)
    return c && (c.type === 'varchar' || c.type === 'text') && v === '' ? '' : null
  }
  const c = byTable.get(table)?.get(name)
  if (!c) return v as Value
  switch (c.type) {
    case 'int': case 'bigint': case 'double': return Number(v)
    case 'boolean': return v === true || v === 'true' || v === 1 || v === '1'
    case 'datetime': return fromDsDateTime(String(v), name === 'CREATEDTIME' || name === 'MODIFIEDTIME')
    case 'fk': case 'id': return String(v)
    default: return String(v)
  }
}

export function rowFromDs(table: TableName, raw: Record<string, unknown>): Row {
  const out: Record<string, Value> = {}
  for (const [k, v] of Object.entries(raw)) if (byTable.get(table)?.has(k)) out[k] = fromDs(table, k, v)
  return out as Row
}

/** Applies defaults and type checks for an insert (mirrors the Data Store's own column rules). */
export function rowToDs(table: TableName, row: NewRow, forInsert: boolean): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'CREATEDTIME' || k === 'MODIFIEDTIME' || k === 'CREATORID') continue
    if (!byTable.get(table)?.has(k)) throw new Error(`Unknown column ${table}.${k}`)
    const x = toDs(table, k, v)
    if (x !== undefined) out[k] = x
  }
  if (forInsert) {
    for (const c of columns(table)) {
      if (c.name in SYSTEM) continue
      if (out[c.name] === undefined && c.default !== undefined) out[c.name] = toDs(table, c.name, c.type === 'boolean' ? c.default === 'true' : c.type === 'int' || c.type === 'bigint' ? Number(c.default) : c.default) as Value
      if (c.mandatory && (out[c.name] === undefined || out[c.name] === null)) throw new Error(`${table}.${c.name} is required`)
    }
  }
  return out
}
