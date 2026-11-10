// Order tracking for customers (QR menu "track" screen, "Track my order" by order number).
//  • The phone never asks on a timer: only when the customer opens the page, comes back to it or presses Refresh.
//  • Each answer is a snapshot in the shared cache. Every order / kitchen / payment change in the shop bumps the
//    shop's tracking version; a snapshot is used while the version is unchanged (and it is < 2 min old, in case a
//    cache write was lost), so a refresh normally costs no database read at all.
//  • "Notify me": after a change, subscribed orders are checked and the browser gets a push for the big steps.
import { randomBytes } from 'node:crypto'
import { trackStage, trackStamp, TRACK_WINDOW_MS, type TrackView } from '@/core/tracking'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { CANCEL_STATION, withItems } from './orders'
import { E, str } from './util'
import type { Row } from '../db/types'

const SNAP_MAX_AGE = 120_000
const verKey = (bid: string) => `trkv:${bid}`
const snapKey = (bid: string, oid: string) => `trk:${bid}:${oid}`
const pushOnKey = (bid: string) => `pushon:${bid}`

/** The customer's view of one order (status only — no customer name or phone). */
export async function buildView(c: Ctx, businessId: string, orderId: string): Promise<TrackView> {
  const rows = await c.db.select('orders', { where: { ROWID: orderId, business_id: businessId } })
  if (!rows[0]) throw new ApiError('Order not found', 404)
  let r = rows[0]
  const code = str(r.track_code) || null
  const reason = str(r.cancel_reason)
  const intoNumber = reason.startsWith('Merged into ') ? reason.slice(12).replace(/['"\\]/g, '') : null
  const into = intoNumber ? await c.db.first('orders', { business_id: businessId, order_number: intoNumber }) : null
  if (into) r = into
  const [o] = await withItems(c, [r])
  // A ticket that cancels items isn't food being made: it never shows as "preparing" to the customer.
  const kots = (await c.db.select('kitchen_tickets', { where: { business_id: businessId, order_id: r.ROWID } })).filter((k) => str(k.station) !== CANCEL_STATION).map((k) => Number(k.status))
  const table = r.table_id ? await c.db.get('dining_tables', str(r.table_id)) : null
  return {
    number: o.number, type: o.type, status: o.status, qrStatus: into ? 'accepted' : o.qrStatus ?? null, total: o.total, items: o.items, table: table ? str(table.label) : null,
    cancelReason: into ? null : o.cancelReason,
    kitchen: kots.length ? (kots.includes(E.KotStatus.new) ? 'new' : kots.includes(E.KotStatus.preparing) ? 'preparing' : kots.includes(E.KotStatus.ready) ? 'ready' : 'completed') : null,
    paymentStatus: o.paymentStatus, fulfilment: o.fulfilment ?? null, code,
  }
}

// ---------- Tracking links: a random code, never the order's row id ----------
/** 16 random bytes → 22 URL-safe characters. Unguessable, so nobody can count through other people's orders. */
export const TRACK_CODE = /^[A-Za-z0-9_-]{22}$/
export const newTrackCode = () => randomBytes(16).toString('base64url')

/**
 * The order a customer's link points to. A tracking code → that order. A bare row id (links made before codes) →
 * only a QR order, only inside the tracking window. Anything else → "Order not found". The answer is cached, so a
 * refresh stays free of database reads.
 */
export async function trackRef(c: Ctx, businessId: string, ref: string): Promise<string> {
  const isCode = TRACK_CODE.test(ref)
  if (!isCode && !/^\d{1,20}$/.test(ref)) throw new ApiError('Order not found', 404)
  const key = `trkref:${businessId}:${ref}`
  const hit = await c.shared.get(key)
  if (hit === '-') throw new ApiError('Order not found', 404)
  if (hit) return hit
  try { await c.useShop(businessId) } catch { throw new ApiError('Order not found', 404) }
  let id: string | null = null
  if (isCode) id = (await c.db.first('orders', { business_id: businessId, track_code: ref }))?.ROWID ?? null
  else {
    const r = await c.db.first('orders', { ROWID: ref, business_id: businessId })
    const fresh = r && Date.parse(str(r.CREATEDTIME)) >= c.now.getTime() - TRACK_WINDOW_MS
    id = r && fresh && Number(r.source) === E.OrderSource.qr ? r.ROWID : null
  }
  await c.shared.set(key, id ?? '-', id ? 24 : 1 / 12)
  if (!id) throw new ApiError('Order not found', 404)
  return id
}

/** The order's tracking code, made the first time it is asked for (counter orders tracked by number). */
export async function ensureTrackCode(c: Ctx, row: Row): Promise<string> {
  const have = str(row.track_code)
  if (TRACK_CODE.test(have)) return have
  const code = newTrackCode()
  await c.db.update('orders', row.ROWID, { track_code: code })
  return code
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
          JSON.stringify({ ...text, tag: `order-${oid}`, orderId: view.code || oid, businessId: bid, stage })).catch(() => ({ ok: false, gone: false, status: 0 }))
        if (r.gone) { await c.db.delete('push_subscriptions', s.ROWID); continue }
      }
      if (done) await c.db.delete('push_subscriptions', s.ROWID)
      else await c.db.update('push_subscriptions', s.ROWID, { last_stamp: stamp })
    }
  }
}

/** Marks the shop as having push subscribers (so changes in shops without any cost nothing extra). */
export async function markPushOn(c: Ctx, bid: string) { await c.shared.set(pushOnKey(bid), '1', 24) }

/**
 * At most `max` calls a minute from one address. The count is added atomically, so calls sent at the same moment are
 * all counted. The address comes from core/clientIp.ts (not from a header the visitor can set).
 */
export async function countIn(c: Ctx, key: string, minutes: number): Promise<number> {
  const win = minutes * 60_000
  return c.shared.incr(`cnt:${key}:${Math.floor(Date.now() / win)}`, (minutes * 2) / 60)
}

/** At most `max` in a window of `minutes` for this key (atomic; not per address unless the key says so). */
export async function limitIn(c: Ctx, key: string, max: number, minutes: number, message: string) {
  if ((await countIn(c, key, minutes)) > max) throw new ApiError(message, 429, 'RATE_LIMITED')
}

export async function rateLimit(c: Ctx, what: string, max: number, message: string, per = 'ip') {
  const who = per === 'ip' ? c.ip || 'unknown' : per
  const n = await c.shared.incr(`rl:${what}:${who}:${Math.floor(Date.now() / 60_000)}`, 1 / 30)
  if (n > max) throw new ApiError(message, 429, 'RATE_LIMITED')
}
