// Billing & orders, kitchen tickets, tables, payments, customers & dues, QR orders and the public QR menu.
import { cleanPartyGst } from '@/core/gst'
import { r2 } from '@/core/pricing'
import { qrSettings } from '@/core/config'
import { applySpecials } from '@/core/specials'
import { subscriptionState } from '@/core/subscription'
import type { Customer, DiningTable, KotStatus, Order, OrderType, PaymentMethod } from '@/core/types'
import type { Ctx, Session } from '../core/context'
import { ApiError } from '../core/errors'
import { define, publicRead, publicWrite, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row, type Where } from '../db/types'
import { DEFAULT_SEQ, loadBusiness } from '../domain/business'
import { forCustomers, loadCategories, loadProducts, wholesaleList } from '../domain/catalog'
import {
  customerFrom, kitchenDelta, kotsFrom, loadOrder, loadOrders, paymentFrom, priceItems, selectIn, settle, tableFrom, withItems, writeOrder, clientUuid,
  type OrderDraft, type PaymentInput,
} from '../domain/orders'
import { movePoints, pointsFrom } from '../domain/points'
import { moveStock, stockProduct } from '../domain/stock'
import { audit, bizDay, bizDayStart, code, moduleOn, E, fromMinor, isId, keyPart, own, readSequence, str, toMinor } from '../domain/util'
import { cleanPhone } from './business'
import { buildView, markPushOn, rateLimit, trackedView } from '../domain/tracking'
import { cachedPublic, rememberTableBranch, tableBranch } from '../domain/menuCache'
import { cachedStats } from '../domain/statsCache'
import { isPushEndpoint } from '../core/webpush'
import { orderNumberCandidates, trackStage, trackStamp, TRACK_WINDOW_MS } from '@/core/tracking'
import { createHash } from 'node:crypto'
import { specialsFor } from './catalog'

/** Customer GST columns from the form (throws a readable error for a wrong GSTIN). */
function customerGst(input: { gstin?: string | null; stateCode?: string | null }) {
  try { const g = cleanPartyGst(input); return { gstin: g.gstin, state_code: g.stateCode } } catch (e) { throw new ApiError((e as Error).message) }
}

const inScope = (c: Ctx): Where => ({ business_id: c.businessId, branch_id: { in: c.scope() } })
const isoArg = (v: unknown) => { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new ApiError('Choose a date range'); return d.toISOString() }
const one = async (c: Ctx, id: string) => (await loadOrder(c, id, { inScope: false })).order

/** Merge two lists of orders (two queries for an OR) without duplicates. */

// ---------- QR helpers ----------
/** Merge a QR request into the table's running order (if any), then send to kitchen. */
async function acceptQr(c: Ctx, orderId: string) {
  const { row, order } = await loadOrder(c, orderId, { inScope: false })
  await c.db.update('orders', row.ROWID, { qr_status: E.QrStatus.accepted })
  let target = order
  if (row.table_id) {
    const running = (await loadOrders(c, { status: E.OrderStatus.open, table_id: str(row.table_id), branch_id: str(row.branch_id) }))
      .find((o) => o.id !== order.id && o.qrStatus !== 'pending')
    if (running) {
      const draft: OrderDraft = { id: running.id, type: running.type, tableId: running.tableId, customerId: running.customerId ?? order.customerId, items: [...running.items, ...order.items.map((i) => ({ ...i, id: `new_${i.id}` }))], discount: running.discount, notes: running.notes, source: running.source }
      await writeOrder(c, draft, { trustedDiscount: true })
      await c.db.update('orders', row.ROWID, { status: E.OrderStatus.cancelled, cancelled_at: c.now.toISOString(), cancel_reason: `Merged into ${running.number}` })
      target = await one(c, running.id)
    }
  }
  if (c.business.modules.kitchen) await kitchenDelta(c, target.id, `${target.number} · QR`)
  return one(c, target.id)
}

/** A session for QR-menu guests: the business, no user, no permissions. */
async function guestSession(c: Ctx, businessId: string, branchId?: string | null, tableId?: string | null): Promise<{ branch: Row }> {
  if (!isId(businessId)) throw new ApiError('Menu not found', 404)
  try { await c.useShop(businessId) } catch { throw new ApiError('Menu not found', 404) }
  const bundle = await loadBusiness(c, businessId)
  if (!bundle) throw new ApiError('Menu not found', 404)
  let wanted = branchId ?? null
  if (tableId && isId(tableId)) { const t = await c.db.first('dining_tables', { ROWID: tableId, business_id: businessId }); if (t) wanted = str(t.branch_id) }
  const open = bundle.branches.filter((b) => b.active !== false)
  const br = open.find((b) => b.id === wanted) ?? open.find((b) => b.isDefault) ?? open[0]
  if (!br) throw new ApiError('Menu not found', 404)
  const s: Session = {
    user: { id: '', businessId, branchId: br.id, name: 'Guest', phone: '', email: '', password: '', roleId: '', active: true, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
    role: { id: '', businessId, name: 'Guest', system: true, permissions: [] }, business: bundle.business, allBranches: bundle.branches,
    allowed: [br.id], permissions: new Set(), branchId: br.id, support: null, features: {},
  }
  c.session = s
  return { branch: (await c.db.get('branches', br.id))! }
}

/**
 * Each customer's all-time totals. For the whole list they come from the shared cache while no bill, payment or
 * return changed since (the version is bumped by those writes in app.ts); a few customers are always read fresh.
 */
async function customerStats(c: Ctx, ids?: string[]) {
  const read = async () => {
    const where: Where = { business_id: c.businessId, status: E.OrderStatus.completed, customer_id: ids ? { in: ids } : { ne: null } }
    const [o, r] = await Promise.all([
      c.db.aggregate('orders', { where, groupBy: ['customer_id'], fns: { total: ['SUM', 'total_minor'], n: ['COUNT', 'ROWID'], due: ['SUM', 'balance_minor'], last: ['MAX', 'billed_at'] } }),
      c.db.aggregate('sale_returns', { where: { business_id: c.businessId, customer_id: ids ? { in: ids } : { ne: null } }, groupBy: ['customer_id'], fns: { total: ['SUM', 'total_minor'] } }),
    ])
    return { o, r }
  }
  const { o, r } = ids ? await read() : await cachedStats(c, read)
  const om = new Map(o.map((y) => [String(y.customer_id), y])), rm = new Map(r.map((y) => [String(y.customer_id), y]))
  return (id: string) => {
    const x = om.get(id), ret = rm.get(id)
    return { totalPurchases: r2(fromMinor(x?.total) - fromMinor(ret?.total)), orderCount: Number(x?.n ?? 0), outstanding: fromMinor(x?.due), lastPurchase: (x?.last as string | null) ?? null }
  }
}

/** Gives back credit-note money used on a bill that is now cancelled. */
async function restoreCreditNote(c: Ctx, returnId: string, amount: number) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cn = await c.db.first('sale_returns', { ROWID: returnId, business_id: c.businessId })
    if (!cn) return
    const next = Math.min(Number(cn.credit_issued_minor ?? 0), Number(cn.credit_remaining_minor ?? 0) + (toMinor(amount) ?? 0))
    if (await c.db.updateIfVersion('sale_returns', cn.ROWID, Number(cn.row_version), { credit_remaining_minor: next })) return
  }
  throw new ApiError('Busy — please try again', 409, 'CONFLICT')
}

define('orders', {
  /** `limit`: only the newest n (e.g. the dashboard's last 6 bills) — never more than 500 without a date range. */
  list: userRead(async (c, filter: { from?: string; to?: string; status?: Order['status'] | 'all'; limit?: number } = {}) => {
    const st: Where = filter.status && filter.status !== 'all' ? { status: code(E.OrderStatus, filter.status) } : {}
    const want = filter.limit != null && Number.isFinite(Number(filter.limit)) ? Math.min(Math.max(1, Math.floor(Number(filter.limit))), 500) : null
    if (!filter.from || !filter.to) return loadOrders(c, { ...inScope(c), ...st }, { limit: want ?? 500 })
    const range = { gte: isoArg(filter.from), lte: isoArg(filter.to) }
    // Orders created or billed in the range: each row once, then their items in one go (not twice).
    const rowsWhere = (w: Where) => c.db.select('orders', { where: { ...inScope(c), ...st, ...w, business_id: c.businessId }, orderBy: [['CREATEDTIME', 'DESC']], limit: 2000 })
    const [created, billed] = await Promise.all([rowsWhere({ CREATEDTIME: range }), rowsWhere({ billed_at: range })])
    const rows = [...new Map([...created, ...billed].map((r) => [r.ROWID, r])).values()]
    const list = (await withItems(c, rows)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return want ? list.slice(0, want) : list
  }),
  running: userRead(async (c) => loadOrders(c, { ...inScope(c), status: E.OrderStatus.open }, { orderBy: [['CREATEDTIME', 'ASC']] })),
  get: userRead(async (c, id: string) => {
    const { order } = await loadOrder(c, id)
    const [pays, kots] = await Promise.all([c.db.select('payments', { where: { business_id: c.businessId, order_id: order.id } }), moduleOn(c, 'kitchen') ? c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: order.id } }) : []])
    return { order, payments: pays.map(paymentFrom), kots: await kotsFrom(c, kots) }
  }),

  /** Create/update a running order (tables, mobile). Optionally sends new items to the kitchen. */
  save: userWrite(async (c, draft: OrderDraft, opts: { sendToKitchen?: boolean } = {}) => {
    if (draft.type === 'dine_in' && !draft.tableId) throw new ApiError('Select a table')
    if (draft.tableId && !draft.id && await c.db.first('orders', { ...inScope(c), status: E.OrderStatus.open, table_id: draft.tableId })) throw new ApiError('This table already has a running order')
    const id = await writeOrder(c, { ...draft, pointsToRedeem: undefined }) // points are used only when the bill is paid (checkout)
    const kot = opts.sendToKitchen && c.business.modules.kitchen ? await kitchenDelta(c, id) : null
    return { order: await one(c, id), kot }
  }),

  /** Move a customer order on the orders board (New → Packing → Ready). Delivered happens when it's paid. */
  setFulfilment: userWrite(async (c, orderId: string, stage: 'new' | 'packing' | 'ready') => {
    const { row } = await loadOrder(c, orderId)
    if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('This order is no longer open')
    if (!['new', 'packing', 'ready'].includes(stage)) throw new ApiError('Unknown stage')
    await c.db.update('orders', row.ROWID, { fulfilment: code(E.Fulfilment, stage), updated_by: c.actorId })
    await audit(c, 'order', row.ROWID, 'update', `stage ${stage} ${str(row.order_number)}`, str(row.branch_id))
  }, { perm: 'orders.view' }),

  /** Customer orders for the board: open ones + those delivered today. */
  board: userRead(async (c) => {
    const [open, done] = await Promise.all([
      loadOrders(c, { ...inScope(c), status: E.OrderStatus.open, table_id: null }),
      loadOrders(c, { ...inScope(c), status: E.OrderStatus.completed, fulfilment: E.Fulfilment.delivered, billed_at: { gte: bizDayStart(c) } }),
    ])
    return [...open.filter((o) => o.qrStatus !== 'pending'), ...done].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }),

  sendToKitchen: userWrite(async (c, orderId: string) => { await loadOrder(c, orderId); return kitchenDelta(c, orderId) }),

  /** Fast billing: create + (kitchen) + settle. A retried request returns the bill already made. */
  checkout: userWrite(async (c, draft: OrderDraft, pays: PaymentInput[]) => {
    if (!draft?.items?.length) throw new ApiError('Add at least one item')
    // Prices, variants, add-ons and specials are read first, outside the shop's write lock (and checked:
    // a wrong item fails here). Inside the transaction the same reads come from memory.
    c.memoCatalog()
    await priceItems(c, draft.items, new Map(), c.businessId, undefined, true) // warm-up read only; the checks run in writeOrder
    await selectIn(c, 'products', 'ROWID', draft.items.map((i) => String(i.productId)), { business_id: c.businessId }) // what settle() reads for stock
    if (draft.items.some((i) => i.priceTier === 'wholesale')) await wholesaleList(c)
    const id = await c.tx(async () => {
      // A running order opened on the Billing page: update that same order, send the kitchen only what it
      // hasn't seen yet, and bill it — never a second order (which would send every item to the kitchen again).
      if (draft.id) {
        const { row } = await loadOrder(c, draft.id)
        if (Number(row.status) === E.OrderStatus.completed) return row.ROWID // same request sent twice: already billed
        if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('This order is no longer running')
        await writeOrder(c, draft)
        if (c.business.modules.kitchen && draft.type !== 'counter') await kitchenDelta(c, row.ROWID)
        await settle(c, row.ROWID, pays)
        return row.ROWID
      }
      const info: { existing?: boolean } = {}
      const id = await writeOrder(c, { ...draft, id: undefined }, { info })
      if (info.existing) return id // same request sent twice: the bill already made
      if (c.business.modules.kitchen && draft.type !== 'counter') await kitchenDelta(c, id)
      await settle(c, id, pays)
      return id
    })
    return one(c, id) // after the commit: read without holding the lock
  }, { perm: 'billing.create', tx: 'manual' }),

  settle: userWrite(async (c, orderId: string, pays: PaymentInput[], patch?: { discount?: number; customerId?: string | null }) => {
    const { row, order } = await loadOrder(c, orderId)
    if (Number(row.status) !== E.OrderStatus.open) {
      // The same request again (its answer was lost on the way): it was already paid by it — return the bill.
      if (c.requestId && await c.db.first('payments', { client_uuid: clientUuid(c, ':p0'), order_id: row.ROWID })) return one(c, orderId)
      throw new ApiError('Order is not running')
    }
    if (patch && (patch.customerId !== undefined || patch.discount !== undefined)) {
      if (patch.discount !== undefined && !c.can('billing.discount') && patch.discount !== order.discount) throw new ApiError('You do not have permission to give a discount', 403)
      await writeOrder(c, { id: order.id, type: order.type, tableId: order.tableId, customerId: patch.customerId !== undefined ? patch.customerId : order.customerId, items: order.items, discount: patch.discount ?? order.discount, notes: order.notes, source: order.source })
    }
    await settle(c, orderId, pays)
    return one(c, orderId)
  }, { perm: 'billing.create' }),

  cancel: userWrite(async (c, orderId: string, reason: string) => {
    if (!String(reason ?? '').trim()) throw new ApiError('Reason is required')
    const { row, order } = await loadOrder(c, orderId)
    if (order.status === 'cancelled') throw new ApiError('Order not found', 404)
    const wasBilled = order.status === 'completed'
    // Items already returned were restocked / refunded by the return — cancelling too would do it twice.
    if (wasBilled && await c.db.first('sale_returns', { business_id: c.businessId, order_id: row.ROWID })) throw new ApiError('This bill has returns, so it can’t be cancelled. Return the remaining items instead.')
    await c.db.update('orders', row.ROWID, { status: E.OrderStatus.cancelled, cancelled_at: c.now.toISOString(), cancel_reason: reason.trim().slice(0, 255), updated_by: c.actorId, row_version: Number(row.row_version) + 1 })
    // Reverse money and stock instead of deleting.
    const pays = await c.db.select('payments', { where: { business_id: c.businessId, order_id: row.ROWID, is_voided: false } })
    if (pays.length) await c.db.updateMany('payments', pays.map((p) => ({ ROWID: p.ROWID, is_voided: true, voided_at: c.now.toISOString(), void_reason: reason.trim().slice(0, 255) })))
    // Paid with a credit note: the customer gets that credit back (never more than the note was worth).
    for (const p of pays) if (p.return_id) await restoreCreditNote(c, str(p.return_id), fromMinor(p.amount_minor))
    if (wasBilled && moduleOn(c, 'inventory')) {
      const prows = await selectIn(c, 'products', 'ROWID', order.items.map((i) => i.productId), { business_id: c.businessId })
      for (const i of order.items) { const p = prows.find((x) => x.ROWID === i.productId); if (p) await moveStock(c, stockProduct(p), str(row.branch_id), i.qty, 'return', { note: `Cancelled — ${order.invoiceNumber}`, refType: 'order', refId: row.ROWID }) }
    }
    // Loyalty: points the bill earned go away; points used on it come back.
    if (wasBilled && order.customerId) {
      if (order.pointsEarned) await movePoints(c, order.customerId, 'cancel', -order.pointsEarned, { orderId: row.ROWID, note: `Bill ${order.invoiceNumber} cancelled`, cap: true })
      if (order.pointsRedeemed) await movePoints(c, order.customerId, 'cancel', order.pointsRedeemed, { orderId: row.ROWID, note: `Bill ${order.invoiceNumber} cancelled — points back` })
    }
    const kots = await c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: row.ROWID } })
    const open = kots.filter((k) => Number(k.status) !== E.KotStatus.completed && Number(k.status) !== E.KotStatus.cancelled)
    if (open.length) await c.db.updateMany('kitchen_tickets', open.map((k) => ({ ROWID: k.ROWID, status: E.KotStatus.cancelled })))
    if (row.table_id) { const m = await c.db.select('dining_tables', { where: { business_id: c.businessId, merged_into_id: str(row.table_id) } }); if (m.length) await c.db.updateMany('dining_tables', m.map((t) => ({ ROWID: t.ROWID, merged_into_id: null }))) }
    await audit(c, 'order', row.ROWID, 'cancel', reason, str(row.branch_id))
    return one(c, row.ROWID)
  }, { perm: 'orders.cancel' }),

  transferTable: userWrite(async (c, orderId: string, toTableId: string) => {
    const { row } = await loadOrder(c, orderId)
    if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('Order not found', 404)
    const to = await own(c, 'dining_tables', toTableId, 'Table not found')
    if (await c.db.first('orders', { ...inScope(c), status: E.OrderStatus.open, table_id: to.ROWID })) throw new ApiError('Target table is occupied')
    const from = row.table_id ? str(row.table_id) : null
    await c.db.update('orders', row.ROWID, { table_id: to.ROWID, order_type: E.OrderType.dine_in, updated_by: c.actorId })
    if (from) { const m = await c.db.select('dining_tables', { where: { business_id: c.businessId, merged_into_id: from } }); if (m.length) await c.db.updateMany('dining_tables', m.map((t) => ({ ROWID: t.ROWID, merged_into_id: to.ROWID }))) }
    const kots = await c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: row.ROWID } })
    if (kots.length) await c.db.updateMany('kitchen_tickets', kots.map((k) => ({ ROWID: k.ROWID, table_label: str(to.label) })))
    await audit(c, 'order', row.ROWID, 'update', `transfer ${from} -> ${to.ROWID}`, str(row.branch_id))
  }),

  /** Merge: move the other table's items into the primary order and link the table. */
  mergeTables: userWrite(async (c, primaryOrderId: string, otherTableId: string) => {
    const { order: primary } = await loadOrder(c, primaryOrderId)
    if (primary.status !== 'open' || !primary.tableId) throw new ApiError('Order not found', 404)
    const t = await own(c, 'dining_tables', otherTableId, 'Table not found')
    const other = (await loadOrders(c, { ...inScope(c), status: E.OrderStatus.open, table_id: t.ROWID }))[0]
    if (other) {
      await writeOrder(c, { id: primary.id, type: primary.type, tableId: primary.tableId, customerId: primary.customerId, items: [...primary.items, ...other.items.map((i) => ({ ...i, id: `new_${i.id}` }))], discount: primary.discount + other.discount, notes: primary.notes, source: primary.source }, { trustedDiscount: true })
      // The other order's lines already in the kitchen stay counted as sent.
      await c.db.update('orders', other.id, { status: E.OrderStatus.cancelled, cancelled_at: c.now.toISOString(), cancel_reason: `Merged into ${primary.number}`, updated_by: c.actorId })
      const kots = await c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: other.id } })
      if (kots.length) await c.db.updateMany('kitchen_tickets', kots.map((k) => ({ ROWID: k.ROWID, order_id: primary.id, order_number: primary.number })))
      const sent = new Map(other.items.map((i) => [i.productId + '|' + (i.variantId ?? ''), i.kotQty]))
      const fresh = await c.db.select('order_items', { where: { order_id: primary.id } })
      const upd = fresh.filter((r) => Number(r.kot_qty_milli) === 0 && sent.get(`${str(r.product_id)}|${str(r.variant_id)}`)).map((r) => ({ ROWID: r.ROWID, kot_qty_milli: Number(r.qty_milli) }))
      if (upd.length) await c.db.updateMany('order_items', upd)
    }
    await c.db.update('dining_tables', t.ROWID, { merged_into_id: primary.tableId })
    await audit(c, 'order', primary.id, 'update', `merge ${t.ROWID}`)
  }),
})

define('payments', {
  list: userRead(async (c, from: string, to: string) => {
    const rows = await c.db.select('payments', { where: { ...inScope(c), CREATEDTIME: { gte: isoArg(from), lte: isoArg(to) } }, orderBy: [['CREATEDTIME', 'DESC']], limit: 3000 })
    return rows.map(paymentFrom)
  }, { perm: 'payments.view' }),
})

define('kitchen', {
  list: userRead(async (c) => {
    // Open tickets from before today + all of today's: two reads that never return the same ticket twice.
    const start = bizDayStart(c)
    const [open, today] = await Promise.all([
      c.db.select('kitchen_tickets', { where: { ...inScope(c), status: { in: [E.KotStatus.new, E.KotStatus.preparing, E.KotStatus.ready] }, CREATEDTIME: { lt: start } } }),
      c.db.select('kitchen_tickets', { where: { ...inScope(c), CREATEDTIME: { gte: start } } }),
    ])
    const all = new Map([...open, ...today].map((k) => [k.ROWID, k]))
    return (await kotsFrom(c, [...all.values()])).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }),
  setStatus: userWrite(async (c, id: string, status: KotStatus) => {
    const k = await own(c, 'kitchen_tickets', id, 'Ticket not found')
    if (!c.inScope(str(k.branch_id))) throw new ApiError('Ticket not found', 404)
    const at = c.now.toISOString()
    await c.db.update('kitchen_tickets', k.ROWID, { status: code(E.KotStatus, status), ...(status === 'preparing' ? { started_at: at } : status === 'ready' ? { ready_at: at } : status === 'completed' ? { completed_at: at } : {}) })
  }),
})

define('tables', {
  list: userRead(async (c) => (await c.db.select('dining_tables', { where: { ...inScope(c), is_active: true }, orderBy: [['ROWID', 'ASC']] })).map(tableFrom)),
  save: userWrite(async (c, t: Partial<DiningTable> & { label: string }) => {
    const label = String(t.label ?? '').trim().slice(0, 20)
    if (!label) throw new ApiError('Enter the table name')
    const data = { label, area: String(t.floor ?? '').trim().slice(0, 40) || 'Main', seats: Math.max(1, Math.floor(Number(t.seats ?? 4)) || 4) }
    try {
      if (t.id) {
        const ex = await own(c, 'dining_tables', t.id, 'Table not found')
        return tableFrom(await c.db.update('dining_tables', ex.ROWID, { ...data, uniq_key: `${str(ex.branch_id)}:${keyPart(label)}` }))
      }
      const branchId = c.writeBranch()
      return tableFrom(await c.db.insert('dining_tables', { business_id: c.businessId, branch_id: branchId, ...data, is_active: true, uniq_key: `${branchId}:${keyPart(label)}` }))
    } catch (e) { if (e instanceof DuplicateError) throw new ApiError(`There is already a table called ${label}`); throw e }
  }, { perm: 'settings.manage' }),
  remove: userWrite(async (c, id: string) => {
    const t = await own(c, 'dining_tables', id, 'Table not found')
    if (await c.db.first('orders', { business_id: c.businessId, status: E.OrderStatus.open, table_id: t.ROWID })) throw new ApiError('Table has a running order')
    // Old bills point at the table, so it is hidden rather than deleted.
    await c.db.update('dining_tables', t.ROWID, { is_active: false, uniq_key: `${str(t.branch_id)}:removed-${t.ROWID}` })
  }, { perm: 'settings.manage' }),
  /** Unlink a merged table without closing the primary order. */
  unmerge: userWrite(async (c, id: string) => { const t = await own(c, 'dining_tables', id, 'Table not found'); await c.db.update('dining_tables', t.ROWID, { merged_into_id: null }) }),
})

define('customers', {
  list: userRead(async (c) => {
    const [rows, list] = await Promise.all([c.db.select('customers', { where: { business_id: c.businessId, is_active: true } }), wholesaleList(c)])
    const stats = await customerStats(c)
    return rows.map((r) => ({ ...customerFrom(r, list?.ROWID ?? null), stats: stats(r.ROWID) }))
  }),
  /** One customer with totals (a bill's drawer) — instead of the whole list. null when not found. */
  one: userRead(async (c, id: string) => {
    if (!isId(id)) return null
    const [r, list] = await Promise.all([c.db.first('customers', { ROWID: id, business_id: c.businessId }), wholesaleList(c)])
    if (!r) return null
    const stats = await customerStats(c, [r.ROWID])
    return { ...customerFrom(r, list?.ROWID ?? null), stats: stats(r.ROWID) }
  }),
  history: userRead(async (c, customerId: string) => {
    await own(c, 'customers', customerId, 'Customer not found')
    const [orders, pays] = await Promise.all([
      loadOrders(c, { customer_id: customerId, status: { ne: E.OrderStatus.open } }, { limit: 500 }),
      c.db.select('payments', { where: { business_id: c.businessId, customer_id: customerId, is_voided: false }, orderBy: [['CREATEDTIME', 'DESC']], limit: 1000 }),
    ])
    return { orders, payments: pays.map(paymentFrom) }
  }),
  save: userWrite(async (c, input: Partial<Customer> & { name: string }) => {
    const name = String(input.name ?? '').trim()
    if (!name) throw new ApiError('Enter the name')
    const phone = cleanPhone(input.phone, c.business.defaultCountry)
    const key = phone ? `${c.businessId}:${phone}` : null
    if (key) { const dup = await c.db.first('customers', { phone_key: key }); if (dup && dup.ROWID !== input.id) throw new ApiError('A customer with this phone already exists') }
    const list = input.priceTier !== undefined ? await wholesaleList(c) : null
    const email = String(input.email ?? '').trim().toLowerCase()
    // GST: a business customer's GSTIN (B2B bills); the state comes from it, or is chosen for other-state buyers.
    const gst = input.gstin !== undefined || input.stateCode !== undefined ? customerGst(input) : {}
    const data = {
      ...gst,
      name: name.slice(0, 120), phone: phone || null, phone_key: key, email: email.slice(0, 150) || null, address: String(input.address ?? '').slice(0, 255) || null, notes: String(input.notes ?? '').slice(0, 255) || null,
      ...(input.marketingOptIn !== undefined ? { marketing_opt_in: input.marketingOptIn !== false } : {}),
      ...(input.priceTier !== undefined ? { price_list_id: input.priceTier === 'wholesale' && list ? list.ROWID : null } : {}),
    }
    let row: Row
    if (input.id) { await own(c, 'customers', input.id, 'Customer not found'); row = await c.db.update('customers', input.id, data) }
    else { row = await c.db.insert('customers', { business_id: c.businessId, marketing_opt_in: true, is_active: true, ...data }); await audit(c, 'customer', row.ROWID, 'create', name) }
    return customerFrom(row, (list ?? await wholesaleList(c))?.ROWID ?? null)
  }, { perm: 'customers.manage' }),

  /** Loyalty points history (newest first) with the bill / credit-note numbers. */
  points: userRead(async (c, customerId: string) => {
    await own(c, 'customers', customerId, 'Customer not found')
    const rows = await c.db.select('customer_points', { where: { business_id: c.businessId, customer_id: customerId }, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: 500 })
    const orderIds = [...new Set(rows.map((r) => str(r.order_id)).filter(Boolean))]
    const returnIds = [...new Set(rows.map((r) => str(r.return_id)).filter(Boolean))]
    const [orders, rets] = await Promise.all([
      orderIds.length ? selectIn(c, 'orders', 'ROWID', orderIds, { business_id: c.businessId }) : [],
      returnIds.length ? selectIn(c, 'sale_returns', 'ROWID', returnIds, { business_id: c.businessId }) : [],
    ])
    const ref = (r: Row) => (r.return_id ? str(rets.find((x) => x.ROWID === str(r.return_id))?.number) : r.order_id ? str(orders.find((x) => x.ROWID === str(r.order_id))?.invoice_number) : '')
    return rows.map((r) => pointsFrom(r, ref(r)))
  }),

  /** Owner adds or removes points by hand (festival gift, correction) — always with a reason. */
  adjustPoints: userWrite(async (c, customerId: string, points: number, reason: string) => {
    await own(c, 'customers', customerId, 'Customer not found')
    const n = Math.trunc(Number(points))
    if (!n || Math.abs(n) > 1_000_000) throw new ApiError('Enter the points to add or remove')
    const why = String(reason ?? '').trim()
    if (!why) throw new ApiError('Enter a reason')
    const r = await movePoints(c, customerId, 'adjust', n, { note: why })
    await audit(c, 'customer', customerId, 'update', `points ${n > 0 ? '+' : ''}${n}: ${why}`.slice(0, 250))
    return { balance: r.balance }
  }, { perm: 'settings.manage' }),

  /** Collect outstanding dues — allocated to the oldest unpaid bills first. */
  collectDue: userWrite(async (c, customerId: string, amount: number, method: PaymentMethod, reference = '') => {
    await own(c, 'customers', customerId, 'Customer not found')
    if (!['cash', 'upi', 'card', 'bank'].includes(method)) throw new ApiError('Choose how it was paid')
    let left = r2(Number(amount))
    if (!(left > 0)) throw new ApiError('Enter an amount')
    const dues = (await c.db.select('orders', { where: { business_id: c.businessId, customer_id: customerId, status: E.OrderStatus.completed, balance_minor: { gt: 0 } }, orderBy: [['billed_at', 'ASC']] }))
    const outstanding = r2(dues.reduce((a, o) => a + fromMinor(o.balance_minor), 0))
    if (left > outstanding + 0.001) throw new ApiError(`Amount is more than outstanding (${outstanding})`)
    const branchId = c.writeBranch({ fallback: true })
    let k = 0
    for (const o of dues) {
      if (left <= 0) break
      const bal = fromMinor(o.balance_minor)
      const part = Math.min(left, bal)
      if (!(await c.db.updateIfVersion('orders', o.ROWID, Number(o.row_version), { paid_minor: Number(o.paid_minor) + (toMinor(part) ?? 0), balance_minor: toMinor(r2(bal - part)) }))) throw new ApiError('This bill was just changed on another device. Please try again.', 409, 'CONFLICT')
      await c.db.insert('payments', { business_id: c.businessId, branch_id: branchId, order_id: o.ROWID, customer_id: customerId, client_uuid: clientUuid(c, `:d${k++}`), kind: E.PaymentKind.due_collection, method: code(E.PayMethod, method), amount_minor: toMinor(part), reference: String(reference).slice(0, 80) || null, is_voided: false, created_by: c.actorId })
      left = r2(left - part)
    }
    await audit(c, 'customer', customerId, 'update', `collect due ${amount} via ${method}`, branchId)
  }, { perm: 'payments.collect' }),
})

define('qr', {
  pending: userRead(async (c) => (await loadOrders(c, { ...inScope(c), source: E.OrderSource.qr, qr_status: E.QrStatus.pending, status: E.OrderStatus.open }, { orderBy: [['CREATEDTIME', 'ASC']] }))),
  recent: userRead(async (c) => loadOrders(c, { ...inScope(c), source: E.OrderSource.qr, CREATEDTIME: { gte: bizDayStart(c) } })),
  accept: userWrite(async (c, orderId: string) => {
    const { order } = await loadOrder(c, orderId)
    if (order.qrStatus !== 'pending' || order.status !== 'open') throw new ApiError('This QR order is no longer pending')
    const target = await acceptQr(c, orderId)
    await audit(c, 'order', orderId, 'update', `qr accept ${target.number}`)
    return target
  }, { perm: 'tables.manage' }),
  reject: userWrite(async (c, orderId: string, reason: string) => {
    const { row, order } = await loadOrder(c, orderId)
    if (order.qrStatus !== 'pending') throw new ApiError('This QR order is no longer pending')
    await c.db.update('orders', row.ROWID, { qr_status: E.QrStatus.rejected, status: E.OrderStatus.cancelled, cancelled_at: c.now.toISOString(), cancel_reason: String(reason || 'Rejected').slice(0, 255), updated_by: c.actorId })
    await audit(c, 'order', row.ROWID, 'update', `qr reject ${reason}`)
  }, { perm: 'tables.manage' }),
})

export interface PublicOrderInput {
  branchId?: string | null; type: OrderType; tableId: string | null
  items: { productId: string; variantId: string | null; addOnIds: string[]; qty: number; notes: string }[]
  guest: { name: string; phone: string; address: string }; notes: string
}

/** Endpoints that work without staff login (customer QR menu, TV display). */
/** The QR menu (read from the database; public.menu keeps a copy in the shared cache). */
async function buildMenu(c: Ctx, businessId: string, branchId?: string | null, tableId?: string | null) {
  const { branch } = await guestSession(c, businessId, branchId, tableId)
  const b = c.business
  // QR ordering off: the page only says so (CustomerMenu) — no catalogue, table or specials reads.
  const on = !!b.modules.qrOrdering
  const [products, cats, tables, specials] = !on ? [[], [], [], []] as never : await Promise.all([
    loadProducts(c, { activeOnly: true, branches: [branch.ROWID], withExpiry: false, withStock: !!b.modules.inventory }), loadCategories(c),
    b.modules.tables ? c.db.select('dining_tables', { where: { business_id: b.id, branch_id: branch.ROWID, is_active: true } }) : [], b.modules.specials ? specialsFor(c, b.id, bizDay(c)) : [],
  ])
  const sp = applySpecials(b.modules.inventory ? products.filter((p) => !(p.trackStock && p.stock <= 0)) : products, specials)
  return {
    business: { id: b.id, name: b.name, logoEmoji: b.logoEmoji, logoUrl: b.logoUrl ?? null, subType: b.subType, address: b.address, phone: b.phone, defaultCountry: b.defaultCountry ?? 'IN', currencySymbol: b.currencySymbol, billing: b.billing, modules: b.modules, terminology: b.terminology, qr: qrSettings(b) },
    categories: cats, products: sp.products.map(forCustomers), specials: sp.specials.map(forCustomers),
    specialInfo: [...sp.info.entries()].map(([productId, v]) => ({ productId, tag: v.special.tag, originalPrice: v.originalPrice, specialPrice: v.special.specialPrice })),
    tables: tables.map((t) => ({ id: t.ROWID, label: str(t.label) })),
    branch: { id: branch.ROWID, name: str(branch.name), address: str(branch.address), phone: str(branch.phone) },
    branchCount: c.s.allBranches.length,
  }
}

/** The TV specials board (public.specials keeps a copy in the shared cache). */
async function buildSpecials(c: Ctx, businessId: string) {
  await guestSession(c, businessId)
  const b = c.business
  // Specials off: an empty board, without reading the catalogue.
  const sp = b.modules.specials ? applySpecials(await loadProducts(c, { activeOnly: true, withExpiry: false }), await specialsFor(c, b.id, bizDay(c))) : applySpecials([], [])
  return { business: { name: b.name, logoEmoji: b.logoEmoji, logoUrl: b.logoUrl ?? null, subType: b.subType, currencySymbol: b.currencySymbol, qr: qrSettings(b), qrOn: b.modules.qrOrdering }, items: sp.specials.map((p) => ({ product: forCustomers(p), ...sp.info.get(p.id)! })) }
}

define('public', {
  menu: publicRead(async (c, businessId: string, branchId?: string | null, tableId?: string | null) => {
    if (!isId(businessId)) throw new ApiError('Menu not found', 404)
    // One cached menu per branch: a table's QR is served the menu of its branch (the menu doesn't depend on the table).
    const tid = isId(tableId) ? String(tableId) : null
    const br = tid ? await tableBranch(c, businessId, tid) : isId(branchId) ? String(branchId) : ''
    if (tid && !br) {
      const value = await buildMenu(c, businessId, branchId, tableId)
      if (value.tables.some((t) => t.id === tid)) await rememberTableBranch(c, businessId, tid, value.branch.id) // real tables only
      return cachedPublic(c, businessId, `menu:${value.branch.id}`, async () => ({ value, tz: c.business.timezone }))
    }
    return cachedPublic(c, businessId, `menu:${br}`, async () => ({ value: await buildMenu(c, businessId, br || branchId, null), tz: c.business.timezone }))
  }),

  placeOrder: publicWrite(async (c, businessId: string, input: PublicOrderInput) => {
    const { branch } = await guestSession(c, businessId, input?.branchId, input?.tableId)
    const b = c.business
    const st = subscriptionState(b, c.now)
    if (st.blocked || st.readOnly || !b.modules.qrOrdering) throw new ApiError('Online ordering is not available right now')
    const qr = qrSettings(b)
    if (!qr.orderTypes.includes(input.type)) throw new ApiError('This order type is not available')
    const table = input.tableId && isId(input.tableId) ? await c.db.first('dining_tables', { ROWID: input.tableId, business_id: b.id, is_active: true }) : null
    if (input.type === 'dine_in' && !table) throw new ApiError('Please scan the QR code on your table')
    const guest = { name: String(input.guest?.name ?? '').trim().slice(0, 120), phone: '', address: String(input.guest?.address ?? '').trim().slice(0, 255) }
    guest.phone = cleanPhone(input.guest?.phone, b.defaultCountry, input.type !== 'dine_in' ? 'Enter your mobile number' : undefined)
    if (input.type !== 'dine_in' && !guest.name) throw new ApiError('Enter your name')
    if (input.type === 'delivery' && guest.address.length < 8) throw new ApiError('Enter the full delivery address')
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 40) throw new ApiError('Add items to your order')
    const items = input.items.map((i) => ({ id: '', productId: String(i.productId), name: '', variantId: i.variantId ?? null, variantName: null, addOns: (i.addOnIds ?? []).map((id) => ({ id: String(id), name: '', price: 0 })), qty: Math.min(50, Math.max(1, Math.round(Number(i.qty)))), unit: '', unitPrice: 0, taxRate: 0, notes: String(i.notes ?? '').slice(0, 120), kotQty: 0 }))
    // Re-priced from the catalogue; stock checked in this branch.
    const priced = await priceItems(c, items, new Map(), b.id, [branch.ROWID])
    // Stock is checked only with Inventory on (otherwise stock isn't kept — no reads).
    const stocked = !!b.modules.inventory
    const stockRows = stocked ? await selectIn(c, 'branch_stock', 'product_id', priced.map((p) => p.productId), { branch_id: branch.ROWID }) : []
    const prods = stocked ? await selectIn(c, 'products', 'ROWID', priced.map((p) => p.productId), { business_id: b.id }) : []
    for (const p of priced) {
      const pr = prods.find((x) => x.ROWID === p.productId)
      const have = Number(stockRows.find((s) => s.product_id === p.productId)?.qty_milli ?? 0) / 1000
      if (pr?.track_stock && have < p.qty) throw new ApiError(`${p.name} is out of stock`)
    }
    // The writes are one transaction (reads above stay outside it, so the shop's lock is held briefly).
    return c.tx(async () => {
    // Link to an existing customer by phone, or create one.
    let customerId: string | null = null
    if (guest.phone) {
      const key = `${b.id}:${guest.phone}`
      let cu = await c.db.first('customers', { phone_key: key })
      if (!cu) {
        try { cu = await c.db.insert('customers', { business_id: b.id, name: guest.name || 'Guest', phone: guest.phone, phone_key: key, address: guest.address || null, notes: 'Created from QR order', marketing_opt_in: true, is_active: true }) }
        catch (e) { if (!(e instanceof DuplicateError)) throw e; cu = await c.db.first('customers', { phone_key: key }) }
      }
      customerId = cu?.ROWID ?? null
    }
    const id = await writeOrder(c, { type: input.type, tableId: table?.ROWID ?? null, customerId, items: priced, discount: 0, notes: String(input.notes ?? '').slice(0, 200), source: 'qr' }, { qr: { guest, branchId: branch.ROWID, auto: qr.autoAccept } })
    if (qr.autoAccept) await acceptQr(c, id)
    const o = await one(c, id)
    await c.db.insert('audit_logs', { business_id: b.id, branch_id: branch.ROWID, user_id: null, entity: E.AuditEntity.order, entity_id: id, action: E.AuditAction.create, detail: `qr place ${o.number} ${input.type}` })
    return { orderId: id, number: o.number }
    })
  }),

  /** Status for the customer's tracking screen — only that one order is exposed. */
  /** The tracking screen. Answered from the shared cache while nothing in the shop changed (no database read). */
  order: publicRead(async (c, businessId: string, orderId: string) => {
    if (!isId(businessId) || !isId(orderId)) throw new ApiError('Order not found', 404)
    return trackedView(c, businessId, orderId)
  }),
  /** "Track my order": today's or yesterday's order with this number → its id for the tracking screen. */
  track: publicRead(async (c, businessId: string, number: string) => {
    if (!isId(businessId)) throw new ApiError('Shop not found', 404)
    await rateLimit(c, `track:${businessId}`, 10, 'Too many tries. Please wait a minute and try again.')
    // Only what this needs: the shop exists, and its order-number prefix (not the whole business).
    const biz = await c.platform.get('businesses', businessId)
    if (!biz || biz.deleted_at) throw new ApiError('Shop not found', 404)
    try { await c.useShop(businessId) } catch { throw new ApiError('Shop not found', 404) }
    const seq = await readSequence(c.db, businessId, null, 'order')
    const want = orderNumberCandidates(number, seq?.prefix != null ? str(seq.prefix) : DEFAULT_SEQ.order.prefix)
    if (!want.length) throw new ApiError('Enter your order number')
    const since = new Date(c.now.getTime() - TRACK_WINDOW_MS).toISOString()
    const [hit] = await c.db.select('orders', { where: { business_id: businessId, order_number: { in: want }, CREATEDTIME: { gte: since } }, orderBy: [['ROWID', 'DESC']], limit: 1 })
    if (!hit) throw new ApiError('No order with that number today. Check the number on your order screen or bill.', 404)
    return { orderId: hit.ROWID, number: str(hit.order_number) }
  }),
  /** Browser push key for "Notify me" (null = push not set up: the page shows Refresh only). */
  pushKey: publicRead(async (c) => ({ publicKey: c.push?.publicKey ?? null })),
  subscribePush: { ...publicWrite(async (c, businessId: string, orderId: string, sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }) => {
    if (!c.push) throw new ApiError('Notifications are not available')
    if (!isId(businessId) || !isId(orderId)) throw new ApiError('Order not found', 404)
    await rateLimit(c, `push:${businessId}`, 20, 'Too many tries. Please wait a minute and try again.')
    const endpoint = String(sub?.endpoint ?? ''), p256dh = String(sub?.keys?.p256dh ?? ''), auth = String(sub?.keys?.auth ?? '')
    if (!isPushEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) throw new ApiError('This browser can’t receive notifications')
    try { await c.useShop(businessId) } catch { throw new ApiError('Order not found', 404) }
    const view = await buildView(c, businessId, orderId)
    const stage = trackStage(view)
    if (stage === 'done' || stage === 'rejected') return { ok: true, stage }
    const uniq = `${orderId}:${createHash('sha256').update(endpoint).digest('hex').slice(0, 40)}`
    const data = { endpoint, p256dh, auth_secret: auth, last_stamp: trackStamp(view), expires_at: new Date(c.now.getTime() + 86_400_000).toISOString() }
    const ex = await c.db.first('push_subscriptions', { uniq_key: uniq })
    if (ex) await c.db.update('push_subscriptions', ex.ROWID, data)
    else {
      // A few phones per order at most.
      if (await c.db.count('push_subscriptions', { order_id: orderId }) >= 5) throw new ApiError('Too many devices for this order')
      try { await c.db.insert('push_subscriptions', { business_id: businessId, order_id: orderId, uniq_key: uniq, ...data }) } catch (e) { if (!(e instanceof DuplicateError)) throw e }
    }
    await markPushOn(c, businessId)
    return { ok: true, stage }
  }), quiet: true },

  specials: publicRead(async (c, businessId: string) => {
    if (!isId(businessId)) throw new ApiError('Not found', 404)
    return cachedPublic(c, businessId, 'specials', async () => ({ value: await buildSpecials(c, businessId), tz: c.business.timezone }))
  }),
})

