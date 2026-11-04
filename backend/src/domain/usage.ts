// Bill counts per shop for Admin → Usage. With one database per shop (Turso) reading every shop on each visit is
// a request per shop, so the daily job counts them once (one query per shop) and keeps the result in the shared
// cache; Admin → Usage reads that copy. One database for all shops (Catalyst Data Store) reads live (one query
// per 100 shops already).
import type { Ctx } from '../core/context'
import { acrossShops } from './directory'
import { E } from './util'

/** Completed bills in the last 7 / 30 days, sales in 30 days (paise), last bill time. */
export interface ShopUsage { b7: number; b30: number; s30: number; last: string | null }

const DAY = 86_400_000
const KEY = 'admin:usage'
const iso = (ms: number) => new Date(ms).toISOString()

/** Every shop, read live: 3 small GROUP BY reads (what Admin → Usage always did). */
export async function liveUsage(c: Ctx, ids: string[]): Promise<Map<string, ShopUsage>> {
  const now = c.now.getTime()
  const completed = { status: E.OrderStatus.completed }
  const [b30, b7, lastBills] = await Promise.all([
    acrossShops(c, ids, 'orders', { where: { ...completed, billed_at: { gte: iso(now - 30 * DAY) } }, fns: { n: ['COUNT', 'ROWID'], sales: ['SUM', 'total_minor'] } }),
    acrossShops(c, ids, 'orders', { where: { ...completed, billed_at: { gte: iso(now - 7 * DAY) } }, fns: { n: ['COUNT', 'ROWID'] } }),
    acrossShops(c, ids, 'orders', { where: completed, fns: { last: ['MAX', 'billed_at'] } }),
  ])
  const out = new Map<string, ShopUsage>(ids.map((id) => [id, { b7: 0, b30: 0, s30: 0, last: null }]))
  for (const r of b30) { const u = out.get(String(r.business_id)); if (u) { u.b30 = Number(r.n ?? 0); u.s30 = Number(r.sales ?? 0) } }
  for (const r of b7) { const u = out.get(String(r.business_id)); if (u) u.b7 = Number(r.n ?? 0) }
  for (const r of lastBills) { const u = out.get(String(r.business_id)); if (u) u.last = r.last == null ? null : String(r.last) }
  return out
}

/** One shop's counts as one SQL statement (to send together with other reads in one round trip). */
export function usageQuery(c: Ctx, bid: string) {
  const now = c.now.getTime()
  const done = `"business_id" = ? AND "status" = ?`
  const args = [Number(bid), E.OrderStatus.completed]
  return {
    sql: `SELECT
    (SELECT COUNT(*) FROM "orders" WHERE ${done} AND "billed_at" >= ?) AS b30,
    (SELECT SUM("total_minor") FROM "orders" WHERE ${done} AND "billed_at" >= ?) AS s30,
    (SELECT COUNT(*) FROM "orders" WHERE ${done} AND "billed_at" >= ?) AS b7,
    (SELECT MAX("billed_at") FROM "orders" WHERE ${done}) AS last`,
    args: [...args, iso(now - 30 * DAY), ...args, iso(now - 30 * DAY), ...args, iso(now - 7 * DAY), ...args] as (string | number)[],
  }
}
export const usageFromRow = (r: Record<string, unknown> | undefined): ShopUsage =>
  ({ b30: Number(r?.b30 ?? 0), s30: Number(r?.s30 ?? 0), b7: Number(r?.b7 ?? 0), last: r?.last == null ? null : String(r.last) })

/** Adds some shops' fresh counts to the daily copy (the rest keep theirs). `at` = when this round of counting began. */
export async function mergeUsageCopy(c: Ctx, at: string, shops: Map<string, ShopUsage>) {
  if (!shops.size) return
  const copy = await readUsageCopy(c)
  const all = copy?.shops ?? new Map<string, ShopUsage>()
  for (const [id, u] of shops) all.set(id, u)
  await saveUsageCopy(c, at, all)
}

/** The daily copy: when it was counted and each shop's counts. Null = none (first day, or the cache was cleared). */
export async function readUsageCopy(c: Ctx): Promise<{ at: string; shops: Map<string, ShopUsage> } | null> {
  const raw = await c.shared.get(KEY).catch(() => null)
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { at: string; shops: Record<string, [number, number, number, string | null]> }
    return { at: o.at, shops: new Map(Object.entries(o.shops).map(([id, [b7, b30, s30, last]]) => [id, { b7, b30, s30, last }])) }
  } catch { return null }
}
export async function saveUsageCopy(c: Ctx, at: string, shops: Map<string, ShopUsage>) {
  const o = { at, shops: Object.fromEntries([...shops].map(([id, u]) => [id, [u.b7, u.b30, u.s30, u.last]])) }
  await c.shared.set(KEY, JSON.stringify(o), 48).catch((e) => console.error('[usage copy]', e))
}

/**
 * Counts for Admin → Usage and when they were counted. Turso: the daily copy (shops added since are read live);
 * no copy yet → read live once and keep it. One database for all shops: live, as before.
 */
export async function usageFor(c: Ctx, ids: string[]): Promise<{ at: string; shops: Map<string, ShopUsage> }> {
  if (!c.dbs.perShop) return { at: c.now.toISOString(), shops: await liveUsage(c, ids) }
  const copy = await readUsageCopy(c)
  if (!copy) {
    const shops = await liveUsage(c, ids)
    await saveUsageCopy(c, c.now.toISOString(), shops)
    return { at: c.now.toISOString(), shops }
  }
  const missing = ids.filter((id) => !copy.shops.has(id))
  if (missing.length) for (const [id, u] of await liveUsage(c, missing)) copy.shops.set(id, u)
  return copy
}
