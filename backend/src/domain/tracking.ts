// Order tracking for customers (QR menu "track" screen, "Track my order" by order number).
//  • The phone never asks on a timer: only when the customer opens the page, comes back to it or presses Refresh.
//  • Each answer is a snapshot in the shared cache. Every order / kitchen / payment change in the shop bumps the
//    shop's tracking version; a snapshot is used while the version is unchanged (and it is < 2 min old, in case a
//    cache write was lost), so a refresh normally costs no database read at all.
//  • "Notify me": after a change, subscribed orders are checked and the browser gets a push for the big steps.
import { trackStage, trackStamp, type TrackView } from '@/core/tracking'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { withItems } from './orders'
import { E, str } from './util'

const SNAP_MAX_AGE = 120_000
const verKey = (bid: string) => `trkv:${bid}`
const snapKey = (bid: string, oid: string) => `trk:${bid}:${oid}`
const pushOnKey = (bid: string) => `pushon:${bid}`

/** The customer's view of one order (status only — no customer name or phone). */
export async function buildView(c: Ctx, businessId: string, orderId: string): Promise<TrackView> {
  const rows = await c.db.select('orders', { where: { ROWID: orderId, business_id: businessId } })
  if (!rows[0]) throw new ApiError('Order not found', 404)
  let r = rows[0]
  const reason = str(r.cancel_reason)
  const intoNumber = reason.startsWith('Merged into ') ? reason.slice(12).replace(/['"\\]/g, '') : null
  const into = intoNumber ? await c.db.first('orders', { business_id: businessId, order_number: intoNumber }) : null
  if (into) r = into
  const [o] = await withItems(c, [r])
  const kots = (await c.db.select('kitchen_tickets', { where: { business_id: businessId, order_id: r.ROWID } })).map((k) => Number(k.status))
  const table = r.table_id ? await c.db.get('dining_tables', str(r.table_id)) : null
  return {
    number: o.number, type: o.type, status: o.status, qrStatus: into ? 'accepted' : o.qrStatus ?? null, total: o.total, items: o.items, table: table ? str(table.label) : null,
    cancelReason: into ? null : o.cancelReason,
    kitchen: kots.length ? (kots.includes(E.KotStatus.new) ? 'new' : kots.includes(E.KotStatus.preparing) ? 'preparing' : kots.includes(E.KotStatus.ready) ? 'ready' : 'completed') : null,
    paymentStatus: o.paymentStatus, fulfilment: o.fulfilment ?? null,
  }
}

/** Snapshot from the cache when nothing in the shop changed since; otherwise read once and keep it. */
export async function trackedView(c: Ctx, businessId: string, orderId: string): Promise<TrackView & { checkedAt: string; cached: boolean }> {
  // Customers are following orders of this shop: live "your order changed" events are worth sending (app.ts).
  if (c.events) await c.shared.set(`trk:open:${businessId}`, '1', 2)
  const [ver, raw] = await Promise.all([c.shared.get(verKey(businessId)), c.shared.get(snapKey(businessId, orderId))])
  if (raw) {
    try {
      const snap = JSON.parse(raw) as { v: string | null; at: number; view: TrackView }
      if (snap.v === ver && Date.now() - snap.at < SNAP_MAX_AGE) return { ...snap.view, checkedAt: new Date(snap.at).toISOString(), cached: true }
    } catch { /* rebuild */ }
  }
  try { await c.useShop(businessId) } catch { throw new ApiError('Order not found', 404) }
  const view = await buildView(c, businessId, orderId)
  const at = Date.now()
  await c.shared.set(snapKey(businessId, orderId), JSON.stringify({ v: ver, at, view }), 24)
  return { ...view, checkedAt: new Date(at).toISOString(), cached: false }
}

/** Order, kitchen, payment and table changes call this (app.ts) once they are saved. */
export async function afterOrderWrite(c: Ctx) {
  const bid = c.shopId
  if (!bid) return
  await c.shared.set(verKey(bid), Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 24)
  if (c.push && await c.shared.get(pushOnKey(bid))) await notifySubscribers(c, bid)
}

const PUSH_TEXT: Partial<Record<ReturnType<typeof trackStage>, (n: string, v: TrackView) => { title: string; body: string }>> = {
  confirmed: (n) => ({ title: `Order ${n} confirmed`, body: 'The shop has your order.' }),
  ready: (n, v) => ({ title: `Order ${n} is ready`, body: v.type === 'delivery' ? 'Packed — out for delivery soon.' : v.type === 'takeaway' ? 'Ready for pickup.' : 'Serving now.' }),
  rejected: (n, v) => ({ title: `Order ${n} not accepted`, body: v.cancelReason ? `${v.cancelReason}. Please talk to the staff.` : 'Please talk to the staff.' }),
}

/** Sends a push to each subscribed order whose status moved since the last one. Finished orders are unsubscribed. */
export async function notifySubscribers(c: Ctx, bid: string) {
  const now = c.now.toISOString()
  const subs = await c.db.select('push_subscriptions', { where: { business_id: bid, expires_at: { gt: now } }, limit: 200 })
  if (!subs.length) return
  const byOrder = new Map<string, typeof subs>()
  for (const s of subs) byOrder.set(str(s.order_id), [...(byOrder.get(str(s.order_id)) ?? []), s])
  for (const [oid, list] of byOrder) {
    let view: TrackView
    try { view = await buildView(c, bid, oid) } catch { await c.db.deleteMany('push_subscriptions', list.map((s) => s.ROWID)); continue }
    const stamp = trackStamp(view)
    const stage = trackStage(view)
    const text = PUSH_TEXT[stage]?.(view.number, view)
    const done = stage === 'rejected' || stage === 'done'
    for (const s of list) {
      if (str(s.last_stamp) === stamp) continue
      if (text) {
        const r = await c.push!.send({ endpoint: str(s.endpoint), p256dh: str(s.p256dh), auth: str(s.auth_secret) },
          JSON.stringify({ ...text, tag: `order-${oid}`, orderId: oid, businessId: bid, stage })).catch(() => ({ ok: false, gone: false, status: 0 }))
        if (r.gone) { await c.db.delete('push_subscriptions', s.ROWID); continue }
      }
      if (done) await c.db.delete('push_subscriptions', s.ROWID)
      else await c.db.update('push_subscriptions', s.ROWID, { last_stamp: stamp })
    }
  }
}

/** Marks the shop as having push subscribers (so changes in shops without any cost nothing extra). */
export async function markPushOn(c: Ctx, bid: string) { await c.shared.set(pushOnKey(bid), '1', 24) }

/** At most `max` calls a minute from one address (approximate; the cache is the only store). */
export async function rateLimit(c: Ctx, what: string, max: number, message: string) {
  const key = `rl:${what}:${c.ip || 'unknown'}:${Math.floor(Date.now() / 60_000)}`
  const n = Number(await c.shared.get(key)) || 0
  if (n >= max) throw new ApiError(message, 429, 'RATE_LIMITED')
  await c.shared.set(key, String(n + 1), 1)
}
