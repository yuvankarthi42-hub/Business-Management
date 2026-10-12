// Orders / bills ⇄ tables (orders, order_items, order_item_addons, order_item_batches, payments,
// kitchen_tickets, kitchen_ticket_items, dining_tables). Same rules as the app's mock API.
import { computeTotals, r2, taxBreakup } from '@/core/pricing'
import { makeItem } from '@/core/orderItem'
import { applySpecials } from '@/core/specials'
import type { Customer, DiningTable, KitchenTicket, Order, OrderItem, OrderType, Payment, PaymentMethod } from '@/core/types'
import { randomBytes } from 'node:crypto'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { PLATFORM_TABLES, SHARED_TABLES, type TableName } from '../db/schema.gen'
import type { Db, Row, Where } from '../db/types'
import { DuplicateError } from '../db/types'
import { DEFAULT_SEQ } from './business'
import { loadProducts, wholesaleList } from './catalog'
import { moveStockMany, stockProduct } from './stock'
import { audit, bizDay, code, codeOrNull, E, fromMilli, fromMinor, isId, nameOf, nameOrNull, nextNumber, str, strOrNull, toBp, toMilli, toMinor } from './util'

export interface OrderDraft {
  id?: string
  type: OrderType
  tableId: string | null
  customerId: string | null
  items: OrderItem[]
  discount: number
  notes: string
  source: Order['source']
  fulfilment?: Order['fulfilment']
}
export interface PaymentInput { method: PaymentMethod; amount: number; reference?: string }

export const uuid = () => randomBytes(16).toString('hex')
/** The device's request id makes a re-sent bill idempotent; without one a fresh id is used. */
export const clientUuid = (c: Ctx, suffix = '') => (c.requestId ? `${c.requestId}${suffix}`.slice(0, 40) : uuid())

const chunks = <T,>(xs: T[], n = 100) => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out }
/** Rows whose `col` is one of `ids`. Platform tables are read from the platform database; pass `db` for the shared ones. */
export async function selectIn(c: Ctx, table: TableName, col: string, ids: string[], extra: Where = {}, db?: Db) {
  const out: Row[] = []
  if (!db && SHARED_TABLES.includes(table)) throw new Error(`selectIn ${table}: say which database (it is in both)`)
  const from = db ?? (PLATFORM_TABLES.includes(table) ? c.platform : c.db)
  for (const part of chunks([...new Set(ids)])) if (part.length) out.push(...await from.select(table, { where: { ...extra, [col]: { in: part } } }))
  return out
}

// ---------- mapping ----------
export function itemFrom(r: Row, addons: Row[]): OrderItem {
  return {
    id: r.ROWID, productId: str(r.product_id), name: str(r.product_name), variantId: strOrNull(r.variant_id), variantName: strOrNull(r.variant_name),
    addOns: addons.filter((a) => a.order_item_id === r.ROWID).map((a) => ({ id: str(a.addon_id) || a.ROWID, name: str(a.name), price: fromMinor(a.price_minor) })),
    qty: fromMilli(r.qty_milli), unit: str(r.unit), unitPrice: fromMinor(r.unit_price_minor), taxRate: Number(r.tax_bp ?? 0) / 100, notes: str(r.note),
    kotQty: fromMilli(r.kot_qty_milli), ...(r.price_list_id ? { priceTier: 'wholesale' as const } : {}),
  }
}
export function orderFrom(r: Row, items: OrderItem[]): Order {
  const balance = fromMinor(r.balance_minor), paid = fromMinor(r.paid_minor)
  const guest = r.customer_name || r.customer_phone || r.customer_address ? { name: str(r.customer_name), phone: str(r.customer_phone), address: str(r.customer_address) } : null
  return {
    id: r.ROWID, number: str(r.order_number), businessId: str(r.business_id), branchId: str(r.branch_id), type: nameOf(E.OrderType, r.order_type) as OrderType,
    tableId: strOrNull(r.table_id), customerId: strOrNull(r.customer_id), status: nameOf(E.OrderStatus, r.status) as Order['status'], items, notes: str(r.note),
    discount: fromMinor(r.discount_minor), subtotal: fromMinor(r.subtotal_minor), tax: fromMinor(r.tax_minor), roundOff: fromMinor(r.round_off_minor), total: fromMinor(r.total_minor),
    paid, balance, paymentStatus: balance <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
    invoiceNumber: strOrNull(r.invoice_number), billedAt: strOrNull(r.billed_at), cancelledAt: strOrNull(r.cancelled_at), cancelReason: strOrNull(r.cancel_reason),
    source: nameOf(E.OrderSource, r.source) as Order['source'],
    ...(r.qr_status != null ? { qrStatus: nameOf(E.QrStatus, r.qr_status) as Order['qrStatus'] } : {}),
    ...(r.fulfilment != null ? { fulfilment: nameOf(E.Fulfilment, r.fulfilment) as Order['fulfilment'] } : {}),
    ...(guest ? { guest } : {}),
    createdAt: r.CREATEDTIME, createdBy: str(r.created_by) || 'guest', updatedAt: r.MODIFIEDTIME, updatedBy: str(r.updated_by),
  }
}

/** Orders with their lines. `where` is always combined with the signed-in business. */
export async function loadOrders(c: Ctx, where: Where, opts: { orderBy?: [string, 'ASC' | 'DESC'][]; limit?: number; businessId?: string } = {}): Promise<Order[]> {
  const rows = await c.db.select('orders', { where: { ...where, business_id: opts.businessId ?? c.businessId }, orderBy: opts.orderBy ?? [['CREATEDTIME', 'DESC']], limit: opts.limit ?? 2000 })
  return withItems(c, rows)
}
export async function withItems(c: Ctx, rows: Row[]): Promise<Order[]> {
  if (!rows.length) return []
  const items = await selectIn(c, 'order_items', 'order_id', rows.map((r) => r.ROWID))
  const addons = items.length ? await selectIn(c, 'order_item_addons', 'order_item_id', items.map((i) => i.ROWID)) : []
  const byOrder = new Map<string, Row[]>()
  for (const i of items.sort((a, b) => Number(a.sort_order) - Number(b.sort_order))) byOrder.set(str(i.order_id), [...(byOrder.get(str(i.order_id)) ?? []), i])
  return rows.map((r) => orderFrom(r, (byOrder.get(r.ROWID) ?? []).map((i) => itemFrom(i, addons))))
}
export async function loadOrder(c: Ctx, id: string, opts: { inScope?: boolean; businessId?: string } = {}) {
  if (!isId(id)) throw new ApiError('Order not found', 404)
  const rows = await c.db.select('orders', { where: { ROWID: id, business_id: opts.businessId ?? c.businessId } })
  const r = rows[0]
  if (!r || (opts.inScope !== false && c.session && !c.inScope(str(r.branch_id)))) throw new ApiError('Order not found', 404)
  return { row: r, order: (await withItems(c, [r]))[0] }
}

export function paymentFrom(r: Row): Payment {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), orderId: strOrNull(r.order_id), customerId: strOrNull(r.customer_id),
    method: nameOf(E.PayMethod, r.method) as PaymentMethod, kind: nameOf(E.PaymentKind, r.kind) as Payment['kind'], amount: fromMinor(r.amount_minor),
    reference: str(r.reference), voided: !!r.is_voided, createdAt: r.CREATEDTIME, createdBy: str(r.created_by), updatedAt: r.MODIFIEDTIME, updatedBy: str(r.created_by),
  }
}
export async function kotsFrom(c: Ctx, rows: Row[]): Promise<KitchenTicket[]> {
  if (!rows.length) return []
  const items = await selectIn(c, 'kitchen_ticket_items', 'ticket_id', rows.map((r) => r.ROWID))
  return rows.map((k) => ({
    id: k.ROWID, number: str(k.number), businessId: str(k.business_id), branchId: str(k.branch_id), orderId: str(k.order_id), orderNumber: str(k.order_number),
    orderType: nameOf(E.OrderType, k.order_type) as OrderType, tableLabel: strOrNull(k.table_label),
    items: items.filter((i) => i.ticket_id === k.ROWID).map((i) => ({ name: str(i.name), qty: fromMilli(i.qty_milli), notes: str(i.note), isVeg: i.is_veg !== false })),
    status: nameOf(E.KotStatus, k.status) as KitchenTicket['status'], statusAt: k.MODIFIEDTIME,
    createdAt: k.CREATEDTIME, createdBy: str(k.created_by), updatedAt: k.MODIFIEDTIME, updatedBy: str(k.created_by),
  }))
}
export function tableFrom(r: Row): DiningTable {
  return { id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), label: str(r.label), floor: str(r.area) || 'Main', seats: Number(r.seats ?? 4), mergedInto: strOrNull(r.merged_into_id) }
}
export function customerFrom(r: Row, wholesaleListId: string | null): Customer {
  return {
    id: r.ROWID, businessId: str(r.business_id), name: str(r.name), phone: str(r.phone), email: str(r.email), address: str(r.address), notes: str(r.notes),
    marketingOptIn: r.marketing_opt_in !== false, priceTier: r.price_list_id && r.price_list_id === wholesaleListId ? 'wholesale' : 'retail',
    createdAt: r.CREATEDTIME, createdBy: '', updatedAt: r.MODIFIEDTIME, updatedBy: '',
  }
}

// ---------- pricing ----------
/**
 * Never trust prices from the browser: every line is re-priced from the catalogue (size, add-ons,
 * contractor rate, today's special, tax). Only the item, size, add-ons, quantity and note are taken from the request.
 */
export async function priceItems(c: Ctx, items: OrderItem[], previous: Map<string, Row> = new Map(), businessId = c.businessId, branchIds?: string[]) {
  const ids = [...new Set(items.map((i) => i.productId))]
  if (ids.some((id) => !isId(id))) throw new ApiError('An item on this bill was not found')
  const products = await loadProducts(c, { ids, withExpiry: false, withStock: false, branches: branchIds })
  const specials = (await c.db.select('daily_specials', { where: { business_id: businessId, special_date: bizDay(c) } })).map((r) => ({ id: r.ROWID, businessId, date: str(r.special_date), productId: str(r.product_id), specialPrice: r.offer_price_minor == null ? null : fromMinor(r.offer_price_minor), tag: str(r.tag), sort: Number(r.sort_order ?? 0) }))
  const priced = applySpecials(products, specials).products
  const billing = c.business.billing
  return items.map((i) => {
    const p = priced.find((x) => x.id === i.productId)
    const prev = isId(i.id) ? previous.get(i.id) : undefined
    if (!p) throw new ApiError('An item on this bill is no longer available')
    const qty = Number(i.qty)
    if (!(qty > 0) || qty > 100_000) throw new ApiError(`Check the quantity of ${p.name}`)
    const variant = i.variantId ? p.variants.find((v) => v.id === i.variantId) ?? null : null
    if (i.variantId && !variant) throw new ApiError(`${p.name}: that size is no longer available`)
    const addOns = (i.addOns ?? []).map((a) => p.addOns.find((x) => x.id === a.id)).filter(Boolean) as typeof p.addOns
    const item = makeItem(p, billing, { variant, addOns, qty, notes: String(i.notes ?? '').slice(0, 150), tier: i.priceTier })
    // Keep the line id and what the kitchen already has.
    return { ...item, id: prev ? prev.ROWID : i.id, kotQty: prev ? fromMilli(prev.kot_qty_milli) : 0, cost: p.costPrice, sendToKitchen: p.sendToKitchen, isVeg: p.isVeg }
  })
}
type PricedItem = Awaited<ReturnType<typeof priceItems>>[number]

const itemColumns = (c: Ctx, orderId: string, it: PricedItem, sort: number, listId: string | null) => ({
  business_id: c.businessId, order_id: orderId, product_id: it.productId, variant_id: it.variantId, product_name: it.name.slice(0, 150), variant_name: it.variantName?.slice(0, 60) ?? null,
  unit: (it.unit || 'pc').slice(0, 10), qty_milli: toMilli(it.qty), unit_price_minor: toMinor(it.unitPrice), price_list_id: it.priceTier === 'wholesale' ? listId : null,
  discount_minor: 0, tax_bp: toBp(it.taxRate), tax_minor: 0, line_total_minor: toMinor(r2(it.qty * it.unitPrice)), cost_minor: toMinor(it.cost ?? 0),
  note: it.notes.slice(0, 150) || null, kot_qty_milli: toMilli(it.kotQty), sort_order: sort,
})

async function writeItems(c: Ctx, orderId: string, items: PricedItem[], existing: Row[], listId: string | null) {
  const keep = new Set<string>()
  for (const [k, it] of items.entries()) {
    const ex = existing.find((r) => r.ROWID === it.id)
    if (ex) {
      keep.add(ex.ROWID)
      await c.db.update('order_items', ex.ROWID, itemColumns(c, orderId, it, k, listId))
      const oldAddons = await c.db.select('order_item_addons', { where: { order_item_id: ex.ROWID } })
      const same = oldAddons.length === it.addOns.length && it.addOns.every((a) => oldAddons.some((o) => o.addon_id === a.id))
      if (!same) {
        if (oldAddons.length) await c.db.deleteMany('order_item_addons', oldAddons.map((a) => a.ROWID))
        if (it.addOns.length) await c.db.insertMany('order_item_addons', it.addOns.map((a) => ({ business_id: c.businessId, order_item_id: ex.ROWID, addon_id: a.id, name: a.name.slice(0, 60), price_minor: toMinor(a.price) })))
      }
    }
  }
  // New lines in one insert, then all their add-ons in one more.
  const fresh = items.map((it, k) => ({ it, k })).filter(({ it }) => !existing.some((r) => r.ROWID === it.id))
  if (fresh.length) {
    const rows = await c.db.insertMany('order_items', fresh.map(({ it, k }) => itemColumns(c, orderId, { ...it, kotQty: 0 }, k, listId)))
    fresh.forEach(({ it }, n) => { it.id = rows[n].ROWID; keep.add(rows[n].ROWID) })
    const addons = fresh.flatMap(({ it }) => it.addOns.map((a) => ({ business_id: c.businessId, order_item_id: it.id, addon_id: a.id, name: a.name.slice(0, 60), price_minor: toMinor(a.price) })))
    if (addons.length) await c.db.insertMany('order_item_addons', addons)
  }
  const gone = existing.filter((r) => !keep.has(r.ROWID)).map((r) => r.ROWID)
  if (gone.length) await c.db.deleteMany('order_items', gone) // add-ons go with them (On Delete = Cascade)
}

const totalsColumns = (t: { subtotal: number; discount: number; tax: number; roundOff: number; total: number }, paid: number) => ({
  subtotal_minor: toMinor(t.subtotal), discount_minor: toMinor(t.discount), tax_minor: toMinor(t.tax), round_off_minor: toMinor(t.roundOff),
  total_minor: toMinor(t.total), balance_minor: toMinor(r2(t.total - paid)),
})

/** Create or update a running order (the app's writeOrder). Returns the order row id. */
export async function writeOrder(c: Ctx, draft: OrderDraft, opts: { qr?: { guest: { name: string; phone: string; address: string }; branchId: string; auto: boolean }; info?: { existing?: boolean } } = {}): Promise<string> {
  if (!Array.isArray(draft.items)) throw new ApiError('Add at least one item')
  if (!['counter', 'dine_in', 'takeaway', 'delivery'].includes(draft.type)) throw new ApiError('Choose the order type')
  const branchId = opts.qr ? opts.qr.branchId : null
  if (draft.tableId) {
    const t = await c.db.first('dining_tables', { ROWID: isId(draft.tableId) ? draft.tableId : '0', business_id: c.businessId })
    if (!t) throw new ApiError('Table not found')
  }
  if (draft.customerId) {
    const cu = await c.db.first('customers', { ROWID: isId(draft.customerId) ? draft.customerId : '0', business_id: c.businessId })
    if (!cu) throw new ApiError('Customer not found')
  }
  const list = draft.items.some((i) => i.priceTier === 'wholesale') ? await wholesaleList(c) : null
  if (draft.id) {
    const { row } = await loadOrder(c, draft.id)
    if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('Only running orders can be edited')
    const existing = await c.db.select('order_items', { where: { order_id: row.ROWID } })
    const items = await priceItems(c, draft.items, new Map(existing.map((r) => [r.ROWID, r])))
    const totals = computeTotals(items, draft.discount, c.business.billing)
    await writeItems(c, row.ROWID, items, existing, list?.ROWID ?? null)
    await c.db.update('orders', row.ROWID, {
      order_type: code(E.OrderType, draft.type), table_id: draft.tableId || null, customer_id: draft.customerId || null, note: String(draft.notes ?? '').slice(0, 255) || null,
      price_list_id: list?.ROWID ?? null, ...totalsColumns(totals, fromMinor(row.paid_minor)),
      ...(draft.fulfilment ? { fulfilment: code(E.Fulfilment, draft.fulfilment) } : {}), updated_by: c.actorId,
      row_version: Number(row.row_version) + 1, // a settle that read the old lines will now be refused
    })
    return row.ROWID
  }
  // Same request sent twice (retry after a network drop): return the order already made.
  const uuid = clientUuid(c, ':o')
  const again = await c.db.first('orders', { client_uuid: uuid })
  if (again) { if (str(again.business_id) !== c.businessId) throw new ApiError('Duplicate request', 409); if (opts.info) opts.info.existing = true; return again.ROWID }
  const items = await priceItems(c, draft.items, new Map(), c.businessId, branchId ? [branchId] : undefined)
  const totals = computeTotals(items, draft.discount, c.business.billing)
  const num = await nextNumber(c.db, c.businessId, null, 'order', { prefix: c.business.billing.orderPrefix ?? DEFAULT_SEQ.order.prefix, start: DEFAULT_SEQ.order.start })
  const g = opts.qr?.guest
  let row: Row
  try {
    row = await c.db.insert('orders', {
      business_id: c.businessId, branch_id: branchId ?? c.writeBranch(), client_uuid: uuid, order_number: num.text,
      order_type: code(E.OrderType, draft.type), source: code(E.OrderSource, draft.source || 'pos'), status: E.OrderStatus.open,
      table_id: draft.tableId || null, customer_id: draft.customerId || null, customer_name: g?.name?.slice(0, 120) || null, customer_phone: g?.phone || null, customer_address: g?.address?.slice(0, 255) || null,
      qr_status: opts.qr ? E.QrStatus.pending : null, fulfilment: codeOrNull(E.Fulfilment, draft.fulfilment ?? null),
      price_list_id: list?.ROWID ?? null, ...totalsColumns(totals, 0), paid_minor: 0, returned_minor: 0, note: String(draft.notes ?? '').slice(0, 255) || null,
      created_by: c.actorId, updated_by: c.actorId,
    })
  } catch (e) {
    if (e instanceof DuplicateError) { const r = await c.db.first('orders', { client_uuid: uuid }); if (r) { if (opts.info) opts.info.existing = true; return r.ROWID } }
    throw e
  }
  await writeItems(c, row.ROWID, items, [], list?.ROWID ?? null)
  if (c.session) await audit(c, 'order', row.ROWID, 'create', num.text, str(row.branch_id))
  return row.ROWID
}

/** Sends lines the kitchen hasn't seen (qty − already sent) as a new KOT. */
export async function kitchenDelta(c: Ctx, orderId: string, label?: string): Promise<KitchenTicket | null> {
  const { row, order } = await loadOrder(c, orderId, { inScope: false })
  const products = await loadProducts(c, { ids: [...new Set(order.items.map((i) => i.productId))], withExpiry: false })
  const lines = order.items.map((i) => ({ i, p: products.find((p) => p.id === i.productId) })).filter(({ i, p }) => (p?.sendToKitchen ?? true) && i.qty > i.kotQty)
  if (!lines.length) return null
  const table = row.table_id ? await c.db.get('dining_tables', str(row.table_id)) : null
  const num = await nextNumber(c.db, c.businessId, null, 'kot', { prefix: 'KOT-', start: 1 })
  const kot = await c.db.insert('kitchen_tickets', {
    business_id: c.businessId, branch_id: str(row.branch_id), order_id: row.ROWID, client_uuid: clientUuid(c, `:k${num.number}`),
    number: `KOT-${String(num.number).padStart(4, '0')}`, order_number: (label ?? str(row.order_number)).slice(0, 30), order_type: Number(row.order_type),
    status: E.KotStatus.new, table_label: table ? str(table.label) : null, created_by: c.actorId,
  })
  await c.db.insertMany('kitchen_ticket_items', lines.map(({ i, p }) => ({
    business_id: c.businessId, ticket_id: kot.ROWID, order_item_id: i.id,
    name: (i.name + (i.variantName ? ` (${i.variantName})` : '') + (i.addOns.length ? ` + ${i.addOns.map((a) => a.name).join(', ')}` : '')).slice(0, 150),
    qty_milli: toMilli(r2(i.qty - i.kotQty)), is_veg: p?.isVeg ?? true, note: i.notes.slice(0, 150) || null,
  })))
  await c.db.updateMany('order_items', lines.map(({ i }) => ({ ROWID: i.id, kot_qty_milli: toMilli(i.qty) })))
  return (await kotsFrom(c, [kot]))[0]
}

/** Use (part of) a credit note as payment. */
async function redeemCreditNote(c: Ctx, number: string, amount: number) {
  const no = String(number ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
  for (let attempt = 0; attempt < 6; attempt++) {
    const cn = no ? await c.db.first('sale_returns', { number_key: `${c.businessId}:${no}` }) : null
    if (!cn) throw new ApiError(`Credit note ${no} not found`.trim())
    const left = fromMinor(cn.credit_remaining_minor)
    if (left <= 0) throw new ApiError(`Credit note ${str(cn.number)} is already used`)
    if (amount > left + 0.001) throw new ApiError(`Credit note ${str(cn.number)} has only ${c.business.currencySymbol}${left.toFixed(2)} left`)
    if (await c.db.updateIfVersion('sale_returns', cn.ROWID, Number(cn.row_version), { credit_remaining_minor: toMinor(r2(left - amount)) })) return cn.ROWID
  }
  throw new ApiError('Busy — please try again', 409, 'CONFLICT')
}

/** Payment, bill number, stock out — the app's settle(). */
export async function settle(c: Ctx, orderId: string, pays: PaymentInput[]) {
  const { row, order } = await loadOrder(c, orderId, { inScope: false })
  if (Number(row.status) !== E.OrderStatus.open) throw new ApiError('Order is not running')
  const real = (pays ?? []).filter((p) => p.method !== 'credit' && Number(p.amount) > 0)
  for (const p of real) if (!['cash', 'upi', 'card', 'bank', 'credit_note'].includes(p.method)) throw new ApiError('Unknown payment method')
  const paidNow = r2(real.reduce((a, p) => a + Number(p.amount), 0))
  if (paidNow > r2(order.total - order.paid) + 0.001) throw new ApiError('Payment exceeds bill amount')
  const balance = r2(order.total - order.paid - paidNow)
  if (balance > 0 && !order.customerId) throw new ApiError('Select a customer to keep the balance as credit')
  if (!order.items.length) throw new ApiError('Add at least one item')

  // Bill number: the branch's own series when it has one, otherwise the business series.
  const br = c.session!.allBranches.find((b) => b.id === str(row.branch_id))
  const num = br?.invoicePrefix
    ? await nextNumber(c.db, c.businessId, br.id, 'invoice', { prefix: br.invoicePrefix, start: 10001 })
    : await nextNumber(c.db, c.businessId, null, 'invoice', { prefix: c.business.billing.invoicePrefix || 'INV-', start: DEFAULT_SEQ.invoice.start })
  // Claim the bill first (unique bill number) — then nothing is paid twice if two devices settle the same order.
  const claimed = await c.db.updateIfVersion('orders', row.ROWID, Number(row.row_version), {
    status: E.OrderStatus.completed, invoice_number: num.text, invoice_key: `${c.businessId}:${num.text}`, billed_at: c.now.toISOString(),
    paid_minor: toMinor(r2(order.paid + paidNow)), balance_minor: toMinor(balance),
    ...(row.fulfilment != null ? { fulfilment: E.Fulfilment.delivered } : {}), updated_by: c.actorId,
  })
  if (!claimed) throw new ApiError('This bill was just changed on another device. Please check it and try again.', 409, 'CONFLICT')
  try {
    for (const [k, p] of real.entries()) {
      const returnId = p.method === 'credit_note' ? await redeemCreditNote(c, p.reference ?? '', r2(Number(p.amount))) : null
      await c.db.insert('payments', {
        business_id: c.businessId, branch_id: str(row.branch_id), order_id: row.ROWID, customer_id: order.customerId, return_id: returnId, client_uuid: clientUuid(c, `:p${k}`),
        kind: E.PaymentKind.sale, method: code(E.PayMethod, p.method), amount_minor: toMinor(r2(Number(p.amount))), reference: String(p.reference ?? '').slice(0, 80) || null, is_voided: false, created_by: c.actorId,
      })
    }
  } catch (e) {
    // Payment failed (e.g. credit note already used): put the order back so it can be paid again.
    await c.db.update('orders', row.ROWID, { status: E.OrderStatus.open, invoice_number: null, invoice_key: null, billed_at: null, paid_minor: toMinor(order.paid), balance_minor: toMinor(order.total - order.paid) })
    throw e
  }
  // Stock out, first-expiry-first-out for batch items.
  const prows = await selectIn(c, 'products', 'ROWID', order.items.map((i) => i.productId), { business_id: c.businessId })
  const sold = order.items.map((i) => ({ i, p: prows.find((x) => x.ROWID === i.productId) })).filter((x): x is { i: OrderItem; p: Row } => !!x.p)
  const moved = await moveStockMany(c, sold.map(({ i, p }) => ({ p: stockProduct(p), branchId: str(row.branch_id), qty: -i.qty, reason: 'sale' as const, opts: { note: `Sold — ${num.text}`, refType: 'order' as const, refId: row.ROWID } })))
  const used = sold.flatMap(({ i }, k) => moved[k].batches.map((b) => ({ business_id: c.businessId, order_item_id: i.id, batch_id: b.batchId, qty_milli: b.qtyMilli })))
  if (used.length) await c.db.insertMany('order_item_batches', used)
  // GST break-up for the bill and reports.
  const lines = taxBreakup(order.items, order.discount, c.business.billing, order.tax)
  if (lines.length) await c.db.update('orders', row.ROWID, { tax_breakup_json: JSON.stringify(lines) })
  // Free merged tables.
  if (row.table_id) {
    const merged = await c.db.select('dining_tables', { where: { business_id: c.businessId, merged_into_id: str(row.table_id) } })
    if (merged.length) await c.db.updateMany('dining_tables', merged.map((t) => ({ ROWID: t.ROWID, merged_into_id: null })))
  }
  await audit(c, 'order', row.ROWID, 'update', `bill ${num.text} • ${order.total}`, str(row.branch_id))
}

export const statusName = (v: unknown) => nameOrNull(E.OrderStatus, v as number)
