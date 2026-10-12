// Billing & orders, kitchen tickets, tables, payments, customers & dues, QR orders and the public QR menu.
import { r2 } from '@/core/pricing'
import { qrSettings } from '@/core/config'
import { applySpecials } from '@/core/specials'
import { subscriptionState } from '@/core/subscription'
import type { Customer, DiningTable, KotStatus, Order, OrderType, PaymentMethod } from '@/core/types'
import type { Ctx, Session } from '../core/context'
import { ApiError } from '../core/errors'
import { define, publicRead, publicWrite, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row, type Where } from '../db/types'
import { loadBusiness } from '../domain/business'
import { loadCategories, loadProducts, wholesaleList } from '../domain/catalog'
import {
  customerFrom, kitchenDelta, kotsFrom, loadOrder, loadOrders, paymentFrom, priceItems, selectIn, settle, tableFrom, withItems, writeOrder, clientUuid,
  type OrderDraft, type PaymentInput,
} from '../domain/orders'
import { moveStock, stockProduct } from '../domain/stock'
import { audit, bizDay, bizDayStart, code, E, fromMinor, isId, keyPart, own, str, toMinor } from '../domain/util'
import { cleanPhone } from './business'
import { specialsFor } from './catalog'

const inScope = (c: Ctx): Where => ({ business_id: c.businessId, branch_id: { in: c.scope() } })
const isoArg = (v: unknown) => { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new ApiError('Choose a date range'); return d.toISOString() }
const one = async (c: Ctx, id: string) => (await loadOrder(c, id, { inScope: false })).order

/** Merge two lists of orders (two queries for an OR) without duplicates. */
const merged = (a: Order[], b: Order[]) => { const m = new Map(a.map((o) => [o.id, o])); for (const o of b) m.set(o.id, o); return [...m.values()] }

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
      await writeOrder(c, draft)
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

async function customerStats(c: Ctx, ids?: string[]) {
  const where: Where = { business_id: c.businessId, status: E.OrderStatus.completed, customer_id: ids ? { in: ids } : { ne: null } }
  const [o, r] = await Promise.all([
    c.db.aggregate('orders', { where, groupBy: ['customer_id'], fns: { total: ['SUM', 'total_minor'], n: ['COUNT', 'ROWID'], due: ['SUM', 'balance_minor'], last: ['MAX', 'billed_at'] } }),
    c.db.aggregate('sale_returns', { where: { business_id: c.businessId, customer_id: ids ? { in: ids } : { ne: null } }, groupBy: ['customer_id'], fns: { total: ['SUM', 'total_minor'] } }),
  ])
  return (id: string) => {
    const x = o.find((y) => y.customer_id === id), ret = r.find((y) => y.customer_id === id)
    return { totalPurchases: r2(fromMinor(x?.total) - fromMinor(ret?.total)), orderCount: Number(x?.n ?? 0), outstanding: fromMinor(x?.due), lastPurchase: (x?.last as string | null) ?? null }
  }
}

define('orders', {
  list: userRead(async (c, filter: { from?: string; to?: string; status?: Order['status'] | 'all' } = {}) => {
    const st: Where = filter.status && filter.status !== 'all' ? { status: code(E.OrderStatus, filter.status) } : {}
    if (!filter.from || !filter.to) return loadOrders(c, { ...inScope(c), ...st }, { limit: 500 })
    const range = { gte: isoArg(filter.from), lte: isoArg(filter.to) }
    const [created, billed] = await Promise.all([loadOrders(c, { ...inScope(c), ...st, CREATEDTIME: range }), loadOrders(c, { ...inScope(c), ...st, billed_at: range })])
    return merged(created, billed).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }),
  running: userRead(async (c) => loadOrders(c, { ...inScope(c), status: E.OrderStatus.open }, { orderBy: [['CREATEDTIME', 'ASC']] })),
  get: userRead(async (c, id: string) => {
    const { order } = await loadOrder(c, id)
    const [pays, kots] = await Promise.all([c.db.select('payments', { where: { business_id: c.businessId, order_id: order.id } }), c.db.select('kitchen_tickets', { where: { business_id: c.businessId, order_id: order.id } })])
    return { order, payments: pays.map(paymentFrom), kots: await kotsFrom(c, kots) }
  }),

  /** Create/update a running order (tables, mobile). Optionally sends new items to the kitchen. */
  save: userWrite(async (c, draft: OrderDraft, opts: { sendToKitchen?: boolean } = {}) => {
    if (draft.type === 'dine_in' && !draft.tableId) throw new ApiError('Select a table')
    if (draft.tableId && !draft.id && await c.db.first('orders', { ...inScope(c), status: E.OrderStatus.open, table_id: draft.tableId })) throw new ApiError('This table already has a running order')
    const id = await writeOrder(c, draft)
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
    await priceItems(c, draft.items, new Map(), c.businessId, undefined)
    await selectIn(c, 'products', 'ROWID', draft.items.map((i) => String(i.productId)), { business_id: c.businessId }) // what settle() reads for stock
    if (draft.items.some((i) => i.priceTier === 'wholesale')) await wholesaleList(c)
    const id = await c.tx(async () => {
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
    if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('Order is not running')
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
    if (wasBilled) {
      const prows = await selectIn(c, 'products', 'ROWID', order.items.map((i) => i.productId), { business_id: c.businessId })
      for (const i of order.items) { const p = prows.find((x) => x.ROWID === i.productId); if (p) await moveStock(c, stockProduct(p), str(row.branch_id), i.qty, 'return', { note: `Cancelled — ${order.invoiceNumber}`, refType: 'order', refId: row.ROWID }) }
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
      await writeOrder(c, { id: primary.id, type: primary.type, tableId: primary.tableId, customerId: primary.customerId, items: [...primary.items, ...other.items.map((i) => ({ ...i, id: `new_${i.id}` }))], discount: primary.discount + other.discount, notes: primary.notes, source: primary.source })
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
  }),
})

define('kitchen', {
  list: userRead(async (c) => {
    const [open, today] = await Promise.all([
      c.db.select('kitchen_tickets', { where: { ...inScope(c), status: { in: [E.KotStatus.new, E.KotStatus.preparing, E.KotStatus.ready] } } }),
      c.db.select('kitchen_tickets', { where: { ...inScope(c), CREATEDTIME: { gte: bizDayStart(c) } } }),
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
    const data = {
      name: name.slice(0, 120), phone: phone || null, phone_key: key, email: email.slice(0, 150) || null, address: String(input.address ?? '').slice(0, 255) || null, notes: String(input.notes ?? '').slice(0, 255) || null,
      ...(input.marketingOptIn !== undefined ? { marketing_opt_in: input.marketingOptIn !== false } : {}),
      ...(input.priceTier !== undefined ? { price_list_id: input.priceTier === 'wholesale' && list ? list.ROWID : null } : {}),
    }
    let row: Row
    if (input.id) { await own(c, 'customers', input.id, 'Customer not found'); row = await c.db.update('customers', input.id, data) }
    else { row = await c.db.insert('customers', { business_id: c.businessId, marketing_opt_in: true, is_active: true, ...data }); await audit(c, 'customer', row.ROWID, 'create', name) }
    return customerFrom(row, (list ?? await wholesaleList(c))?.ROWID ?? null)
  }, { perm: 'customers.manage' }),

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
define('public', {
  menu: publicRead(async (c, businessId: string, branchId?: string | null, tableId?: string | null) => {
    const { branch } = await guestSession(c, businessId, branchId, tableId)
    const b = c.business
    const [products, cats, tables, specials] = await Promise.all([
      loadProducts(c, { activeOnly: true, branches: [branch.ROWID], withExpiry: false }), loadCategories(c),
      c.db.select('dining_tables', { where: { business_id: b.id, branch_id: branch.ROWID, is_active: true } }), specialsFor(c, b.id, bizDay(c)),
    ])
    const sp = applySpecials(products.filter((p) => !(p.trackStock && p.stock <= 0)), specials)
    return {
      business: { id: b.id, name: b.name, logoEmoji: b.logoEmoji, subType: b.subType, address: b.address, phone: b.phone, defaultCountry: b.defaultCountry ?? 'IN', currencySymbol: b.currencySymbol, billing: b.billing, modules: b.modules, terminology: b.terminology, qr: qrSettings(b) },
      categories: cats, products: sp.products, specials: sp.specials,
      specialInfo: [...sp.info.entries()].map(([productId, v]) => ({ productId, tag: v.special.tag, originalPrice: v.originalPrice, specialPrice: v.special.specialPrice })),
      tables: tables.map((t) => ({ id: t.ROWID, label: str(t.label) })),
      branch: { id: branch.ROWID, name: str(branch.name), address: str(branch.address), phone: str(branch.phone) },
      branchCount: c.s.allBranches.length,
    }
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
    const stockRows = await selectIn(c, 'branch_stock', 'product_id', priced.map((p) => p.productId), { branch_id: branch.ROWID })
    const prods = await selectIn(c, 'products', 'ROWID', priced.map((p) => p.productId), { business_id: b.id })
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
  order: publicRead(async (c, businessId: string, orderId: string) => {
    if (!isId(businessId) || !isId(orderId)) throw new ApiError('Order not found', 404)
    try { await c.useShop(businessId) } catch { throw new ApiError('Order not found', 404) }
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
      number: o.number, type: o.type, status: o.status, qrStatus: into ? 'accepted' : o.qrStatus, total: o.total, items: o.items, table: table ? str(table.label) : null,
      cancelReason: into ? null : o.cancelReason,
      kitchen: kots.length ? (kots.includes(E.KotStatus.new) ? 'new' : kots.includes(E.KotStatus.preparing) ? 'preparing' : kots.includes(E.KotStatus.ready) ? 'ready' : 'completed') : null,
      paymentStatus: o.paymentStatus,
    }
  }),

  specials: publicRead(async (c, businessId: string) => {
    await guestSession(c, businessId)
    const b = c.business
    const sp = applySpecials(await loadProducts(c, { activeOnly: true, withExpiry: false }), await specialsFor(c, b.id, bizDay(c)))
    return { business: { name: b.name, logoEmoji: b.logoEmoji, subType: b.subType, currencySymbol: b.currencySymbol, qr: qrSettings(b), qrOn: b.modules.qrOrdering }, items: sp.specials.map((p) => ({ product: p, ...sp.info.get(p.id)! })) }
  }),
})

