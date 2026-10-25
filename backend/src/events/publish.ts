// The API's side of the event hub: after a request's changes are saved, its events are posted to the hub
// (one small server-to-server call, no database). If the hub is down nothing is lost: the change is already in
// the database and in the change feed, and screens catch up when they reconnect.
import type { Ctx } from '../core/context'
import type { KitchenTicket, Order } from '@/core/types'
import { kotsFrom, loadOrder } from '../domain/orders'
import { str } from '../domain/util'
import type { Hub, HubEvent } from './hub'

export interface EventSink { publish(events: HubEvent[]): Promise<void> }

/** Production: the hub on Catalyst AppSail (EVENTS_URL, EVENTS_SECRET). */
export class HttpSink implements EventSink {
  /** After a failure the hub is skipped for 30 s, so a hub outage never slows down billing. */
  private downUntil = 0
  constructor(private url: string, private secret: string) {}
  async publish(events: HubEvent[]) {
    if (Date.now() < this.downUntil) return
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 800)
    try {
      const r = await fetch(`${this.url.replace(/\/$/, '')}/publish`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-events-secret': this.secret }, body: JSON.stringify({ events }) })
      if (!r.ok) throw new Error(`hub answered ${r.status}`)
    } catch (e) { this.downUntil = Date.now() + 30_000; throw e } finally { clearTimeout(t) }
  }
}
/** Local server and tests: the hub runs in the same process. */
export class LocalSink implements EventSink {
  constructor(private hub: Hub) {}
  async publish(events: HubEvent[]) { this.hub.publish(events) }
}

export function sinkFromEnv(): EventSink | null {
  const url = process.env.EVENTS_URL, secret = process.env.EVENTS_SECRET
  return url && secret && secret.length >= 16 ? new HttpSink(url, secret) : null
}

/** Lists the screens update in place, from these actions' results (anything else: refresh as before). */
const ORDER_RESULT = new Set(['orders.checkout', 'orders.settle', 'orders.cancel'])
const ORDER_ARG = new Set(['orders.setFulfilment', 'orders.sendToKitchen', 'qr.accept', 'qr.reject'])
const MAX_RECORDS_BYTES = 64 * 1024

/** The orders (and all of their kitchen tickets) an action changed, read once after the save. */
export async function recordsFor(c: Ctx, name: string, args: unknown[], data: unknown): Promise<{ orders: Order[]; kots: KitchenTicket[] } | undefined> {
  let orders: Order[] = []
  if (name === 'orders.save') { const o = (data as { order?: Order } | null)?.order; if (o) orders = [o] }
  else if (ORDER_RESULT.has(name)) { if (data && typeof data === 'object' && 'id' in (data as object)) orders = [data as Order] }
  else if (ORDER_ARG.has(name)) orders = [(await loadOrder(c, String(args[0]), { inScope: false })).order]
  else if (name === 'public.placeOrder') { const id = (data as { orderId?: string } | null)?.orderId; if (id) orders = [(await loadOrder(c, id, { inScope: false })).order] }
  else if (name === 'kitchen.setStatus') {
    const k = await c.db.first('kitchen_tickets', { ROWID: String(args[0]), business_id: c.businessId })
    if (!k) return undefined
    orders = [(await loadOrder(c, str(k.order_id), { inScope: false })).order]
  } else return undefined
  if (!orders.length) return undefined
  const rows = await c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: { in: orders.map((o) => o.id) } } })
  const out = { orders, kots: await kotsFrom(c, rows) }
  return JSON.stringify(out).length <= MAX_RECORDS_BYTES ? out : undefined
}

/** Just the ids of the orders an action changed (for customers' tracking pages) — from the result when possible. */
export async function orderIdsFor(c: Ctx, name: string, args: unknown[], data: unknown): Promise<string[]> {
  if (name === 'orders.save') { const o = (data as { order?: Order } | null)?.order; return o ? [o.id] : [] }
  if (ORDER_RESULT.has(name)) return data && typeof data === 'object' && 'id' in (data as object) ? [String((data as Order).id)] : []
  if (ORDER_ARG.has(name)) return [String(args[0])]
  if (name === 'kitchen.setStatus') { const k = await c.db.first('kitchen_tickets', { ROWID: String(args[0]), business_id: c.businessId }); return k ? [str(k.order_id)] : [] }
  return []
}

/** Sends the request's events. Never fails the request. */
export async function flushEvents(c: Ctx, list: HubEvent[]) {
  if (!c.events || !list.length) return
  try { await c.events.publish(list) } catch (e) { console.error('[events] publish failed (screens will catch up on reconnect)', (e as Error).message) }
}
