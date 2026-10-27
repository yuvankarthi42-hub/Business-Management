// Small helpers shared by every module: units, enum codes, settings rows, number series, audit log.
import { r2 } from '@/core/pricing'
import type { ModuleKey } from '@/core/types'
import * as E from '../../../server/catalyst/enums'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { TableName } from '../db/schema.gen'
import { DuplicateError, type Db, type Row, type Value } from '../db/types'

export { E, r2 }

// ---------- units: the app works in rupees / quantities / percent, the tables in paise / thousandths / basis points ----------
export const toMinor = (rupees: number | null | undefined) => (rupees == null || Number.isNaN(rupees) ? null : Math.round(rupees * 100))
export const fromMinor = (v: Value | undefined) => (v == null ? 0 : r2(Number(v) / 100))
export const fromMinorOrNull = (v: Value | undefined) => (v == null ? null : r2(Number(v) / 100))
export const toMilli = (qty: number) => Math.round(qty * 1000)
export const fromMilli = (v: Value | undefined) => (v == null ? 0 : Math.round(Number(v)) / 1000)
export const toBp = (pct: number) => Math.round(pct * 100)
export const fromBp = (v: Value | undefined) => (v == null ? 0 : Number(v) / 100)

// ---------- enums ----------
type EnumMap = Record<string, number>
export function code<M extends EnumMap>(m: M, name: string | null | undefined): number {
  const c = name == null ? undefined : m[name as keyof M]
  if (c === undefined) throw new ApiError(`Unknown value: ${String(name)}`)
  return c
}
export const codeOrNull = <M extends EnumMap>(m: M, name: string | null | undefined) => (name == null ? null : code(m, name))
export function nameOf<M extends EnumMap>(m: M, c: Value | undefined): keyof M & string {
  const hit = Object.entries(m).find(([, v]) => v === Number(c))
  if (!hit) throw new Error(`Unknown code ${String(c)}`)
  return hit[0] as keyof M & string
}
export const nameOrNull = <M extends EnumMap>(m: M, c: Value | undefined) => (c == null ? null : nameOf(m, c))

// ---------- strings ----------
export const str = (v: Value | undefined) => (v == null ? '' : String(v))
export const strOrNull = (v: Value | undefined) => (v == null || v === '' ? null : String(v))
/** For unique keys built from names: lower-case, no quotes (ZCQL-safe), trimmed. */
export const keyPart = (s: string) => s.trim().toLowerCase().replace(/['"\\\s]+/g, ' ').slice(0, 80)
export const json = <T,>(v: Value | undefined, fallback: T): T => { if (v == null || v === '') return fallback; try { return JSON.parse(String(v)) as T } catch { return fallback } }
export const nowIso = () => new Date().toISOString()

// ---------- key / value settings ----------
export async function getSetting<T>(db: Db, businessId: string, key: string, fallback: T): Promise<T> {
  const r = await db.first('business_settings', { uniq_key: `${businessId}:${key}` })
  return r ? json(r.value_json, fallback) : fallback
}
export async function putSetting(db: Db, businessId: string, key: string, value: unknown, userId?: string | null) {
  const uniq = `${businessId}:${key}`
  const ex = await db.first('business_settings', { uniq_key: uniq })
  const value_json = JSON.stringify(value)
  if (ex) await db.update('business_settings', ex.ROWID, { value_json, updated_by: userId ?? null })
  else await db.insert('business_settings', { business_id: businessId, setting_key: key, value_json, uniq_key: uniq, updated_by: userId ?? null })
}
export async function getPlatformSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = await db.first('platform_settings', { setting_key: key })
  return r ? json(r.value_json, fallback) : fallback
}
export async function putPlatformSetting(db: Db, key: string, value: unknown, adminId?: string | null) {
  const ex = await db.first('platform_settings', { setting_key: key })
  const value_json = JSON.stringify(value)
  if (ex) await db.update('platform_settings', ex.ROWID, { value_json, updated_by: adminId ?? null })
  else await db.insert('platform_settings', { setting_key: key, value_json, updated_by: adminId ?? null })
}

// ---------- number series (bills, orders, KOTs, credit notes, tickets) ----------
export type SeqName = keyof typeof E.SequenceName
const seqKey = (businessId: string, branchId: string | null, name: SeqName) => `${businessId}:${branchId ?? 0}:${code(E.SequenceName, name)}:-`

export async function readSequence(db: Db, businessId: string, branchId: string | null, name: SeqName): Promise<Row | null> {
  return db.first('sequences', { uniq_key: seqKey(businessId, branchId, name) })
}
/** Create or change a series (Settings → Billing, branch bill prefix). */
export async function setSequence(db: Db, businessId: string, branchId: string | null, name: SeqName, patch: { prefix?: string; next?: number }) {
  const ex = await readSequence(db, businessId, branchId, name)
  const row = { ...(patch.prefix !== undefined ? { prefix: patch.prefix } : {}), ...(patch.next !== undefined ? { next_value: Math.max(1, Math.floor(patch.next)) } : {}) }
  if (ex) { if (Object.keys(row).length) await db.update('sequences', ex.ROWID, row); return }
  await db.insert('sequences', { business_id: businessId, branch_id: branchId, name: code(E.SequenceName, name), prefix: patch.prefix ?? '', next_value: Math.max(1, Math.floor(patch.next ?? 1)), uniq_key: seqKey(businessId, branchId, name) })
}
/**
 * Takes the next number of a series. Two counters billing at the same moment can't get the same number:
 * the row_version check lets only one of them win, the other reads again and takes the next one.
 */
export async function nextNumber(db: Db, businessId: string, branchId: string | null, name: SeqName, defaults: { prefix: string; start: number }) {
  // SQL databases: take the number in one statement (inside the bill's transaction, so nobody else can).
  if (db.sql) {
    const take = () => db.sql!('UPDATE "sequences" SET "next_value" = "next_value" + 1, "row_version" = "row_version" + 1, "updated_at" = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE "uniq_key" = ? RETURNING "prefix", "next_value" - 1 AS "n"', [seqKey(businessId, branchId, name)])
    let r = await take()
    if (!r.length) {
      try { await setSequence(db, businessId, branchId, name, { prefix: defaults.prefix, next: defaults.start }) } catch (e) { if (!(e instanceof DuplicateError)) throw e }
      r = await take()
    }
    if (r.length) { const n = Number(r[0].n); return { prefix: str(r[0].prefix as string), number: n, text: `${str(r[0].prefix as string)}${n}` } }
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    let row = await readSequence(db, businessId, branchId, name)
    if (!row) {
      try { await setSequence(db, businessId, branchId, name, { prefix: defaults.prefix, next: defaults.start }) } catch (e) { if (!(e instanceof DuplicateError)) throw e }
      row = await readSequence(db, businessId, branchId, name)
      if (!row) continue
    }
    const n = Number(row.next_value)
    if (await db.updateIfVersion('sequences', row.ROWID, Number(row.row_version), { next_value: n + 1 })) return { prefix: str(row.prefix), number: n, text: `${str(row.prefix)}${n}` }
  }
  throw new ApiError('Busy — please try again', 409, 'CONFLICT')
}

// ---------- modules ----------
/**
 * Is this module switched on for the shop of this request? (Settings → Modules.) Used to skip a module's database
 * work while it is off. No shop known (should not happen) → true, i.e. the work runs as before.
 */
export function moduleOn(c: Ctx, key: ModuleKey) {
  const b = c.session?.business
  return !b || !!b.modules?.[key]
}

// ---------- audit ----------
export async function audit(c: Ctx, entity: string, entityId: string | null, action: string, detail = '', branchId?: string | null) {
  const ent = (E.AuditEntity as Record<string, number>)[entity] ?? E.AuditEntity.settings
  const act = (E.AuditAction as Record<string, number>)[action] ?? E.AuditAction.update
  const s = c.session
  // Inside a transaction the rows are written together at the end (one round trip, same transaction).
  await c.auditRow({
    business_id: s!.business.id, branch_id: branchId ?? (s!.branchId !== 'all' ? s!.branchId : null), user_id: c.actorId,
    support_admin_id: s!.support?.adminId ?? null, entity: ent, entity_id: entityId && /^\d+$/.test(entityId) ? entityId : null, action: act,
    detail: `${action === 'update' || (E.AuditAction as Record<string, number>)[action] !== undefined ? '' : `${action}: `}${detail}`.slice(0, 255),
  })
}

/** Rows of a business-owned table, always filtered by the signed-in business (never trust ids from the browser). */
export async function own(c: Ctx, table: TableName, id: string | null | undefined, what = 'Not found'): Promise<Row> {
  if (!id || !/^\d+$/.test(String(id))) throw new ApiError(what, 404, 'NOT_FOUND')
  const r = await c.db.first(table, { ROWID: String(id), business_id: c.businessId })
  if (!r) throw new ApiError(what, 404, 'NOT_FOUND')
  return r
}
export const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)

// ---------- the shop's own calendar day (the server runs in UTC) ----------
/** 'YYYY-MM-DD' in the business's time zone. */
export function bizDay(c: Ctx, d = c.now) {
  const tz = c.session?.business.timezone || 'Asia/Kolkata'
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)!.value
  return `${g('year')}-${g('month')}-${g('day')}`
}
/** Start of the shop's day (midnight in its time zone) as an ISO timestamp. */
export function bizDayStart(c: Ctx, d = c.now) {
  const tz = c.session?.business.timezone || 'Asia/Kolkata'
  const day = bizDay(c, d)
  // Offset of the zone at that moment, e.g. +05:30 → 330 minutes.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d)
  const off = parts.find((x) => x.type === 'timeZoneName')?.value.match(/GMT([+-])(\d{2}):?(\d{2})?/)
  const mins = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] ?? 0)) : 0
  return new Date(Date.parse(`${day}T00:00:00Z`) - mins * 60_000).toISOString()
}
