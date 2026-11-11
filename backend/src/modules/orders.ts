// Billing & orders, kitchen tickets, tables, payments, customers & dues, QR orders and the public QR menu.
import { cleanPartyGst } from '@/core/gst'
import { r2 } from '@/core/pricing'
import { publicBilling, qrSettings } from '@/core/config'
import { applySpecials } from '@/core/specials'
import { featuresFor, withFeatures } from '@/core/features'
import { subscriptionState } from '@/core/subscription'
import type { Customer, DiningTable, KotStatus, Order, OrderType, PaymentMethod, Permission } from '@/core/types'
import type { Ctx, Session } from '../core/context'
import { ApiError } from '../core/errors'
import { define, publicRead, publicWrite, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Cond, type Row, type Where } from '../db/types'
import { DEFAULT_SEQ, loadBusiness } from '../domain/business'
import { loadCategories, loadProducts, wholesaleList } from '../domain/catalog'
import {
  customerFrom, kitchenDelta, kotsFrom, loadOrder, loadOrders, orderFrom, paymentFrom, priceItems, selectIn, settle, tableFrom, withItems, writeOrder, clientUuid,
  type OrderDraft, type PaymentInput, type WriteInfo,
} from '../domain/orders'
import { movePoints, pointsFrom } from '../domain/points'
import { moveStock, restorableStock, stockProduct, takeRestorable } from '../domain/stock'
import { audit, bizDay, bizDayStart, code, cursorArg, moduleOn, E, fromMilli, fromMinor, isId, keyPart, nameOf, own, readSequence, str, toMinor, money, mayUseBranch, assertBranch } from '../domain/util'
import { idBefore } from '@/core/paging'
import { cleanPhone } from './business'
import { buildView, countIn, ensureTrackCode, limitIn, markPushOn, rateLimit, trackedView, trackRef } from '../domain/tracking'
import { cachedPublic, rememberTableBranch, tableBranch } from '../domain/menuCache'
import { cachedStats } from '../domain/statsCache'
import { featureFlagsFor } from '../domain/session'
import { isPushEndpoint } from '../core/webpush'
import { orderNumberCandidates, trackStage, trackStamp, TRACK_WINDOW_MS } from '@/core/tracking'
import { createHash } from 'node:crypto'
import { itemSummary } from '@/core/orderItem'
import { QR_MENU_FULL_MAX } from '@/core/catalogIndex'
import type { Product, Special } from '@/core/types'
import { afterKey, nameLike, type Arg } from '../domain/productSql'
import { specialsFor } from './catalog'

/** Customer GST columns from the form (throws a readable error for a wrong GSTIN). */
function customerGst(input: { gstin?: string | null; stateCode?: string | null }) {
  try { const g = cleanPartyGst(input); return { gstin: g.gstin, state_code: g.stateCode } } catch (e) { throw new ApiError((e as Error).message) }
}

const inScope = (c: Ctx): Where => ({ business_id: c.businessId, branch_id: { in: c.scope() } })
const isoArg = (v: unknown) => { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new ApiError('Choose a date range'); return d.toISOString() }
const one = async (c: Ctx, id: string) => (await loadOrder(c, id, { inScope: false })).order

/** Bills with their lines as short text (itemSummary) and no lines — the Orders list. Turso: one small read. */
async function withSummary(c: Ctx, rows: Row[]): Promise<Order[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.ROWID)
  const lines: { order_id: string; name: string; qty: number; sort: number }[] = []
  if (c.dbs.perShop && c.db.sql) {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100)
      const rs = await c.db.sql(`SELECT "order_id", "product_name", "qty_milli", "sort_order" FROM "order_items" WHERE "order_id" IN (${part.map(() => '?').join(', ')})`, part.map(Number))
      for (const r of rs) lines.push({ order_id: String(r.order_id), name: str(r.product_name as string), qty: fromMilli(r.qty_milli as number), sort: Number(r.sort_order) })
    }
  } else {
    for (const r of await selectIn(c, 'order_items', 'order_id', ids)) lines.push({ order_id: str(r.order_id), name: str(r.product_name), qty: fromMilli(r.qty_milli), sort: Number(r.sort_order) })
  }
  const byOrder = new Map<string, typeof lines>()
  for (const l of lines) { const a = byOrder.get(l.order_id); if (a) a.push(l); else byOrder.set(l.order_id, [l]) }
  return rows.map((r) => ({ ...orderFrom(r, []), itemSummary: itemSummary((byOrder.get(r.ROWID) ?? []).sort((a, b) => a.sort - b.sort)) }))
}

/** Merge two lists of orders (two queries for an OR) without duplicates. */

// ---------- QR helpers ----------
/** Merge a QR request into the table's running order (if any), then send to kitchen. */
async function acceptQr(c: Ctx, orderId: string) {
  const { row, order } = await loadOrder(c, orderId, { inScope: false })
  // Only a QR order still waiting: accepting twice (a double tap, a repeated request) never merges its items again,
  // and an order already billed, merged or cancelled is never touched.
  if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('This order is no longer waiting', 409)
  if (order.qrStatus !== 'pending') return one(c, row.ROWID)
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
  const [bundle, flags] = await Promise.all([loadBusiness(c, businessId), featureFlagsFor(c)])
  if (!bundle) throw new ApiError('Menu not found', 404)
  // QR ordering / specials not released to this shop: the menu and TV board see them as off (core/features.ts).
  const features = featuresFor(flags, businessId)
  bundle.business.modules = withFeatures(bundle.business.modules, features)
  let wanted = branchId ?? null
  if (tableId && isId(tableId)) { const t = await c.db.first('dining_tables', { ROWID: tableId, business_id: businessId }); if (t) wanted = str(t.branch_id) }
  const open = bundle.branches.filter((b) => b.active !== false)
  const br = open.find((b) => b.id === wanted) ?? open.find((b) => b.isDefault) ?? open[0]
  if (!br) throw new ApiError('Menu not found', 404)
  const s: Session = {
    user: { id: '', businessId, branchId: br.id, name: 'Guest', phone: '', email: '', password: '', roleId: '', active: true, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
    role: { id: '', businessId, name: 'Guest', system: true, permissions: [] }, business: bundle.business, allBranches: bundle.branches,
    allowed: [br.id], permissions: new Set(), branchId: br.id, support: null, features,
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

/** orders.list without a date range: at most this many (newest first). */
const LIST_NEWEST = 50
/** Who may read customers (names, phones, dues): billing, orders, customers, payments or reports — not kitchen staff. */
const CUSTOMER_READ: Permission[] = ['billing.create', 'orders.view', 'customers.manage', 'payments.view', 'payments.collect', 'reports.view']
/** Customers per search / lookup answer (the picker shows 50). */
const CUSTOMER_PAGE = 50
/** Rows as customers.list gives them (with their totals), for only these customers. */
async function withStats(c: Ctx, rows: Row[], wholesaleId: string | null) {
  if (!rows.length) return []
  const stats = await customerStats(c, rows.map((r) => r.ROWID))
  return rows.map((r) => ({ ...customerFrom(r, wholesaleId), stats: stats(r.ROWID) }))
}

define('orders', {
  /** `limit`: only the newest n (e.g. the dashboard's last 6 bills) — never more than 500 without a date range. */
  list: userRead(async (c, filter: { from?: string; to?: string; status?: Order['status'] | 'all'; limit?: number } = {}) => {
    const st: Where = filter.status && filter.status !== 'all' ? { status: code(E.OrderStatus, filter.status) } : {}
    const want = filter.limit != null && Number.isFinite(Number(filter.limit)) ? Math.min(Math.max(1, Math.floor(Number(filter.limit))), 500) : null
    // Without a range: the newest 50 at most (the dashboard asks for 6); the Orders screen pages with orders.page.
    if (!filter.from || !filter.to) return loadOrders(c, { ...inScope(c), ...st }, { limit: Math.min(want ?? LIST_NEWEST, LIST_NEWEST) })
    const range = { gte: isoArg(filter.from), lte: isoArg(filter.to) }
    // Orders created or billed in the range: each row once, then their items in one go (not twice).
    const rowsWhere = (w: Where) => c.db.select('orders', { where: { ...inScope(c), ...st, ...w, business_id: c.businessId }, orderBy: [['CREATEDTIME', 'DESC']], limit: 2000 })
    const [created, billed] = await Promise.all([rowsWhere({ CREATEDTIME: range }), rowsWhere({ billed_at: range })])
    const rows = [...new Map([...created, ...billed].map((r) => [r.ROWID, r])).values()]
    const list = (await withItems(c, rows)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return want ? list.slice(0, want) : list
  }, { anyPerm: ['dashboard.view', 'orders.view', 'reports.view'] }),
  /**
   * The Orders screen, page by page: `limit` (50) bills created or billed in the range, newest first, after `before`
   * (the last bill the screen has). `count` / `billed` are for the whole filter (the header), not just this page.
   * Same rows and order as orders.list; status, type and search are applied here instead of in the browser.
   */
  page: userRead(async (c, filter: { from: string; to: string; status?: Order['status'] | 'all'; type?: OrderType | 'all'; q?: string; summary?: boolean }, before?: unknown, limit = 50) => {
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50))
    const range = { gte: isoArg(filter?.from), lte: isoArg(filter?.to) }
    const base: Where = { ...inScope(c) }
    if (filter?.status && filter.status !== 'all') base.status = code(E.OrderStatus, filter.status)
    if (filter?.type && filter.type !== 'all' && filter.type in E.OrderType) base.order_type = code(E.OrderType, filter.type)
    // Search: order number, bill number or the customer's name (any of them).
    const q = String(filter?.q ?? '').trim().slice(0, 60)
    let alts: Where[] = [{}]
    if (q) {
      const custs = await c.db.select('customers', { where: { business_id: c.businessId, name: { contains: q } }, limit: 200 })
      alts = [{ order_number: { contains: q } }, { invoice_number: { contains: q } }, ...(custs.length ? [{ customer_id: { in: custs.map((r) => r.ROWID) } }] : [])]
    }
    const cur = cursorArg(before)
    // Some stores compare times to the second: ask up to a second later, then keep exactly the rows after the cursor.
    const upTo = cur ? new Date(Date.parse(cur.at) + 1000).toISOString() : null
    const after = (r: Row) => !cur || r.CREATEDTIME < cur.at || (r.CREATEDTIME === cur.at && idBefore(r.ROWID, cur.id))
    const newest = (a: Row, b: Row) => (a.CREATEDTIME < b.CREATEDTIME ? 1 : a.CREATEDTIME > b.CREATEDTIME ? -1 : idBefore(a.ROWID, b.ROWID) ? 1 : -1)
    // Two parts that never overlap: made in the range, and billed in the range but made before it.
    const sets = alts.flatMap((alt) => [{ ...base, ...alt, CREATEDTIME: upTo ? { gte: range.gte, lte: upTo < range.lte ? upTo : range.lte } : range },
      { ...base, ...alt, billed_at: range, CREATEDTIME: { lt: range.gte, ...(upTo ? { lte: upTo } : {}) } as Cond }] as Where[])
    // One more than a page tells whether there is a next page; after a cursor, a few extra for bills saved in the same second.
    const found = await Promise.all(sets.map((w) => c.db.select('orders', { where: w, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: n + 1 + (cur ? 50 : 0) })))
    const merged = [...new Map(found.flat().filter(after).map((r) => [r.ROWID, r])).values()].sort(newest)
    const pageRows = merged.slice(0, n)
    const next = merged.length > n ? { at: pageRows[n - 1].CREATEDTIME, id: pageRows[n - 1].ROWID } : null

    // Header totals for the whole filter, from the same two parts: bills per status and the billed amount.
    let count = 0, billedMinor = 0
    if (!q) {
      const parts: Where[] = [{ CREATEDTIME: range }, { billed_at: range, CREATEDTIME: { lt: range.gte } }]
      const groups = await Promise.all(parts.map((w) => c.db.aggregate('orders', { where: { ...base, ...w }, groupBy: ['status'], fns: { n: ['COUNT', 'ROWID'], s: ['SUM', 'total_minor'] } })))
      for (const g of groups.flat()) {
        count += Number(g.n ?? 0)
        if (Number(g.status) === E.OrderStatus.completed) billedMinor += Number(g.s ?? 0)
      }
    } else {
      // A search is a short list: add up the matching bills (at most 200 per part).
      const all = await Promise.all(alts.flatMap((alt) => [{ ...base, ...alt, CREATEDTIME: range }, { ...base, ...alt, billed_at: range, CREATEDTIME: { lt: range.gte } }] as Where[])
        .map((w) => c.db.select('orders', { where: w, limit: 200 })))
      const uniq = [...new Map(all.flat().map((r) => [r.ROWID, r])).values()]
      count = uniq.length
      billedMinor = uniq.filter((r) => Number(r.status) === E.OrderStatus.completed).reduce((a, r) => a + Number(r.total_minor ?? 0), 0)
    }
    // The Orders screen asks for a summary: each bill's lines as short text (one small read), not every line in full.
    const rows = filter?.summary === true ? await withSummary(c, pageRows) : await withItems(c, pageRows)
    return { rows, next, count, billed: fromMinor(billedMinor) }
  }, { anyPerm: ['orders.view', 'billing.create'] }),
  running: userRead(async (c) => loadOrders(c, { ...inScope(c), status: E.OrderStatus.open }, { orderBy: [['CREATEDTIME', 'ASC']] }), { anyPerm: ['billing.create', 'orders.view', 'tables.manage', 'dashboard.view'] }),
  get: userRead(async (c, id: string) => {
    const { order } = await loadOrder(c, id)
    const [pays, kots] = await Promise.all([c.db.select('payments', { where: { business_id: c.businessId, order_id: order.id } }), moduleOn(c, 'kitchen') ? c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: order.id } }) : []])
    return { order, payments: pays.map(paymentFrom), kots: await kotsFrom(c, kots) }
  }, { anyPerm: ['orders.view', 'billing.create'] }),

  /** Create/update a running order (tables, mobile). Optionally sends new items to the kitchen. */
  save: userWrite(async (c, draft: OrderDraft, opts: { sendToKitchen?: boolean } = {}) => {
    if (draft.type === 'dine_in' && !draft.tableId) throw new ApiError('Select a table')
    if (draft.tableId && !draft.id && await c.db.first('orders', { ...inScope(c), status: E.OrderStatus.open, table_id: draft.tableId })) throw new ApiError('This table already has a running order')
    // The items' catalogue rows are read once: pricing and the kitchen ticket share them (the order writes none).
    c.memoCatalog()
    const id = await writeOrder(c, { ...draft, pointsToRedeem: undefined }) // points are used only when the bill is paid (checkout)
    const kot = opts.sendToKitchen && c.business.modules.kitchen ? await kitchenDelta(c, id) : null
    return { order: await one(c, id), kot }
  }, { anyPerm: ['billing.create', 'tables.manage'] }),

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
    if (!Array.isArray(draft?.items) || !draft.items.length) throw new ApiError('Add at least one item')
    // Prices, variants, add-ons and specials are read first, outside the shop's write lock (and checked:
    // a wrong item fails here). Inside the transaction the same reads come from memory.
    c.memoCatalog()
    await priceItems(c, draft.items, new Map(), c.businessId, undefined, true) // warm-up read only; the checks run in writeOrder
    await selectIn(c, 'products', 'ROWID', draft.items.map((i) => String(i.productId)), { business_id: c.businessId }) // what settle() reads for stock
    if (draft.items.some((i) => i.priceTier === 'wholesale')) await wholesaleList(c)
    // `done`: the finished bill as settle saved it (one database per shop) — else it is read after the commit.
    const { id, done } = await c.tx(async (): Promise<{ id: string; done: Order | null }> => {
      // A running order opened on the Billing page: update that same order, send the kitchen only what it
      // hasn't seen yet, and bill it — never a second order (which would send every item to the kitchen again).
      if (draft.id) {
        const { row } = await loadOrder(c, draft.id)
        if (Number(row.status) === E.OrderStatus.completed) return { id: row.ROWID, done: null } // same request sent twice: already billed
        if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('This order is no longer running')
        await writeOrder(c, draft)
        if (c.business.modules.kitchen && draft.type !== 'counter') await kitchenDelta(c, row.ROWID)
        return { id: row.ROWID, done: await settle(c, row.ROWID, pays) }
      }
      const info: WriteInfo = {}
      const id = await writeOrder(c, { ...draft, id: undefined }, { info })
      if (info.existing) return { id, done: null } // same request sent twice: the bill already made
      const kitchen = c.business.modules.kitchen && draft.type !== 'counter'
      if (kitchen) await kitchenDelta(c, id)
      // The order just written is passed on (not read back) — unless the kitchen ticket changed its lines.
      return { id, done: await settle(c, id, pays, kitchen ? undefined : info.written) }
    })
    return done ?? one(c, id) // otherwise after the commit: read without holding the lock
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
      return (await settle(c, orderId, pays)) ?? one(c, orderId)
    }
    // Nothing changed since it was read just now: settle uses it as it is.
    return (await settle(c, orderId, pays, { row, order })) ?? one(c, orderId)
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
      // Only what this bill's sale actually took out goes back (none if Inventory was off or the item untracked then).
      const [prows, left] = await Promise.all([
        selectIn(c, 'products', 'ROWID', order.items.map((i) => i.productId), { business_id: c.businessId }),
        restorableStock(c, row.ROWID),
      ])
      for (const i of order.items) {
        const p = prows.find((x) => x.ROWID === i.productId)
        const give = p ? takeRestorable(left, i.productId, i.qty) : 0
        if (p && give > 0) await moveStock(c, stockProduct(p), str(row.branch_id), give, 'return', { note: `Cancelled — ${order.invoiceNumber}`, refType: 'order', refId: row.ROWID })
      }
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
    assertBranch(c, to.branch_id, 'Table not found')
    if (await c.db.first('orders', { ...inScope(c), status: E.OrderStatus.open, table_id: to.ROWID })) throw new ApiError('Target table is occupied')
    const from = row.table_id ? str(row.table_id) : null
    await c.db.update('orders', row.ROWID, { table_id: to.ROWID, order_type: E.OrderType.dine_in, updated_by: c.actorId })
    if (from) { const m = await c.db.select('dining_tables', { where: { business_id: c.businessId, merged_into_id: from } }); if (m.length) await c.db.updateMany('dining_tables', m.map((t) => ({ ROWID: t.ROWID, merged_into_id: to.ROWID }))) }
    const kots = await c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: row.ROWID } })
    if (kots.length) await c.db.updateMany('kitchen_tickets', kots.map((k) => ({ ROWID: k.ROWID, table_label: str(to.label) })))
    await audit(c, 'order', row.ROWID, 'update', `transfer ${from} -> ${to.ROWID}`, str(row.branch_id))
  }, { anyPerm: ['tables.manage', 'billing.create'] }),

  /** Merge: move the other table's items into the primary order and link the table. */
  mergeTables: userWrite(async (c, primaryOrderId: string, otherTableId: string) => {
    const { order: primary } = await loadOrder(c, primaryOrderId)
    if (primary.status !== 'open' || !primary.tableId) throw new ApiError('Order not found', 404)
    const t = await own(c, 'dining_tables', otherTableId, 'Table not found')
    assertBranch(c, t.branch_id, 'Table not found')
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
  }, { anyPerm: ['tables.manage', 'billing.create'] }),
})

define('payments', {
  /**
   * The Payments screen page by page: 50 payments (newest first) after `before`, each with its bill number, plus
   * for the whole range the number of payments (for the pager) and the total per method (voided ones left out).
   * Totals are added up by the database, so they are right however many payments there are.
   */
  page: userRead(async (c, filter: { from: string; to: string; method?: PaymentMethod | 'all' }, before?: unknown, limit = 50) => {
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50))
    const range = { gte: isoArg(filter?.from), lte: isoArg(filter?.to) }
    const base: Where = { ...inScope(c) }
    const shown: Where = { ...base, ...(filter?.method && filter.method !== 'all' && filter.method in E.PayMethod ? { method: code(E.PayMethod, filter.method) } : {}) }
    const cur = cursorArg(before)
    // Some stores compare times to the second: ask up to a second later, then keep exactly the rows after the cursor.
    const upTo = cur ? new Date(Date.parse(cur.at) + 1000).toISOString() : null
    const after = (r: Row) => !cur || r.CREATEDTIME < cur.at || (r.CREATEDTIME === cur.at && idBefore(r.ROWID, cur.id))
    const [found, counted, byMethod] = await Promise.all([
      c.db.select('payments', { where: { ...shown, CREATEDTIME: upTo ? { gte: range.gte, lte: upTo < range.lte ? upTo : range.lte } : range }, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: n + 1 + (cur ? 50 : 0) }),
      c.db.aggregate('payments', { where: { ...shown, CREATEDTIME: range }, fns: { n: ['COUNT', 'ROWID'] } }),
      c.db.aggregate('payments', { where: { ...base, CREATEDTIME: range, is_voided: false }, groupBy: ['method'], fns: { s: ['SUM', 'amount_minor'] } }),
    ])
    const rest = found.filter(after)
    const rows = rest.slice(0, n)
    const next = rest.length > n ? { at: rows[n - 1].CREATEDTIME, id: rows[n - 1].ROWID } : null
    const ids = [...new Set(rows.map((r) => str(r.order_id)).filter(Boolean))]
    const bills = ids.length ? await selectIn(c, 'orders', 'ROWID', ids, { business_id: c.businessId }) : []
    const number = new Map(bills.map((o) => [o.ROWID, str(o.invoice_number) || str(o.order_number) || null]))
    const totals: Partial<Record<PaymentMethod, number>> = {}
    for (const g of byMethod) { const m = nameOf(E.PayMethod, g.method) as PaymentMethod; totals[m] = r2((totals[m] ?? 0) + fromMinor(g.s)) }
    return {
      rows: rows.map((r) => ({ ...paymentFrom(r), billNumber: r.order_id ? number.get(str(r.order_id)) ?? null : null })),
      next, count: Number(counted[0]?.n ?? 0), totals,
    }
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
  }, { anyPerm: ['kitchen.view', 'tables.manage', 'billing.create'] }),
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
        assertBranch(c, ex.branch_id, 'Table not found')
        return tableFrom(await c.db.update('dining_tables', ex.ROWID, { ...data, uniq_key: `${str(ex.branch_id)}:${keyPart(label)}` }))
      }
      const branchId = c.writeBranch()
      return tableFrom(await c.db.insert('dining_tables', { business_id: c.businessId, branch_id: branchId, ...data, is_active: true, uniq_key: `${branchId}:${keyPart(label)}` }))
    } catch (e) { if (e instanceof DuplicateError) throw new ApiError(`There is already a table called ${label}`); throw e }
  }, { perm: 'settings.manage' }),
  remove: userWrite(async (c, id: string) => {
    const t = await own(c, 'dining_tables', id, 'Table not found')
    assertBranch(c, t.branch_id, 'Table not found')
    if (await c.db.first('orders', { business_id: c.businessId, status: E.OrderStatus.open, table_id: t.ROWID })) throw new ApiError('Table has a running order')
    // Old bills point at the table, so it is hidden rather than deleted.
    await c.db.update('dining_tables', t.ROWID, { is_active: false, uniq_key: `${str(t.branch_id)}:removed-${t.ROWID}` })
  }, { perm: 'settings.manage' }),
  /** Unlink a merged table without closing the primary order. */
  unmerge: userWrite(async (c, id: string) => { const t = await own(c, 'dining_tables', id, 'Table not found'); assertBranch(c, t.branch_id, 'Table not found'); await c.db.update('dining_tables', t.ROWID, { merged_into_id: null }) }, { anyPerm: ['tables.manage', 'billing.create'] }),
})

define('customers', {
  list: userRead(async (c) => {
    const [rows, list] = await Promise.all([c.db.select('customers', { where: { business_id: c.businessId, is_active: true } }), wholesaleList(c)])
    const stats = await customerStats(c)
    return rows.map((r) => ({ ...customerFrom(r, list?.ROWID ?? null), stats: stats(r.ROWID) }))
  }, { anyPerm: CUSTOMER_READ }),
  /**
   * Only these customers (≤ 100), as customers.list gives them — for screens that show the customers of the bills
   * on screen (Orders, Payments, saved orders) instead of downloading every customer.
   */
  byIds: userRead(async (c, ids: unknown) => {
    const want = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(isId))].slice(0, CUSTOMER_PAGE * 2)
    if (!want.length) return []
    const [rows, list] = await Promise.all([c.db.select('customers', { where: { business_id: c.businessId, is_active: true, ROWID: { in: want } } }), wholesaleList(c)])
    return withStats(c, rows, list?.ROWID ?? null)
  }, { anyPerm: CUSTOMER_READ }),
  /**
   * The customer picker's search (≤ 50, oldest first, like the list it searched before): name contains the text,
   * or the phone contains its digits. Empty text: the first 50.
   */
  search: userRead(async (c, q: unknown) => {
    const text = String(q ?? '').trim().slice(0, 60), dial = text.replace(/\D/g, '')
    const base = { business_id: c.businessId, is_active: true }
    const read = (where: Where) => c.db.select('customers', { where: { ...base, ...where }, orderBy: [['ROWID', 'ASC']], limit: CUSTOMER_PAGE })
    const [byName, byPhone, list] = await Promise.all([read(text ? { name: { contains: text } } : {}), dial ? read({ phone: { contains: dial } }) : [], wholesaleList(c)])
    const seen = new Map<string, Row>()
    for (const r of [...byName, ...byPhone]) seen.set(r.ROWID, r)
    const rows = [...seen.values()].sort((a, b) => a.ROWID.length - b.ROWID.length || (a.ROWID < b.ROWID ? -1 : a.ROWID > b.ROWID ? 1 : 0)).slice(0, CUSTOMER_PAGE)
    return withStats(c, rows, list?.ROWID ?? null)
  }, { anyPerm: CUSTOMER_READ }),
  /** One customer with totals (a bill's drawer) — instead of the whole list. null when not found. */
  one: userRead(async (c, id: string) => {
    if (!isId(id)) return null
    const [r, list] = await Promise.all([c.db.first('customers', { ROWID: id, business_id: c.businessId }), wholesaleList(c)])
    if (!r) return null
    const stats = await customerStats(c, [r.ROWID])
    return { ...customerFrom(r, list?.ROWID ?? null), stats: stats(r.ROWID) }
  }, { anyPerm: CUSTOMER_READ }),
  history: userRead(async (c, customerId: string) => {
    await own(c, 'customers', customerId, 'Customer not found')
    const [orders, pays] = await Promise.all([
      loadOrders(c, { customer_id: customerId, status: { ne: E.OrderStatus.open } }, { limit: 500 }),
      c.db.select('payments', { where: { business_id: c.businessId, customer_id: customerId, is_voided: false }, orderBy: [['CREATEDTIME', 'DESC']], limit: 1000 }),
    ])
    // Staff limited to some branches see this customer's bills and payments in those branches only.
    return { orders: orders.filter((o) => mayUseBranch(c, o.branchId)), payments: pays.filter((p) => mayUseBranch(c, p.branch_id)).map(paymentFrom) }
  }, { anyPerm: ['customers.manage', 'orders.view'] }),
  save: userWrite(async (c, input: Partial<Customer> & { name: string }) => {
    const name = String(input.name ?? '').trim()
    if (!name) throw new ApiError('Enter the name')
    const phone = cleanPhone(input.phone, c.business.defaultCountry)
    const key = phone ? `${c.businessId}:${phone}` : null
    if (key) { const dup = await c.db.first('customers', { phone_key: key }); if (dup && dup.ROWID !== input.id) throw new ApiError('A customer with this phone already exists') }
    const list = input.priceTier !== undefined ? await wholesaleList(c) : null
    // Putting a customer on the wholesale list gives them wholesale prices on every bill: same permission as
    // changing prices (taking them off it, or saving them unchanged, needs nothing more).
    if (input.priceTier === 'wholesale' && list && !c.can('billing.price') && !c.can('settings.manage')) {
      const was = input.id && isId(input.id) ? await c.db.first('customers', { ROWID: input.id, business_id: c.businessId }) : null
      if (str(was?.price_list_id) !== list.ROWID) throw new ApiError('Putting a customer on the wholesale list needs the “Change item price” permission', 403, 'FORBIDDEN')
    }
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
  }, { anyPerm: ['billing.create', 'customers.manage', 'orders.view'] }),

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
    let left = money(amount, 'Amount', { positive: true })
    const dues = (await c.db.select('orders', { where: { business_id: c.businessId, customer_id: customerId, status: E.OrderStatus.completed, balance_minor: { gt: 0 } }, orderBy: [['billed_at', 'ASC']] }))
      .filter((o) => mayUseBranch(c, o.branch_id)) // dues of the user's own branches only
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

// ---------- a paged QR menu (over QR_MENU_FULL_MAX active items, one database per shop) ----------
// The phone gets the first page, the categories that have something to order and today's specials; each category,
// "more" and search is then one page from the server (public.menuItems) — never the whole catalogue.
const MENU_PAGE = 30

/** Is this shop's menu paged? One count of the active items (inactive ones are never on the menu); never on the Data Store. */
async function menuIsLarge(c: Ctx) {
  if (!c.dbs.perShop || !c.db.sql) return false
  const [r] = await c.db.sql('SELECT COUNT(*) AS n FROM "products" WHERE "business_id" = ? AND "is_active" = 1', [Number(c.business.id)])
  return Number(r?.n ?? 0) > QR_MENU_FULL_MAX
}
/** What a customer may order here: active, and (with Inventory on) not sold out in this branch — as the full menu. */
function orderable(c: Ctx, branchId: string): { join: string; where: string; args: Arg[] } {
  if (!c.business.modules.inventory) return { join: '', where: '', args: [] }
  return {
    join: 'LEFT JOIN (SELECT "product_id", SUM("qty_milli") AS "st" FROM "branch_stock" WHERE "business_id" = ? AND "branch_id" = ? GROUP BY "product_id") s ON s."product_id" = p."id"',
    where: ' AND NOT (p."track_stock" = 1 AND COALESCE(s."st", 0) <= 0)',
    args: [Number(c.business.id), Number(branchId)],
  }
}
const menuProducts = (c: Ctx, branchId: string, ids: string[]) =>
  ids.length ? loadProducts(c, { ids, activeOnly: true, branches: [branchId], withExpiry: false, withStock: !!c.business.modules.inventory, forCustomers: true }) : Promise.resolve([] as Product[])

/** One page of the menu: a category (or all), a name search, after the last row shown. Special prices applied. */
async function menuPage(c: Ctx, branchId: string, specials: Special[], o: { cat?: string | null; q?: string; after?: string | null }) {
  const ok = orderable(c, branchId)
  const cat = o.cat && isId(o.cat) ? { sql: ' AND p."category_id" = ?', args: [Number(o.cat)] as Arg[] } : { sql: '', args: [] as Arg[] }
  const q = nameLike(o.q), k = afterKey(o.after)
  const rows = await c.db.sql!(
    `SELECT p."id", p."sort_order" FROM "products" p ${ok.join} WHERE p."business_id" = ? AND p."is_active" = 1${ok.where}${cat.sql}${q.sql}${k.sql} ORDER BY p."sort_order", p."id" LIMIT ?`,
    [...ok.args, Number(c.business.id), ...cat.args, ...q.args, ...k.args, MENU_PAGE + 1],
  )
  const more = rows.length > MENU_PAGE
  const mine = more ? rows.slice(0, MENU_PAGE) : rows
  const last = mine[mine.length - 1]
  const products = applySpecials(await menuProducts(c, branchId, mine.map((r) => String(r.id))), specials).products
  return { products, next: more && last ? `${Number(last.sort_order)}:${Number(last.id)}` : null }
}

/** The QR menu (read from the database; public.menu keeps a copy in the shared cache). */
async function buildMenu(c: Ctx, businessId: string, branchId?: string | null, tableId?: string | null) {
  const { branch } = await guestSession(c, businessId, branchId, tableId)
  const b = c.business
  // QR ordering off: the page only says so (CustomerMenu) — no catalogue, table or specials reads.
  const on = !!b.modules.qrOrdering
  if (on && (await menuIsLarge(c))) return buildLargeMenu(c, branch)
  const [products, cats, tables, specials] = !on ? [[], [], [], []] as never : await Promise.all([
    loadProducts(c, { activeOnly: true, branches: [branch.ROWID], withExpiry: false, withStock: !!b.modules.inventory, forCustomers: true }), loadCategories(c),
    b.modules.tables ? c.db.select('dining_tables', { where: { business_id: b.id, branch_id: branch.ROWID, is_active: true } }) : [], b.modules.specials ? specialsFor(c, b.id, bizDay(c)) : [],
  ])
  const sp = applySpecials(b.modules.inventory ? products.filter((p) => !(p.trackStock && p.stock <= 0)) : products, specials)
  return {
    business: { id: b.id, name: b.name, logoEmoji: b.logoEmoji, logoUrl: b.logoUrl ?? null, subType: b.subType, address: b.address, phone: b.phone, defaultCountry: b.defaultCountry ?? 'IN', currencySymbol: b.currencySymbol, billing: publicBilling(b.billing), modules: b.modules, terminology: b.terminology, qr: qrSettings(b) },
    categories: cats, products: sp.products, specials: sp.specials, // read for customers: no cost, no wholesale prices
    specialInfo: [...sp.info.entries()].map(([productId, v]) => ({ productId, tag: v.special.tag, originalPrice: v.originalPrice, specialPrice: v.special.specialPrice })),
    tables: tables.map((t) => ({ id: t.ROWID, label: str(t.label) })),
    branch: { id: branch.ROWID, name: str(branch.name), address: str(branch.address), phone: str(branch.phone) },
    branchCount: c.s.allBranches.length,
  }
}

/** A paged menu (over QR_MENU_FULL_MAX active items): the first page, the categories with something to order, today's specials (same fields as the full one). */
async function buildLargeMenu(c: Ctx, branch: Row) {
  const b = c.business
  const ok = orderable(c, branch.ROWID)
  const [cats, tables, specials, catIds] = await Promise.all([
    loadCategories(c),
    b.modules.tables ? c.db.select('dining_tables', { where: { business_id: b.id, branch_id: branch.ROWID, is_active: true } }) : [],
    b.modules.specials ? specialsFor(c, b.id, bizDay(c)) : [],
    c.db.sql!(`SELECT DISTINCT p."category_id" AS id FROM "products" p ${ok.join} WHERE p."business_id" = ? AND p."is_active" = 1 AND p."category_id" IS NOT NULL${ok.where}`, [...ok.args, Number(b.id)]),
  ])
  const [first, specialRows] = await Promise.all([
    menuPage(c, branch.ROWID, specials, {}),
    menuProducts(c, branch.ROWID, [...new Set(specials.map((x) => x.productId))]),
  ])
  const sp = applySpecials(b.modules.inventory ? specialRows.filter((p) => !(p.trackStock && p.stock <= 0)) : specialRows, specials)
  const has = new Set(catIds.map((r) => String(r.id)))
  return {
    business: { id: b.id, name: b.name, logoEmoji: b.logoEmoji, logoUrl: b.logoUrl ?? null, subType: b.subType, address: b.address, phone: b.phone, defaultCountry: b.defaultCountry ?? 'IN', currencySymbol: b.currencySymbol, billing: publicBilling(b.billing), modules: b.modules, terminology: b.terminology, qr: qrSettings(b) },
    categories: cats.filter((x) => has.has(x.id)), products: first.products, specials: sp.specials,
    specialInfo: [...sp.info.entries()].map(([productId, v]) => ({ productId, tag: v.special.tag, originalPrice: v.originalPrice, specialPrice: v.special.specialPrice })),
    tables: tables.map((t) => ({ id: t.ROWID, label: str(t.label) })),
    branch: { id: branch.ROWID, name: str(branch.name), address: str(branch.address), phone: str(branch.phone) },
    branchCount: c.s.allBranches.length,
    /** Paged: more of "All", each category and search come from public.menuItems. */
    large: true as const, next: first.next,
  }
}

/** The TV specials board (public.specials keeps a copy in the shared cache). */
async function buildSpecials(c: Ctx, businessId: string) {
  await guestSession(c, businessId)
  const b = c.business
  // Specials off: an empty board, without reading the catalogue. On: only today's specials' items are read.
  const specials = b.modules.specials ? await specialsFor(c, b.id, bizDay(c)) : []
  const ids = [...new Set(specials.map((x) => x.productId))]
  const sp = applySpecials(ids.length ? await loadProducts(c, { ids, activeOnly: true, withExpiry: false, forCustomers: true }) : [], specials)
  return { business: { name: b.name, logoEmoji: b.logoEmoji, logoUrl: b.logoUrl ?? null, subType: b.subType, currencySymbol: b.currencySymbol, qr: qrSettings(b), qrOn: b.modules.qrOrdering, specialsOn: !!b.modules.specials }, items: sp.specials.map((p) => ({ product: p, ...sp.info.get(p.id)! })) }
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

  /**
   * A paged menu (over QR_MENU_FULL_MAX active items), one page at a time (CustomerMenu): `cat` = a category id ('' = all), `q` = a name search,
   * `after` = the last row's key. Category pages are kept in the shared cache like the menu; searches are not.
   */
  menuItems: publicRead(async (c, businessId: string, branchId: string, input?: { cat?: string | null; q?: string | null; after?: string | null }) => {
    if (!isId(businessId) || !isId(branchId)) throw new ApiError('Menu not found', 404)
    const cat = input?.cat && isId(input.cat) ? String(input.cat) : ''
    const q = String(input?.q ?? '').trim().slice(0, 100)
    const after = /^-?\d{1,9}:\d{1,16}$/.test(String(input?.after ?? '')) ? String(input?.after) : ''
    // Every read that isn't a cached copy (searches, a page not kept yet) is limited per network.
    const build = async () => {
      await rateLimit(c, `menuq:${businessId}`, 120, 'Too many requests from this network. Please wait a minute and try again.')
      const { branch } = await guestSession(c, businessId, branchId)
      const b = c.business
      if (!b.modules.qrOrdering || branch.ROWID !== branchId || !(await menuIsLarge(c))) return { value: { products: [] as Product[], next: null as string | null }, tz: b.timezone }
      const specials = b.modules.specials ? await specialsFor(c, b.id, bizDay(c)) : []
      return { value: await menuPage(c, branch.ROWID, specials, { cat, q, after }), tz: b.timezone }
    }
    if (q) return (await build()).value
    return cachedPublic(c, businessId, `menup:${branchId}:${cat || 'all'}:${after || '0'}`, build)
  }),

  placeOrder: publicWrite(async (c, businessId: string, input: PublicOrderInput) => {
    if (!isId(businessId)) throw new ApiError('Shop not found', 404)
    // Generous for a family on the restaurant's wifi; stops scripted floods of fake orders.
    await rateLimit(c, `place:${businessId}`, 20, 'Too many orders from this network. Please wait a minute and try again.')
    const { branch } = await guestSession(c, businessId, input?.branchId, input?.tableId)
    // The items' catalogue rows are read once: the price check here, the stock check and the order's own pricing
    // share them (an order writes none).
    c.memoCatalog()
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
    // Flood limits (a family orders 1–3 times; scripted fake orders hit these): per table, per phone, per shop.
    const busy = 'Too many orders right now. Please ask the staff or try again in a few minutes.'
    if (table) await limitIn(c, `qrt:${b.id}:${table.ROWID}`, 10, 10, busy)
    if (guest.phone) await limitIn(c, `qrp:${b.id}:${guest.phone}`, 5, 10, busy)
    await limitIn(c, `qrs:${b.id}`, 200, 60, 'This shop is getting too many online orders right now. Please order at the counter.')
    // Many orders from one network in a short time: they wait for staff even when orders are accepted automatically.
    const manyFromHere = (await countIn(c, `qra:${b.id}:${c.ip || 'unknown'}`, 5)) > 3
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 40) throw new ApiError('Add items to your order')
    if (input.items.some((i) => i?.addOnIds != null && !Array.isArray(i.addOnIds))) throw new ApiError('Check the add-ons on your order')
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
    // Link to an existing customer by phone, or create one (not opted into offers: the shop asks them first).
    let customerId: string | null = null
    let customer: Row | null = null
    if (guest.phone) {
      const key = `${b.id}:${guest.phone}`
      let cu = await c.db.first('customers', { phone_key: key })
      if (!cu) {
        try { cu = await c.db.insert('customers', { business_id: b.id, name: guest.name || 'Guest', phone: guest.phone, phone_key: key, address: guest.address || null, notes: 'Created from QR order', marketing_opt_in: false, is_active: true }) }
        catch (e) { if (!(e instanceof DuplicateError)) throw e; cu = await c.db.first('customers', { phone_key: key }) }
      }
      customerId = cu?.ROWID ?? null
      customer = cu ?? null
    }
    // A repeated request (same request id) returns the order already placed — accepted / logged once only.
    const info: { existing?: boolean } = {}
    const id = await writeOrder(c, { type: input.type, tableId: table?.ROWID ?? null, customerId, items: priced, discount: 0, notes: String(input.notes ?? '').slice(0, 200), source: 'qr' }, { qr: { guest, branchId: branch.ROWID, auto: qr.autoAccept }, info, customerRow: customer })
    if (qr.autoAccept && !info.existing && !manyFromHere) await acceptQr(c, id)
    // The order's row (read once): its number, and the customer's tracking link — a random code, never the row id
    // (kept if the request is repeated).
    const row = await c.db.get('orders', id)
    if (!row) throw new ApiError('Order not found', 404)
    const number = str(row.order_number)
    const trackCode = await ensureTrackCode(c, row)
    // Written with the order's other audit rows, in one insert when the order is saved (first, as before).
    if (!info.existing) await c.auditRow({ business_id: b.id, branch_id: branch.ROWID, user_id: null, entity: E.AuditEntity.order, entity_id: id, action: E.AuditAction.create, detail: `qr place ${number} ${input.type}` }, { first: true })
    return { orderId: id, number, trackCode }
    })
  }),

  /** Status for the customer's tracking screen — only that one order is exposed. */
  /** The tracking screen. Answered from the shared cache while nothing in the shop changed (no database read). */
  order: publicRead(async (c, businessId: string, ref: string) => {
    if (!isId(businessId)) throw new ApiError('Order not found', 404)
    // A tracking screen asks when opened / refreshed: room for many customers on one wifi, none for counting.
    await rateLimit(c, `order:${businessId}`, 120, 'Too many tries. Please wait a minute and try again.')
    return trackedView(c, businessId, await trackRef(c, businessId, String(ref ?? '')))
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
    // The tracking screen opens with the order's code (made now for counter orders), not its row id.
    return { orderId: await ensureTrackCode(c, hit), number: str(hit.order_number) }
  }),
  /** Browser push key for "Notify me" (null = push not set up: the page shows Refresh only). */
  pushKey: publicRead(async (c) => ({ publicKey: c.push?.publicKey ?? null })),
  subscribePush: { ...publicWrite(async (c, businessId: string, ref: string, sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }) => {
    if (!c.push) throw new ApiError('Notifications are not available')
    if (!isId(businessId)) throw new ApiError('Order not found', 404)
    await rateLimit(c, `push:${businessId}`, 20, 'Too many tries. Please wait a minute and try again.')
    // Only someone with the order's tracking link (its code) can follow it.
    const orderId = await trackRef(c, businessId, String(ref ?? ''))
    try { await c.useShop(businessId) } catch { throw new ApiError('Order not found', 404) }
    const endpoint = String(sub?.endpoint ?? ''), p256dh = String(sub?.keys?.p256dh ?? ''), auth = String(sub?.keys?.auth ?? '')
    if (!isPushEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) throw new ApiError('This browser can’t receive notifications')
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
    return cachedPublic(c, businessId, 'specials', async () => ({ value: await buildSpecials(c, businessId), tz: c.business.timezone }), 'board')
  }),
})

