// Loyalty points ⇄ customer_points (history) + customers.points_balance (quick reads).
// Every change is one history row with the balance after it; earned rows keep `remaining`, used oldest first,
// so expiry only removes points that were never used.
import { pointsExpiry, type DEFAULT_LOYALTY } from '@/core/loyalty'
import type { PointsEntry } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { Db, Row } from '../db/types'
import { bizDay, E, nameOf, str, strOrNull } from './util'

type Settings = typeof DEFAULT_LOYALTY
type Kind = keyof typeof E.PointsKind
const ADDS: Kind[] = ['earn', 'cancel', 'adjust']

export function pointsFrom(r: Row, ref = ''): PointsEntry {
  return {
    id: r.ROWID, customerId: str(r.customer_id), orderId: strOrNull(r.order_id), ref, kind: nameOf(E.PointsKind, r.kind) as PointsEntry['kind'],
    points: Number(r.points), balanceAfter: Number(r.balance_after), expiresOn: strOrNull(r.expires_on), note: str(r.note), createdAt: r.CREATEDTIME,
  }
}

/**
 * Adds (points > 0) or takes (points < 0) points for a customer. `cap` takes at most the balance instead of failing
 * (a return can't make the balance negative). Returns the points actually moved and the new balance.
 */
export async function movePoints(c: Ctx, customerId: string, kind: Kind, points: number, opts: { orderId?: string | null; returnId?: string | null; note?: string; settings?: Settings; cap?: boolean } = {}) {
  if (!Number.isInteger(points) || points === 0) return { moved: 0, balance: null as number | null }
  for (let attempt = 0; attempt < 6; attempt++) {
    const cu = await c.db.first('customers', { ROWID: customerId, business_id: c.businessId })
    if (!cu) throw new ApiError('Customer not found')
    const bal = Number(cu.points_balance ?? 0)
    let move = points
    if (move < 0 && bal + move < 0) {
      if (!opts.cap) throw new ApiError(`The customer has only ${bal} points`)
      move = -bal
    }
    if (move === 0) return { moved: 0, balance: bal }
    const next = bal + move
    if (!(await c.db.updateIfVersion('customers', cu.ROWID, Number(cu.row_version), { points_balance: next }))) continue
    const adds = move > 0 && ADDS.includes(kind)
    if (move < 0) await consume(c, customerId, -move)
    await c.db.insert('customer_points', {
      business_id: c.businessId, branch_id: c.session ? c.writeBranch({ fallback: true }) : null, customer_id: customerId,
      order_id: opts.orderId ?? null, return_id: opts.returnId ?? null, kind: E.PointsKind[kind], points: move, balance_after: next,
      remaining: adds ? move : 0, expires_on: adds && kind === 'earn' && opts.settings ? pointsExpiry(opts.settings, bizDay(c)) : null,
      note: String(opts.note ?? '').slice(0, 150) || null, created_by: c.session ? c.actorId : null,
    })
    return { moved: move, balance: next }
  }
  throw new ApiError('Busy — please try again', 409, 'CONFLICT')
}

/** Use up earned points oldest first (soonest expiry first). */
async function consume(c: Ctx, customerId: string, points: number) {
  const rows = (await c.db.select('customer_points', { where: { business_id: c.businessId, customer_id: customerId, remaining: { gt: 0 } } }))
    .sort((a, b) => (str(a.expires_on) || '9999').localeCompare(str(b.expires_on) || '9999') || Number(a.ROWID) - Number(b.ROWID))
  let left = points
  const updates: { ROWID: string; remaining: number }[] = []
  for (const r of rows) {
    if (left <= 0) break
    const take = Math.min(left, Number(r.remaining))
    updates.push({ ROWID: r.ROWID, remaining: Number(r.remaining) - take })
    left -= take
  }
  if (updates.length) await c.db.updateMany('customer_points', updates)
}

/**
 * Daily: points earned that passed their expiry date and were never used. Returns how many points expired.
 * Each customer is done in one transaction that reads the expired rows again inside it, so a crash rolls the
 * customer back whole, and a second run at the same time (cron retry) finds nothing left to take — no double take.
 */
export async function expirePoints(db: Db, businessId: string, today: string) {
  const due = await db.select('customer_points', { where: { business_id: businessId, remaining: { gt: 0 }, expires_on: { lt: today } } })
  const customers = [...new Set(due.map((r) => str(r.customer_id)))]
  let total = 0
  for (const customerId of customers) {
    total += await db.transaction(async (t) => {
      // Read again inside the transaction: what is still unexpired right now (another run may have taken it).
      const rows = await t.select('customer_points', { where: { business_id: businessId, customer_id: customerId, remaining: { gt: 0 }, expires_on: { lt: today } } })
      const pts = rows.reduce((a, r) => a + Number(r.remaining), 0)
      if (pts <= 0) return 0
      const cu = await t.first('customers', { ROWID: customerId, business_id: businessId })
      if (!cu) return 0
      // Zero the expired rows first so the expiry doesn't eat newer points.
      await t.updateMany('customer_points', rows.map((r) => ({ ROWID: r.ROWID, remaining: 0 })))
      const take = Math.min(pts, Number(cu.points_balance ?? 0))
      if (take <= 0) return 0
      const next = Number(cu.points_balance) - take
      if (!(await t.updateIfVersion('customers', cu.ROWID, Number(cu.row_version), { points_balance: next }))) throw new Error('points changed — retried next run')
      await t.insert('customer_points', { business_id: businessId, customer_id: customerId, kind: E.PointsKind.expire, points: -take, balance_after: next, remaining: 0, note: 'Expired' })
      return take
    }).catch((e) => { console.error('[expirePoints]', customerId, (e as Error).message); return 0 })
  }
  return total
}
