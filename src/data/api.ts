// Mock API. Every function is async and scoped to the logged-in business/branch, exactly like the
// future REST API backed by MySQL. To migrate: implement the same `api` shape with fetch() calls
// (see server/README.md) and switch the export in src/data/index.ts. UI code never touches the DB directly.
import { computeTotals, r2 } from '@/core/pricing'
import { isHardware, isSupermarket, modulesFor, qrSettings, templateFor } from '@/core/config'
import { applySpecials, dateKey } from '@/core/specials'
import { COUNTRIES, normalizePhone } from '@/core/phone'
import { makeItem } from '@/core/orderItem'
import type {
  Branch, Business, Category, Customer, DiningTable, Expense, KitchenTicket, KotStatus, Order, OrderItem, OrderType, Payment,
  Campaign, ID, PaymentMethod, Permission, Product, Role, Special, StockMovement, StockMovementType, User,
  AdminAuditLog, AdminRole, PlatformAdmin, SubscriptionPeriod, WaMessage, WaTemplate, WhatsAppConfig, ReturnReason, SaleReturn, SaleReturnLine, AttendanceStatus, SalaryPayment, StaffPay, ReminderSettings, BranchPrinter, Ticket, TicketCategory, TicketPriority, TicketStatus,
} from '@/core/types'
import { uid } from '@/lib/format'
import { nextInStoreBarcode } from '@/lib/barcode'
import { getDB, notify, resetDB, tx as dbTx, type DB } from './db'
import { addMonths, branchLimitMessage, dateInputToEnd, DEACTIVATED_MESSAGE, endOfDay, periodAmount, READ_ONLY_MESSAGE, subscriptionState } from '@/core/subscription'
import { ownerOf } from './seedPlatform'
import { compressImage, ensureStoredImage } from './media'
import { ADMIN_ROLES, adminCan, type AdminPermission } from '@/core/adminRoles'
import { FEATURES, featureOn, featuresFor, type FeatureFlag, type FeatureKey } from '@/core/features'
import { renderTemplate, templateErrors, WA_KIND, type WaLang, type WaTemplateKind } from '@/core/whatsapp'
import type { ImportItem } from '@/core/productImport'
import { daysText, REMINDER_SAMPLE, reminderTemplateErrors } from '@/core/reminders'
import { addDemoBranches, defaultRoles, newBusiness } from './seed'

// ---------- Session (the backend would use a JWT instead) ----------

/** branchId = a branch id, or 'all' for a combined (read-only) view across the user's branches. */
export interface Session {
  userId: string; businessId: string; branchId: string
  /** Set when a product admin opens this account in read-only support view. */
  support?: { adminId: string; adminName: string; reason: string; startedAt: string }
}
export const ALL_BRANCHES = 'all'
const DEMO_BUSINESSES = ['biz_foodcorner', 'biz_sweetspot', 'biz_freshmart', 'biz_murugan_hw']
const SESSION_KEY = 'billpoodum.session'

export const session = {
  get(): Session | null {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
  },
  set(s: Session | null) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  },
}

class ApiError extends Error {}

/**
 * Every customer write goes through here. An expired subscription makes the account read-only and a
 * deactivated one can't change anything — enforced in the API, not just hidden in the UI
 * (the real server does the same check in middleware before any INSERT / UPDATE / DELETE).
 */
function tx<T>(fn: (d: DB) => T): T {
  return dbTx((d) => {
    const s = session.get()
    if (s?.support) throw new ApiError(SUPPORT_MESSAGE)
    if (s) assertWritable(d.businesses.find((b) => b.id === s.businessId))
    return fn(d)
  })
}
const SUPPORT_MESSAGE = 'Support view is read-only — nothing can be changed from here.'
/** Same checks as a write, for async work done before the transaction (e.g. compressing a photo). */
function assertCanWrite(d: DB, perm: Permission) {
  const s = session.get()
  if (s?.support) throw new ApiError(SUPPORT_MESSAGE)
  if (s) assertWritable(d.businesses.find((b) => b.id === s.businessId))
  requirePerm(d, perm)
}
async function storeImage(url: string | null | undefined, thumb?: string | null) {
  try { return await ensureStoredImage(url, thumb) } catch (e) { throw new ApiError((e as Error).message) }
}
function assertWritable(b: Business | undefined) {
  if (!b) return
  const st = subscriptionState(b)
  if (st.blocked) throw new ApiError(DEACTIVATED_MESSAGE)
  if (st.readOnly) throw new ApiError(READ_ONLY_MESSAGE)
}

function ctx() {
  const s = session.get()
  if (!s) throw new ApiError('Not signed in')
  return s
}

const nowIso = () => new Date().toISOString()
const stamp = (userId: string) => { const t = nowIso(); return { createdAt: t, createdBy: userId, updatedAt: t, updatedBy: userId } }
const touch = <T extends { updatedAt: string; updatedBy: string }>(o: T, userId: string) => { o.updatedAt = nowIso(); o.updatedBy = userId; return o }
const clone = <T,>(v: T): T => structuredClone(v)

function permissionsOf(d: DB, user: User): Set<Permission> | 'all' {
  const role = d.roles.find((r) => r.id === user.roleId)
  if (!role) return new Set()
  if ((role.permissions as string[]).includes('*')) return 'all'
  return new Set(role.permissions as Permission[])
}

function requirePerm(d: DB, p: Permission) {
  const s = ctx()
  const user = d.users.find((u) => u.id === s.userId)
  if (!user) throw new ApiError('User not found')
  const perms = permissionsOf(d, user)
  if (perms !== 'all' && !perms.has(p)) throw new ApiError('You do not have permission to do this')
  return s
}

function audit(d: DB, entity: string, entityId: string, action: string, detail = '') {
  const s = ctx()
  d.auditLogs.push({ id: uid('aud_'), businessId: s.businessId, entity, entityId, action, userId: s.userId, at: nowIso(), detail })
}

const biz = (d: DB) => d.businesses.find((b) => b.id === ctx().businessId)!

/** Validate + normalise a mobile number to E.164 using the business's country as default. */
function cleanPhone(input: string | null | undefined, defaultIso: string | undefined, opts: { required?: string } = {}): string {
  let e164: string | null
  try { e164 = normalizePhone(input, defaultIso || 'IN') } catch (e) { throw new ApiError((e as Error).message) }
  if (!e164 && opts.required) throw new ApiError(opts.required)
  return e164 ?? ''
}
const mine = <T extends { businessId: string }>(rows: T[]) => { const b = ctx().businessId; return rows.filter((r) => r.businessId === b) }

// ---------- Branch scoping ----------

/** Branch ids a user may open. Owner (full access) = every branch of the business. */
function allowedBranches(d: DB, user: User): string[] {
  const all = d.branches.filter((b) => b.businessId === user.businessId).map((b) => b.id)
  if (permissionsOf(d, user) === 'all') return all
  const ids = user.branchIds?.length ? user.branchIds : [user.branchId]
  return ids.filter((id) => all.includes(id))
}

/** Branches the current view covers: the selected one, or all allowed ones in "All branches". */
function scope(d: DB): Set<string> {
  const s = ctx()
  const user = d.users.find((u) => u.id === s.userId)
  const allowed = user ? allowedBranches(d, user) : [s.branchId]
  if (s.branchId === ALL_BRANCHES) return new Set(allowed)
  return new Set(allowed.includes(s.branchId) ? [s.branchId] : allowed.slice(0, 1))
}

/** Rows of this business limited to the current branch view. */
const here = <T extends { businessId: string; branchId: string }>(d: DB, rows: T[]) => {
  const sc = scope(d)
  return mine(rows).filter((r) => sc.has(r.branchId))
}

/** The branch a write goes to. "All branches" is read-only for day-to-day work. */
function writeBranch(d: DB, opts: { fallback?: boolean; requested?: string } = {}): string {
  const s = ctx()
  if (s.branchId !== ALL_BRANCHES) return s.branchId
  const sc = scope(d)
  if (opts.requested && sc.has(opts.requested)) return opts.requested
  if (opts.fallback) {
    const user = d.users.find((u) => u.id === s.userId)
    return user && sc.has(user.branchId) ? user.branchId : [...sc][0]
  }
  throw new ApiError('Choose a branch first (top bar)')
}

const stockIn = (p: Product, branches: Iterable<string>) => {
  let n = 0
  for (const b of branches) n += p.stockByBranch?.[b] ?? 0
  return r2(n)
}

const inRange = (iso: string | null, from: Date, to: Date) => !!iso && iso >= from.toISOString() && iso <= to.toISOString()

// ---------- Orders: shared write helpers ----------

export interface OrderDraft {
  id?: string
  type: OrderType
  tableId: string | null
  customerId: string | null
  items: OrderItem[]
  discount: number
  notes: string
  source: Order['source']
  /** Set when this is a customer order to pack and deliver (supermarket orders board). */
  fulfilment?: Order['fulfilment']
}

export interface PaymentInput { method: PaymentMethod; amount: number; reference?: string }

function writeOrder(d: DB, draft: OrderDraft): Order {
  const s = ctx()
  const b = biz(d)
  const totals = computeTotals(draft.items, draft.discount, b.billing)
  if (draft.id) {
    const o = d.orders.find((x) => x.id === draft.id && x.businessId === s.businessId)
    if (!o) throw new ApiError('Order not found')
    if (o.status !== 'open') throw new ApiError('Only running orders can be edited')
    Object.assign(o, { type: draft.type, tableId: draft.tableId, customerId: draft.customerId, items: draft.items, notes: draft.notes, ...totals })
    if (draft.fulfilment) o.fulfilment = draft.fulfilment
    o.balance = r2(o.total - o.paid)
    touch(o, s.userId)
    return o
  }
  const o: Order = {
    id: uid('ord_'), number: `${b.billing.orderPrefix}${b.billing.nextOrderNumber++}`,
    businessId: s.businessId, branchId: writeBranch(d), type: draft.type, tableId: draft.tableId, customerId: draft.customerId,
    status: 'open', items: draft.items, notes: draft.notes, ...totals, paid: 0, balance: totals.total, paymentStatus: 'unpaid',
    invoiceNumber: null, billedAt: null, cancelledAt: null, cancelReason: null, source: draft.source, ...stamp(s.userId),
    ...(draft.fulfilment ? { fulfilment: draft.fulfilment } : {}),
  }
  d.orders.push(o)
  audit(d, 'order', o.id, 'create', o.number)
  return o
}

function kitchenDelta(d: DB, o: Order, userId: string = ctx().userId): KitchenTicket | null {
  const b = d.businesses.find((x) => x.id === o.businessId)!
  const lines = o.items
    .map((i) => ({ i, p: d.products.find((p) => p.id === i.productId) }))
    .filter(({ i, p }) => (p?.sendToKitchen ?? true) && i.qty > i.kotQty)
  if (!lines.length) return null
  const table = d.tables.find((t) => t.id === o.tableId)
  const kot: KitchenTicket = {
    id: uid('kot_'), number: `KOT-${String(b.billing.nextKotNumber++).padStart(4, '0')}`,
    businessId: o.businessId, branchId: o.branchId, orderId: o.id, orderNumber: o.number, orderType: o.type,
    tableLabel: table?.label ?? null,
    items: lines.map(({ i, p }) => ({
      name: i.name + (i.variantName ? ` (${i.variantName})` : '') + (i.addOns.length ? ` + ${i.addOns.map((a) => a.name).join(', ')}` : ''),
      qty: r2(i.qty - i.kotQty), notes: i.notes, isVeg: p?.isVeg ?? true,
    })),
    status: 'new', statusAt: nowIso(), ...stamp(userId),
  }
  o.items.forEach((i) => { i.kotQty = i.qty })
  d.kots.push(kot)
  return kot
}

export interface BatchInput { batchNo?: string; expiry?: string }

/** Batches in one branch, first-expiry-first (unknown expiry last). */
const fefo = (d: DB, productId: string, branchId: string) =>
  d.batches.filter((x) => x.productId === productId && x.branchId === branchId && x.qty > 0)
    .sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'))

/** Keep batch quantities in step with a stock change (only for products that track expiry). */
function moveBatches(d: DB, p: Product, branchId: string, qty: number, batch: BatchInput | undefined, userId: string) {
  if (!p.trackExpiry || qty === 0) return
  if (qty > 0) {
    const no = (batch?.batchNo ?? '').trim()
    const expiry = batch?.expiry ?? ''
    let target = batch ? d.batches.find((x) => x.productId === p.id && x.branchId === branchId && x.batchNo === no && x.expiry === expiry) : undefined
    // Returns without batch info go back to the newest batch.
    if (!target && !batch) target = d.batches.filter((x) => x.productId === p.id && x.branchId === branchId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (target) { target.qty = r2(target.qty + qty); target.receivedQty = r2(target.receivedQty + (batch ? qty : 0)); touch(target, userId); return }
    d.batches.push({ id: uid('bat_'), businessId: p.businessId, branchId, productId: p.id, batchNo: no, expiry, qty: r2(qty), receivedQty: r2(qty), ...stamp(userId) })
    return
  }
  let left = -qty
  for (const bt of fefo(d, p.id, branchId)) {
    if (left <= 0) break
    const take = Math.min(bt.qty, left)
    bt.qty = r2(bt.qty - take); left = r2(left - take); touch(bt, userId)
  }
}

function moveStock(d: DB, productId: string, type: StockMovementType, qty: number, note: string, refId: string | null = null, branchId?: string, batch?: BatchInput) {
  const s = ctx()
  const p = d.products.find((x) => x.id === productId)
  if (!p || !p.trackStock || qty === 0) return
  const b = branchId ?? writeBranch(d)
  moveBatches(d, p, b, qty, batch, s.userId)
  p.stockByBranch ??= {}
  p.stockByBranch[b] = r2((p.stockByBranch[b] ?? 0) + qty)
  p.stock = r2(Object.values(p.stockByBranch).reduce((a, v) => a + v, 0))
  d.stockMovements.push({ id: uid('stm_'), businessId: s.businessId, branchId: b, productId, type, qty, balanceAfter: p.stockByBranch[b], refId, note, ...stamp(s.userId) })
}

/** Use (part of) a credit note as payment. */
function redeemCreditNote(d: DB, number: string, amount: number) {
  const cn = mine(d.returns).find((r) => r.number.toUpperCase() === number.trim().toUpperCase())
  if (!cn) throw new ApiError(`Credit note ${number || ''} not found`.trim())
  if (cn.creditRemaining <= 0) throw new ApiError(`Credit note ${cn.number} is already used`)
  if (amount > cn.creditRemaining + 0.001) throw new ApiError(`Credit note ${cn.number} has only ${biz(d).currencySymbol}${cn.creditRemaining.toFixed(2)} left`)
  cn.creditRemaining = r2(cn.creditRemaining - amount)
}

function settle(d: DB, o: Order, pays: PaymentInput[]) {
  const s = ctx()
  const b = biz(d)
  const real = pays.filter((p) => p.method !== 'credit' && p.amount > 0)
  const paidNow = r2(real.reduce((a, p) => a + p.amount, 0))
  if (paidNow > r2(o.total - o.paid) + 0.001) throw new ApiError('Payment exceeds bill amount')
  const balance = r2(o.total - o.paid - paidNow)
  if (balance > 0 && !o.customerId) throw new ApiError('Select a customer to keep the balance as credit')
  for (const p of real) {
    if (p.method === 'credit_note') redeemCreditNote(d, p.reference ?? '', r2(p.amount))
    d.payments.push({
      id: uid('pay_'), businessId: s.businessId, branchId: o.branchId, orderId: o.id, customerId: o.customerId,
      method: p.method, kind: 'sale', amount: r2(p.amount), reference: p.reference ?? '', voided: false, ...stamp(s.userId),
    })
  }
  o.paid = r2(o.paid + paidNow)
  o.balance = balance
  o.paymentStatus = balance <= 0 ? 'paid' : o.paid > 0 ? 'partial' : 'unpaid'
  o.status = 'completed'
  if (o.fulfilment) o.fulfilment = 'delivered'
  const br = d.branches.find((x) => x.id === o.branchId)
  if (br?.invoicePrefix) {
    br.nextInvoiceNumber ??= 10001
    o.invoiceNumber = `${br.invoicePrefix}${br.nextInvoiceNumber++}`
  } else {
    o.invoiceNumber = `${b.billing.invoicePrefix}${b.billing.nextInvoiceNumber++}`
  }
  o.billedAt = nowIso()
  touch(o, s.userId)
  for (const i of o.items) moveStock(d, i.productId, 'sale', -i.qty, `Sold — ${o.invoiceNumber}`, o.id, o.branchId)
  // Free merged tables
  if (o.tableId) d.tables.forEach((t) => { if (t.mergedInto === o.tableId) t.mergedInto = null })
  audit(d, 'order', o.id, 'bill', `${o.invoiceNumber} • ${o.total}`)
}

// ---------- Reporting ----------

export interface Summary {
  sales: number
  orderCount: number
  avgOrder: number
  paymentsReceived: number
  /** Expenses other than staff salary. */
  expenses: number
  /** Staff salary and advances paid (expense category 'salary'), shown on its own. */
  salary: number
  /** sales − returns − expenses − salary */
  net: number
  outstanding: number
  tax: number
  discount: number
  cogs: number
  salesByMethod: Record<PaymentMethod, number>
  paymentsByMethod: Record<PaymentMethod, number>
  expensesByCategory: Record<string, number>
  byType: Record<string, { count: number; amount: number }>
  topProducts: { productId: string; name: string; emoji: string; imageUrl: string | null; qty: number; revenue: number }[]
  series: { label: string; key: string; sales: number; orders: number; expenses: number }[]
  cancelled: number
  /** Value returned (credit notes) in the period — net sales = sales − returns. */
  returns: number
  returnCount: number
}

function summarize(d: DB, from: Date, to: Date, branches: Set<string> = scope(d)): Summary {
  const inB = <T extends { businessId: string; branchId: string }>(rows: T[]) => mine(rows).filter((r) => branches.has(r.branchId))
  const orders = inB(d.orders).filter((o) => o.status === 'completed' && inRange(o.billedAt, from, to))
  const payments = inB(d.payments).filter((p) => !p.voided && inRange(p.createdAt, from, to))
  const expenses = inB(d.expenses).filter((e) => !e.voided && inRange(e.date, from, to))
  const methods: PaymentMethod[] = ['cash', 'upi', 'card', 'bank', 'credit', 'credit_note']
  const zero = () => Object.fromEntries(methods.map((m) => [m, 0])) as Record<PaymentMethod, number>
  const salesByMethod = zero()
  const paymentsByMethod = zero()
  const orderIds = new Set(orders.map((o) => o.id))
  const salePays = inB(d.payments).filter((p) => !p.voided && p.kind === 'sale' && p.orderId && orderIds.has(p.orderId))
  for (const p of salePays) salesByMethod[p.method] += p.amount
  for (const o of orders) {
    const paidAtSale = salePays.filter((p) => p.orderId === o.id).reduce((a, p) => a + p.amount, 0)
    salesByMethod.credit += Math.max(0, o.total - paidAtSale)
  }
  // A credit note used on a bill isn't new money — it was counted when the goods were first sold.
  for (const p of payments) if (p.method !== 'credit_note') paymentsByMethod[p.method] += p.kind === 'refund' ? -p.amount : p.amount
  const expensesByCategory: Record<string, number> = {}
  for (const e of expenses) if (e.category !== 'salary') expensesByCategory[e.category] = (expensesByCategory[e.category] ?? 0) + e.amount
  const byType: Summary['byType'] = {}
  const prod = new Map<string, Summary['topProducts'][number]>()
  let cogs = 0
  for (const o of orders) {
    byType[o.type] = { count: (byType[o.type]?.count ?? 0) + 1, amount: (byType[o.type]?.amount ?? 0) + o.total }
    for (const i of o.items) {
      const p = d.products.find((x) => x.id === i.productId)
      const cur = prod.get(i.productId) ?? { productId: i.productId, name: i.name, emoji: p?.emoji ?? '📦', imageUrl: p?.imageUrl ?? null, qty: 0, revenue: 0 }
      cur.qty += i.qty
      cur.revenue += i.qty * i.unitPrice
      prod.set(i.productId, cur)
      cogs += (p?.costPrice ?? 0) * i.qty
    }
  }
  // Time series: hourly for a single day, daily otherwise.
  const days = Math.round((to.getTime() - from.getTime()) / 86400000)
  const series: Summary['series'] = []
  if (days <= 1) {
    for (let h = 8; h <= 23; h++) series.push({ key: String(h), label: `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`, sales: 0, orders: 0, expenses: 0 })
    for (const o of orders) {
      const h = new Date(o.billedAt!).getHours()
      const row = series.find((r) => r.key === String(Math.max(8, h)))
      if (row) { row.sales += o.total; row.orders++ }
    }
  } else {
    for (let t = new Date(from); t <= to; t.setDate(t.getDate() + 1)) {
      series.push({ key: t.toDateString(), label: t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), sales: 0, orders: 0, expenses: 0 })
    }
    for (const o of orders) { const r = series.find((x) => x.key === new Date(o.billedAt!).toDateString()); if (r) { r.sales += o.total; r.orders++ } }
    for (const e of expenses) { const r = series.find((x) => x.key === new Date(e.date).toDateString()); if (r && e.category !== 'salary') r.expenses += e.amount }
  }
  const rets = inB(d.returns).filter((r) => inRange(r.createdAt, from, to))
  const returns = r2(rets.reduce((a, r) => a + r.total, 0))
  for (const r of rets) for (const l of r.lines) { const p = d.products.find((x) => x.id === l.productId); if (l.restock) cogs -= (p?.costPrice ?? 0) * l.qty }
  const sales = r2(orders.reduce((a, o) => a + o.total, 0))
  const salary = r2(expenses.filter((e) => e.category === 'salary').reduce((a, e) => a + e.amount, 0))
  const exp = r2(expenses.filter((e) => e.category !== 'salary').reduce((a, e) => a + e.amount, 0))
  return {
    sales, orderCount: orders.length, avgOrder: orders.length ? r2(sales / orders.length) : 0,
    paymentsReceived: r2(payments.filter((p) => p.method !== 'credit_note').reduce((a, p) => a + (p.kind === 'refund' ? -p.amount : p.amount), 0)),
    expenses: exp, salary, net: r2(sales - returns - exp - salary), returns, returnCount: rets.length,
    outstanding: r2(orders.reduce((a, o) => a + o.balance, 0)),
    tax: r2(orders.reduce((a, o) => a + o.tax, 0)), discount: r2(orders.reduce((a, o) => a + o.discount, 0)), cogs: r2(cogs),
    salesByMethod, paymentsByMethod, expensesByCategory, byType,
    topProducts: [...prod.values()].sort((a, b) => b.revenue - a.revenue),
    series,
    cancelled: inB(d.orders).filter((o) => o.status === 'cancelled' && inRange(o.cancelledAt, from, to)).length,
  }
}

export interface CustomerStats {
  totalPurchases: number
  orderCount: number
  outstanding: number
  lastPurchase: string | null
}

function customerStats(d: DB, customerId: string): CustomerStats {
  const orders = mine(d.orders).filter((o) => o.customerId === customerId && o.status === 'completed')
  const returned = mine(d.returns).filter((r) => r.customerId === customerId).reduce((a, r) => a + r.total, 0)
  return {
    totalPurchases: r2(orders.reduce((a, o) => a + o.total, 0) - returned),
    orderCount: orders.length,
    outstanding: r2(orders.reduce((a, o) => a + o.balance, 0)),
    lastPurchase: orders.map((o) => o.billedAt!).sort().at(-1) ?? null,
  }
}

/** Validates a branch list for a staff member; the first one becomes their default branch. */
function branchAccess(d: DB, businessId: string, ids: string[]) {
  const valid = ids.filter((id) => d.branches.some((b) => b.id === id && b.businessId === businessId))
  if (!valid.length) throw new ApiError('Select at least one branch')
  return { branchId: valid[0], branchIds: valid }
}

// ---------- Specials & QR helpers ----------

function specialsFor(d: DB, businessId: string, date = dateKey()) {
  return d.specials.filter((x) => x.businessId === businessId && x.date === date)
}

/** Merge a QR request into the table's existing running order (if any), then send to kitchen. */
function acceptQr(d: DB, o: Order, userId: string) {
  o.qrStatus = 'accepted'
  const running = o.tableId ? d.orders.find((x) => x.id !== o.id && x.businessId === o.businessId && x.status === 'open' && x.tableId === o.tableId && x.qrStatus !== 'pending') : null
  const b = d.businesses.find((x) => x.id === o.businessId)!
  let target = o
  if (running) {
    running.items = [...running.items, ...o.items]
    Object.assign(running, computeTotals(running.items, running.discount, b.billing))
    running.balance = r2(running.total - running.paid)
    if (!running.customerId) running.customerId = o.customerId
    o.status = 'cancelled'; o.cancelledAt = nowIso(); o.cancelReason = `Merged into ${running.number}`
    target = running
  }
  const kot = b.modules.kitchen ? kitchenDelta(d, target, userId) : null
  if (kot) kot.orderNumber = `${target.number} · QR`
  return target
}

/** Branch for a public (QR) request: the requested open branch, else the main branch. */
function publicBranch(d: DB, businessId: string, branchId?: string | null) {
  const all = d.branches.filter((x) => x.businessId === businessId)
  const br = all.find((x) => x.id === branchId && x.active !== false) ?? all.find((x) => x.isDefault) ?? all[0]
  if (!br) throw new ApiError('Menu not found')
  return br
}

export interface PublicOrderInput {
  branchId?: string | null
  type: OrderType
  tableId: string | null
  items: { productId: string; variantId: string | null; addOnIds: string[]; qty: number; notes: string }[]
  guest: { name: string; phone: string; address: string }
  notes: string
}


// ---------- Payroll ----------

const daysIn = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate() }
function payroll(d: DB, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError('Choose a month')
  const sc = scope(d)
  const today = dateKey()
  const dim = daysIn(month)
  // Days that have happened so far in this month (all of them for past months).
  const lastDay = month < today.slice(0, 7) ? dim : month === today.slice(0, 7) ? Number(today.slice(8, 10)) : 0
  const users = mine(d.users).filter((u) => u.active && allowedBranches(d, u).some((b) => sc.has(b)))
  return users.map((u) => {
    const att = mine(d.attendance).filter((a) => a.userId === u.id && a.date.slice(0, 7) === month)
    // One status per day (if marked in two branches, the better one counts).
    const rank: Record<AttendanceStatus, number> = { present: 3, half: 2, leave: 1, absent: 0 }
    const byDay = new Map<string, AttendanceStatus>()
    for (const a of att) { const cur = byDay.get(a.date); if (!cur || rank[a.status] > rank[cur]) byDay.set(a.date, a.status) }
    const count = (st: AttendanceStatus) => [...byDay.values()].filter((x) => x === st).length
    const present = count('present'), half = count('half'), leave = count('leave'), absent = count('absent')
    const unmarked = Math.max(0, lastDay - byDay.size)
    const pay = u.pay ?? null
    // Monthly: full salary less absent days (half day = ½). Unmarked days and leave are paid. Daily: days worked only.
    const basePay = !pay ? 0 : pay.type === 'monthly' ? Math.round(pay.amount - (pay.amount / dim) * (absent + half * 0.5)) : Math.round(pay.amount * (present + half * 0.5))
    const orders = mine(d.orders).filter((o) => o.status === 'completed' && o.createdBy === u.id && (o.billedAt ?? '').slice(0, 7) === month)
    const ids = new Set(orders.map((o) => o.id))
    const returned = mine(d.returns).filter((r) => ids.has(r.orderId)).reduce((a, r) => a + r.total, 0)
    const sales = r2(orders.reduce((a, o) => a + o.total, 0) - returned)
    const commission = pay?.commissionPct ? Math.round((sales * pay.commissionPct) / 100) : 0 // whole rupees
    const advances = r2(mine(d.advances).filter((a) => a.userId === u.id && !a.settledIn && a.date.slice(0, 7) <= month).reduce((a, x) => a + x.amount, 0))
    const paid = mine(d.salaries).find((x) => x.userId === u.id && x.month === month) ?? null
    return {
      userId: u.id, name: u.name, role: d.roles.find((r) => r.id === u.roleId)?.name ?? '', pay, daysInMonth: dim, daysSoFar: lastDay,
      present, half, leave, absent, unmarked, days: Object.fromEntries(byDay), basePay, bills: orders.length, sales, commission, advances,
      net: r2(basePay + commission - advances), paid,
    }
  })
}

// ---------- Renewal reminders ----------

const DEFAULT_REMINDERS: ReminderSettings = {
  enabled: true, daysBefore: 7, supportContact: '+91 90000 12345',
  template: REMINDER_SAMPLE.en,
}
const reminderSettings = (d: DB): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...d.platform.reminders })
/** Mock of Meta's review: a submitted template is approved ~20 s later. */
function platformWa(d: DB) {
  const w = d.platform.whatsapp
  if (!w) return null
  const t = w.template
  const approved = t?.status === 'pending' && t.submittedAt && Date.now() - new Date(t.submittedAt).getTime() > META_REVIEW_MS
  return { ...w, template: approved ? { ...t!, status: 'approved' as const } : t }
}
const PLATFORM = '__platform__'
/** Reminders can go out only when the platform WhatsApp is tested and the template is approved. */
const remindersReady = (d: DB) => { const w = platformWa(d); return !!w?.verified && w.template?.status === 'approved' }
function fillReminder(d: DB, template: string, b: Business | null) {
  const owner = b ? ownerOf(d, b) : null
  const left = b ? Math.max(0, daysLeftOf(b)) : 3
  const end = b?.subscription ? new Date(b.subscription.endAt) : new Date(Date.now() + 3 * 86_400_000)
  return template.replaceAll('{owner}', owner?.name.split(' ')[0] ?? 'Lakshmi').replaceAll('{business}', b?.name ?? 'FreshMart Supermarket')
    .replaceAll('{date}', end.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }))
      .replaceAll('{days}', daysText(left, template)).replaceAll('{amount}', `₹${((b?.maxBranches ?? 2) * d.platform.pricePerBranchMonth).toLocaleString('en-IN')}`)
    .replaceAll('{support}', reminderSettings(d).supportContact)
}
const daysLeftOf = (b: Business) => (b.subscription ? Math.ceil((new Date(b.subscription.endAt).getTime() - Date.now()) / 86_400_000) : -1)

/** Customers who should get today's automatic reminder (from N days before the end date, daily). */
function candidatesForReminder(d: DB, trigger: 'auto' | 'manual') {
  const cfg = reminderSettings(d)
  if (trigger === 'auto' && !cfg.enabled) return []
  const today = dateKey()
  return d.businesses.filter((b) => {
    const left = daysLeftOf(b)
    if (b.status === 'deactivated' || left < 1 || left > cfg.daysBefore) return false
    if (trigger === 'auto' && (b.remindersPaused || d.reminderLog.some((l) => l.businessId === b.id && l.date === today && l.trigger === 'auto'))) return false
    return true
  })
}
/** Mock: messages are logged, not really sent. The server sends them from the platform's WhatsApp number. */
function sendReminders(d: DB, opts: { trigger: 'auto' | 'manual'; businessId?: string; adminName?: string }) {
  const cfg = reminderSettings(d)
  if (!remindersReady(d)) {
    if (opts.trigger === 'manual') throw new ApiError('Set up WhatsApp first (Admin → WhatsApp): connect, test, and get the reminder template approved')
    return 0
  }
  const list = opts.businessId ? d.businesses.filter((b) => b.id === opts.businessId) : candidatesForReminder(d, opts.trigger)
  let sent = 0
  for (const b of list) {
    const owner = ownerOf(d, b)
    const left = Math.max(0, daysLeftOf(b))
    const message = fillReminder(d, cfg.template, b)
    const ok = !!owner?.phone && /^\+\d{8,15}$/.test(owner.phone)
    d.reminderLog.push({
      id: uid('rem_'), businessId: b.id, businessName: b.name, date: dateKey(), daysLeft: left, channel: 'whatsapp', to: owner?.phone ?? '', message,
      status: ok ? 'sent' : 'failed', error: ok ? undefined : 'No valid mobile number for the owner', trigger: opts.trigger, adminName: opts.adminName, createdAt: nowIso(),
    })
    if (ok) sent++
  }
  if (d.reminderLog.length > 5000) d.reminderLog = d.reminderLog.slice(-5000)
  return sent
}

export const APP_VERSION = '1.0.0-mock'

// ---------- Data export ----------

/** Every row a business owns, as tables (Excel sheets / CSV files) plus product photos. Passwords never included. */
function exportTables(d: DB, businessId: string, forAdmin: boolean) {
  const b = d.businesses.find((x) => x.id === businessId)!
  const of = <T extends { businessId: string }>(rows: T[]) => rows.filter((r) => r.businessId === businessId)
  const branch = (id: string) => d.branches.find((x) => x.id === id)?.name ?? ''
  const userName = (id: string) => d.users.find((x) => x.id === id)?.name ?? (id === 'guest' ? 'QR customer' : '')
  const product = (id: string) => d.products.find((x) => x.id === id)?.name ?? ''
  const customer = (id: string | null) => (id ? d.customers.find((x) => x.id === id)?.name ?? '' : '')
  const category = (id: string | null) => (id ? d.categories.find((x) => x.id === id)?.name ?? '' : '')
  const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN') : '')
  const orders = of(d.orders)
  const tables: { name: string; rows: Record<string, string | number | boolean | null>[] }[] = [
    { name: 'Business', rows: [{ Name: b.name, Type: `${b.category} · ${b.subType}`, Phone: b.phone, Email: b.email, Address: b.address, GSTIN: b.gstin, Currency: b.currency, Created: dt(b.createdAt), 'Valid until': dt(b.subscription?.endAt), 'Branch limit': b.maxBranches ?? 1 }] },
    { name: 'Branches', rows: of(d.branches).map((x) => ({ Name: x.name, Address: x.address, Phone: x.phone ?? '', Main: x.isDefault, Active: x.active !== false, 'Bill prefix': x.invoicePrefix ?? '' })) },
    { name: 'Staff', rows: of(d.users).map((u) => ({ Name: u.name, Mobile: u.phone, Email: u.email, Username: u.username ?? '', Role: d.roles.find((r) => r.id === u.roleId)?.name ?? '', Branch: branch(u.branchId), Active: u.active, 'Salary type': u.pay?.type ?? '', Salary: u.pay?.amount ?? '', 'Commission %': u.pay?.commissionPct ?? '', 'Last login': dt(u.lastLoginAt) })) },
    { name: 'Categories', rows: of(d.categories).map((c) => ({ Name: c.name, Icon: c.emoji })) },
    { name: 'Products', rows: of(d.products).map((p) => ({ Name: p.name, Category: category(p.categoryId), Price: p.price, MRP: p.mrp ?? '', 'Wholesale price': p.wholesalePrice ?? '', 'Cost price': p.costPrice, Barcode: p.barcode, SKU: p.sku, Unit: p.unit, Stock: p.stock, 'Low stock at': p.lowStockAt, Sizes: p.variants.map((v) => `${v.name}:${v.price}`).join(' | '), 'Add-ons': p.addOns.map((v) => `${v.name}:${v.price}`).join(' | '), Veg: p.isVeg, Active: p.active, Photo: p.imageUrl ? `images/${p.id}.${p.imageUrl.startsWith('data:image/webp') ? 'webp' : 'jpg'}` : '' })) },
    { name: 'Customers', rows: of(d.customers).map((c) => ({ Name: c.name, Mobile: c.phone, Email: c.email, Address: c.address, Notes: c.notes, 'Price list': c.priceTier ?? 'retail', 'OK with offers': c.marketingOptIn !== false, Outstanding: r2(orders.filter((o) => o.customerId === c.id && o.status === 'completed').reduce((a, o) => a + o.balance, 0)) })) },
    { name: 'Bills', rows: orders.map((o) => ({ 'Bill no': o.invoiceNumber ?? '', Order: o.number, Status: o.status, Type: o.type, Branch: branch(o.branchId), Customer: customer(o.customerId) || o.guest?.name || '', Subtotal: o.subtotal, Discount: o.discount, Tax: o.tax, 'Round off': o.roundOff, Total: o.total, Paid: o.paid, Balance: o.balance, Created: dt(o.createdAt), Billed: dt(o.billedAt), 'Made by': userName(o.createdBy), 'Cancel reason': o.cancelReason ?? '' })) },
    { name: 'Bill items', rows: orders.flatMap((o) => o.items.map((i) => ({ 'Bill no': o.invoiceNumber ?? o.number, Item: i.name, Size: i.variantName ?? '', 'Add-ons': i.addOns.map((a) => a.name).join(', '), Qty: i.qty, Unit: i.unit, Rate: i.unitPrice, 'Tax %': i.taxRate, Amount: r2(i.qty * i.unitPrice) }))) },
    { name: 'Payments', rows: of(d.payments).map((p) => ({ Date: dt(p.createdAt), Kind: p.kind, Method: p.method, Amount: p.amount, Bill: orders.find((o) => o.id === p.orderId)?.invoiceNumber ?? '', Customer: customer(p.customerId), Reference: p.reference, Voided: p.voided, Branch: branch(p.branchId) })) },
    { name: 'Returns', rows: of(d.returns).flatMap((r) => r.lines.map((l) => ({ 'Credit note': r.number, Date: dt(r.createdAt), Bill: r.invoiceNumber, Item: l.name, Qty: l.qty, Amount: l.amount, 'Back to stock': l.restock, Reason: r.reason, 'Due adjusted': r.dueAdjusted, Refunded: r.refunded, 'Credit issued': r.creditIssued, 'Credit left': r.creditRemaining }))) },
    { name: 'Expenses', rows: of(d.expenses).map((e) => ({ Date: dt(e.date), Category: e.category, Amount: e.amount, Method: e.method, Notes: e.notes, Voided: e.voided, Branch: branch(e.branchId) })) },
    { name: 'Stock movements', rows: of(d.stockMovements).map((m) => ({ Date: dt(m.createdAt), Item: product(m.productId), Type: m.type, Qty: m.qty, 'Balance after': m.balanceAfter, Note: m.note, Branch: branch(m.branchId) })) },
    { name: 'Stock batches', rows: of(d.batches).map((x) => ({ Item: product(x.productId), Batch: x.batchNo, Expiry: x.expiry, Qty: x.qty, Received: x.receivedQty, Branch: branch(x.branchId) })) },
    { name: 'Attendance', rows: of(d.attendance).map((a) => ({ Date: a.date, Staff: userName(a.userId), Status: a.status, In: a.checkIn ?? '', Out: a.checkOut ?? '', Note: a.note, Branch: branch(a.branchId) })) },
    { name: 'Salary', rows: of(d.salaries).map((x) => ({ Month: x.month, Staff: userName(x.userId), Base: x.basePay, Commission: x.commission, Bonus: x.bonus, Deduction: x.deduction, Advance: x.advances, 'Net paid': x.net, Method: x.method, Paid: dt(x.createdAt) })) },
    { name: 'Advances', rows: of(d.advances).map((x) => ({ Date: x.date, Staff: userName(x.userId), Amount: x.amount, Method: x.method, Note: x.note, Recovered: !!x.settledIn })) },
    { name: 'Tables', rows: of(d.tables).map((x) => ({ Table: x.label, Floor: x.floor, Seats: x.seats, Branch: branch(x.branchId) })) },
    { name: 'WhatsApp messages', rows: of(d.waMessages).map((m) => ({ Date: dt(m.createdAt), Kind: m.kind, To: m.to, Customer: m.customerName, Status: m.status, Message: m.body })) },
    { name: 'Audit log', rows: of(d.auditLogs).map((a) => ({ Date: dt(a.at), User: userName(a.userId), What: a.entity, Action: a.action, Detail: a.detail })) },
  ]
  if (forAdmin) tables.push({ name: 'Subscription', rows: d.subscriptionPeriods.filter((p) => p.businessId === businessId).map((p) => ({ Kind: p.kind, From: dt(p.startAt), To: dt(p.endAt), Months: p.months ?? 'custom', Branches: p.branches, Amount: p.amount, Note: p.note })) })
  const images = of(d.products).filter((p) => p.imageUrl?.startsWith('data:')).map((p) => ({ path: `images/${p.id}.${p.imageUrl!.startsWith('data:image/webp') ? 'webp' : 'jpg'}`, dataUrl: p.imageUrl! }))
  return { businessName: b.name, exportedAt: nowIso(), tables, images }
}
export type ExportBundle = ReturnType<typeof exportTables>

// ---------- WhatsApp helpers ----------

const formatNumberForLog = (e164: string) => e164.replace(/(\d{2})\d+(\d{3})$/, '$1•••$2')
/** The business — only if the product admin released WhatsApp to it. */
function waBiz(d: DB) {
  const b = biz(d)
  if (!featureOn(d.platform.features, 'whatsapp', b.id)) throw new ApiError('WhatsApp integration isn’t available for your account yet')
  return b
}
function waConfig(b: Business): WhatsAppConfig {
  if (!b.whatsapp?.enabled) throw new ApiError('Turn on WhatsApp first')
  return b.whatsapp
}
const PRINTER_DEFAULTS: BranchPrinter = { transport: 'browser', paper: null, mode: 'auto', autoPrint: false, copies: 1, cut: true, drawer: false, baudRate: 9600 }
const META_REVIEW_MS = 20_000 // mock: Meta approves a valid template ~20 s after submitting
function liveTemplates(w: WhatsAppConfig) {
  const out: WhatsAppConfig['templates'] = {}
  for (const [k, t] of Object.entries(w.templates)) {
    if (!t) continue
    const approved = t.status === 'pending' && t.submittedAt && Date.now() - new Date(t.submittedAt).getTime() > META_REVIEW_MS
    out[k as WaTemplateKind] = approved ? { ...t, status: 'approved' } : t
  }
  return out
}
/** Where the setup is: 1 enable · 2 connect · 3 test · 4 templates · connected. */
function waState(b: Business) {
  const w = b.whatsapp
  const t = w ? liveTemplates(w) : {}
  const step = !w?.enabled ? 1 : !w.phoneNumberId ? 2 : !w.verified ? 3 : !w.finishedAt ? 4 : 5
  const live = !!w?.enabled && !!w.verified
  return {
    state: (!w?.enabled ? 'not_set_up' : step < 5 ? 'incomplete' : 'connected') as 'not_set_up' | 'incomplete' | 'connected',
    step,
    ready: { offer: live && t.offer?.status === 'approved', bill: live && t.bill?.status === 'approved' },
  }
}
function logWa(d: DB, b: Business, userId: string, m: Omit<WaMessage, 'id' | 'businessId' | 'status' | 'createdAt' | 'createdBy'>) {
  const valid = /^\+\d{8,15}$/.test(m.to)
  const msg: WaMessage = { ...m, id: uid('wam_'), businessId: b.id, status: valid ? 'sent' : 'failed', error: valid ? undefined : 'Not a valid WhatsApp number', createdAt: nowIso(), createdBy: userId }
  d.waMessages.push(msg)
  return msg
}
/** Mock delivery receipts (the real server gets these from Meta's webhook). */
function liveMessage(m: WaMessage): WaMessage {
  if (m.status !== 'sent') return m
  const age = Date.now() - new Date(m.createdAt).getTime()
  return { ...m, status: age > 30_000 ? 'read' : age > 4_000 ? 'delivered' : 'sent' }
}

// ---------- Product admin ----------

export type Validity = { months: number } | { endDate: string }
const ADMIN_KEY = 'billpoodum.adminSession'
export const adminSession = {
  get(): { adminId: string } | null { try { return JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null') } catch { return null } },
  set(s: { adminId: string } | null) { if (s) localStorage.setItem(ADMIN_KEY, JSON.stringify(s)); else localStorage.removeItem(ADMIN_KEY) },
}
function requireAdmin(d: DB, perm?: AdminPermission) {
  const s = adminSession.get()
  const a = s && d.admins.find((x) => x.id === s.adminId && x.active)
  if (!a) throw new ApiError('Product admin sign-in required')
  if (perm && !adminCan(a.role, perm)) throw new ApiError(`Your admin role (${ADMIN_ROLES[a.role].name}) can’t do this`)
  return a
}
const adminView = (a: PlatformAdmin) => ({ id: a.id, name: a.name, username: a.username, role: a.role, permissions: ADMIN_ROLES[a.role].permissions })
/** Remember a real customer sign-in (shown in the admin usage report). */
function markLogin(userId: string) {
  try { dbTx((d) => { const u = d.users.find((x) => x.id === userId); if (u) u.lastLoginAt = nowIso() }) } catch { /* storage full: sign in anyway */ }
}
const findBiz = (d: DB, id: string) => { const b = d.businesses.find((x) => x.id === id); if (!b) throw new ApiError('Customer not found'); return b }
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
function checkUsername(d: DB, raw: string, selfId?: string) {
  const u = raw.trim().toLowerCase()
  if (!/^[a-z0-9._-]{4,30}$/.test(u)) throw new ApiError('Username: 4–30 letters, numbers, dot, dash or underscore (no spaces)')
  if (d.users.some((x) => x.username === u && x.id !== selfId) || d.admins.some((x) => x.username === u)) throw new ApiError(`Username ${u} is already taken`)
  return u
}
function checkPassword(p: string) {
  if (!p || p.length < 6) throw new ApiError('Password must be at least 6 characters')
}
function checkBranches(n: number) {
  const v = Math.floor(n)
  if (!(v >= 1 && v <= 100)) throw new ApiError('Branch limit must be between 1 and 100')
  return v
}
function periodFor(v: Validity, from: Date) {
  const start = new Date(from)
  if ('months' in v) {
    if (![1, 2, 3, 6, 12, 24].includes(v.months)) throw new ApiError('Choose a validity period')
    const end = new Date(addMonths(start, v.months).getTime() - 86_400_000)
    return { startAt: start.toISOString(), endAt: endOfDay(end), months: v.months }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.endDate)) throw new ApiError('Choose an end date')
  const endAt = dateInputToEnd(v.endDate)
  if (new Date(endAt) <= start) throw new ApiError('The end date must be after the start date')
  return { startAt: start.toISOString(), endAt, months: null }
}
function addPeriod(d: DB, adminId: string, b: Business, kind: SubscriptionPeriod['kind'], startAt: string, endAt: string, months: number | null, note: string) {
  const branches = b.maxBranches ?? 1, price = d.platform.pricePerBranchMonth
  d.subscriptionPeriods.push({ id: uid('sub_'), businessId: b.id, kind, startAt, endAt, months, branches, pricePerBranch: price, amount: periodAmount(branches, price, months, startAt, endAt), note: note.trim(), createdAt: nowIso(), createdBy: adminId })
}
function adminLog(d: DB, a: PlatformAdmin, action: AdminAuditLog['action'], b: Business | null, detail: string) {
  d.adminAudit.push({ id: uid('adl_'), at: nowIso(), adminId: a.id, adminName: a.name, action, businessId: b?.id ?? null, businessName: b?.name ?? '', detail })
}
const activeSupers = (d: DB) => d.admins.filter((a) => a.active && a.role === 'super').length
function customerRow(d: DB, b: Business) {
  const owner = ownerOf(d, b)
  const st = subscriptionState(b)
  const lastBill = d.orders.filter((o) => o.businessId === b.id).reduce((m, o) => (o.createdAt > m ? o.createdAt : m), '')
  return {
    id: b.id, name: b.name || '(setup not finished)', category: b.category, subType: b.subType, onboarded: b.onboarded, createdAt: b.createdAt,
    ownerName: owner?.name ?? '', username: owner?.username ?? '', phone: owner?.phone ?? b.phone, email: owner?.email ?? '',
    status: b.status ?? 'active', state: st.state, daysLeft: st.daysLeft, startAt: st.startAt, endAt: st.endAt,
    maxBranches: b.maxBranches ?? 1, branchesUsed: d.branches.filter((x) => x.businessId === b.id).length,
    monthlyPrice: (b.maxBranches ?? 1) * d.platform.pricePerBranchMonth, lastActivity: lastBill || null,
    lastLoginAt: d.users.filter((u) => u.businessId === b.id).reduce((m, u) => (u.lastLoginAt && u.lastLoginAt > m ? u.lastLoginAt : m), '') || null,
  }
}
export type CustomerRow = ReturnType<typeof customerRow>

// ======================================================================================

export const api = {
  auth: {
    /** Customers sign in with the username the product admin gave them; staff can also use their mobile number. */
    async login(identifier: string, password: string) {
      const d = getDB()
      const id = identifier.trim().toLowerCase()
      if (!id || !password) throw new ApiError('Enter your username and password')
      let mobile: string | null = null
      if (/^[+\d][\d\s()-]*$/.test(id)) { // looks like a mobile number → it must be a valid one
        try { mobile = normalizePhone(id, 'IN') } catch (e) { throw new ApiError((e as Error).message) }
      }
      const u = d.users.find((x) => x.username === id) ?? d.users.find((x) => (mobile && x.phone === mobile) || (!!x.email && x.email.toLowerCase() === id))
      if (!u || u.password !== password) throw new ApiError('Wrong mobile number or password')
      if (!u.active) throw new ApiError('Your login has been turned off. Ask your shop owner.')
      const b = d.businesses.find((x) => x.id === u.businessId)
      if (!b || subscriptionState(b).blocked) throw new ApiError(DEACTIVATED_MESSAGE)
      markLogin(u.id)
      session.set({ userId: u.id, businessId: u.businessId, branchId: u.branchId })
      return clone(u)
    },
    async demoLogin(userId: string) {
      const d = getDB()
      const u = d.users.find((x) => x.id === userId)
      if (!u) throw new ApiError('Demo user missing — reset demo data')
      const b = d.businesses.find((x) => x.id === u.businessId)
      if (!b || subscriptionState(b).blocked) throw new ApiError(DEACTIVATED_MESSAGE)
      markLogin(u.id)
      session.set({ userId: u.id, businessId: u.businessId, branchId: u.branchId })
      return clone(u)
    },
    /** Public sign-up is closed: only the product admin creates customer accounts. */
    async signup(_input: { name: string; phone: string; password: string }): Promise<string> {
      throw new ApiError('New accounts are created by the product admin. Please contact us to get your username and password.')
    },
    async logout() { session.set(null) },
    /** The signed-in user's own app language — no permission needed. */
    async setLanguage(language: string) {
      if (session.get()?.support) return language // support view: change it on this device only
      return dbTx((d) => { // a personal preference — allowed even when the account is read-only
        const s = ctx()
        const u = d.users.find((x) => x.id === s.userId)
        if (!u) throw new ApiError('Not signed in')
        u.language = language
        return language
      })
    },
    /** Switch the working branch, or 'all' for the combined view. */
    async switchBranch(branchId: string) {
      const d = getDB()
      const s = ctx()
      const user = d.users.find((u) => u.id === s.userId)!
      const allowed = allowedBranches(d, user)
      if (branchId === ALL_BRANCHES ? allowed.length < 2 : !allowed.includes(branchId)) throw new ApiError('You don’t have access to that branch')
      session.set({ ...s, branchId })
      notify()
    },
    async me() {
      const s = session.get()
      if (!s) return null
      const d = getDB()
      const user = d.users.find((u) => u.id === s.userId && u.active)
      const business = d.businesses.find((b) => b.id === s.businessId)
      if (!user || !business || (subscriptionState(business).blocked && !s.support)) { session.set(null); return null }
      const role = d.roles.find((r) => r.id === user.roleId)!
      const allowed = allowedBranches(d, user)
      const branches = d.branches.filter((b) => allowed.includes(b.id))
      if (s.branchId !== ALL_BRANCHES && !allowed.includes(s.branchId)) { s.branchId = allowed[0] ?? user.branchId; session.set(s) }
      if (s.branchId === ALL_BRANCHES && branches.length < 2) { s.branchId = branches[0]?.id ?? user.branchId; session.set(s) }
      const isAll = s.branchId === ALL_BRANCHES
      const branch = isAll
        ? { id: ALL_BRANCHES, businessId: business.id, name: 'All branches', address: '', isDefault: false, active: true }
        : d.branches.find((b) => b.id === s.branchId)!
      const subscription = subscriptionState(business)
      const branchLimit = { max: business.maxBranches ?? 1, used: d.branches.filter((b) => b.businessId === business.id).length }
      const features = featuresFor(d.platform.features, business.id)
      return clone({ user, business: { ...business, whatsapp: undefined }, role, branch, branches, isAll, subscription, branchLimit, features, support: s.support ?? null, permissions: permissionsOf(d, user) === 'all' ? ('all' as const) : [...(permissionsOf(d, user) as Set<Permission>)] })
    },
    /** Demo logins grouped by business (mock only — the real backend has no such endpoint). */
    demoUsers() {
      const d = getDB()
      return DEMO_BUSINESSES.map((id) => d.businesses.find((b) => b.id === id)).filter(Boolean).map((b) => ({
        business: { id: b!.id, name: b!.name, subType: b!.subType, emoji: b!.logoEmoji },
        users: d.users.filter((u) => u.businessId === b!.id && u.active).map((u) => ({ ...u, role: d.roles.find((r) => r.id === u.roleId)?.name ?? '', branch: d.branches.find((x) => x.id === u.branchId)?.name ?? '' })),
      }))
    },
  },

  business: {
    async update(patch: Partial<Business>) {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = biz(d)
        if (patch.defaultCountry && !COUNTRIES.some((c) => c.iso === patch.defaultCountry)) throw new ApiError('Unknown country')
        if (patch.phone !== undefined) patch = { ...patch, phone: cleanPhone(patch.phone, patch.defaultCountry ?? b.defaultCountry) }
        Object.assign(b, patch)
        audit(d, 'business', b.id, 'update', Object.keys(patch).join(', '))
        return clone(b)
      })
    },
    /**
     * Sign-up setup, saved before items are added so the normal product form can be used.
     * Safe to call again (user goes Back and changes things): categories and tables are synced.
     */
    async saveSetup(input: {
      name: string; category: Business['category']; subType: string; modules: Business['modules']; terminology: Business['terminology']; orderTypes: OrderType[]
      /** `id` = already saved earlier in this setup. */
      categories: { id?: string; name: string; emoji: string }[]
      /** Dining areas and how many tables in each (restaurants). */
      tables: { floor: string; count: number; seats: number }[]
    }) {
      return tx((d) => {
        const s = requirePerm(d, 'settings.manage')
        const b = biz(d)
        if (!input.name.trim()) throw new ApiError('Enter your business name')
        Object.assign(b, { name: input.name.trim(), category: input.category, subType: input.subType, modules: input.modules, terminology: input.terminology })
        b.billing.orderTypes = input.orderTypes
        b.billing.defaultTaxRateId = input.category === 'retail' ? 'tax_0' : 'tax_5'
        b.billing.taxMode = isSupermarket(b) ? 'inclusive' : 'exclusive' // MRP / shelf prices include GST
        if (isHardware(b)) { b.modules.mobileOrders = true; b.modules.customerOrders = true; b.billing.defaultTaxRateId = 'tax_18' }
        b.logoEmoji = { food: '🍔', restaurant: '🍽️', retail: '🛒', service: '✂️' }[input.category]

        // Categories: update kept ones, add new ones, remove the ones taken out of the list.
        const keep = new Set<string>()
        const seen = new Set<string>()
        const ids = input.categories.map((c) => {
          const name = c.name.trim()
          if (!name || seen.has(name.toLowerCase())) return null
          seen.add(name.toLowerCase())
          const ex = c.id ? mine(d.categories).find((x) => x.id === c.id) : null
          if (ex) { Object.assign(ex, { name, emoji: c.emoji || '⭐' }); keep.add(ex.id); return ex.id }
          const id = uid('cat_')
          d.categories.push({ id, businessId: s.businessId, name, emoji: c.emoji || '⭐', sort: 0 })
          keep.add(id)
          return id
        })
        if (!keep.size) throw new ApiError('Add at least one category')
        const removed = new Set(mine(d.categories).filter((c) => !keep.has(c.id)).map((c) => c.id))
        d.categories = d.categories.filter((c) => !removed.has(c.id))
        mine(d.products).forEach((p) => { if (p.categoryId && removed.has(p.categoryId)) p.categoryId = null })
        ids.forEach((id, i) => { const c = id && d.categories.find((x) => x.id === id); if (c) c.sort = i })

        // Tables: numbered T1, T2… across the areas, like Settings → Tables. Rebuilt while nothing is billed yet.
        const used = mine(d.orders).some((o) => o.tableId)
        if (!used) {
          d.tables = d.tables.filter((t) => t.businessId !== s.businessId)
          if (input.modules.tables) {
            let n = 0
            for (const area of input.tables) {
              const count = Math.floor(area.count)
              if (!(count >= 1)) continue
              if (n + count > 200) throw new ApiError('Up to 200 tables can be added here — add more later in Settings → Tables')
              for (let i = 0; i < count; i++) {
                n++
                d.tables.push({ id: uid('tbl_'), businessId: s.businessId, branchId: s.branchId, label: `T${n}`, floor: area.floor.trim() || 'Main', seats: Math.max(1, Math.floor(area.seats) || 4), mergedInto: null })
              }
            }
          }
        }
        audit(d, 'business', b.id, 'setup', `${b.subType} · ${keep.size} categories`)
        return { categoryIds: ids }
      })
    },
    /** Last sign-up step: the app opens normally from now on. */
    async finishOnboarding() {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = biz(d)
        if (!b.name.trim()) throw new ApiError('Enter your business name')
        b.onboarded = true
        audit(d, 'business', b.id, 'onboarded', b.name)
        return clone(b)
      })
    },
    defaultModules: modulesFor,
  },

  branches: {
    /** Save one branch's printer setup. Cashiers may set up the printer of a branch they work in. */
    async savePrinter(branchId: string, patch: Partial<BranchPrinter>) {
      return tx((d) => {
        const s = session.get()
        const u = s && d.users.find((x) => x.id === s.userId)
        const perms = u ? permissionsOf(d, u) : null
        if (!u || !perms || (perms !== 'all' && !perms.has('settings.manage') && !perms.has('billing.create'))) throw new ApiError('You don’t have permission to change the printer')
        const br = mine(d.branches).find((b) => b.id === branchId)
        if (!br || !allowedBranches(d, u).includes(br.id)) throw new ApiError('Branch not found')
        const cur: BranchPrinter = { ...PRINTER_DEFAULTS, ...br.printer }
        const next: BranchPrinter = { ...cur }
        if (patch.transport && ['browser', 'usb', 'serial', 'bluetooth'].includes(patch.transport)) next.transport = patch.transport
        if (patch.paper !== undefined) next.paper = patch.paper === '58mm' || patch.paper === '80mm' ? patch.paper : null
        if (patch.mode && ['auto', 'text', 'image'].includes(patch.mode)) next.mode = patch.mode
        if (patch.copies !== undefined) next.copies = Math.min(3, Math.max(1, Math.round(patch.copies)))
        if (patch.baudRate !== undefined) next.baudRate = [9600, 19200, 38400, 57600, 115200].includes(patch.baudRate) ? patch.baudRate : cur.baudRate
        for (const k of ['autoPrint', 'cut', 'drawer'] as const) if (patch[k] !== undefined) next[k] = !!patch[k]
        br.printer = { ...next, updatedAt: nowIso(), updatedBy: u.id }
        audit(d, 'branch', br.id, 'printer', `${br.name}: ${next.transport}${next.autoPrint ? ', auto print' : ''}`)
        return clone(br.printer)
      })
    },
    async list() {
      const d = getDB()
      return clone(mine(d.branches).map((b) => ({
        ...b,
        staff: d.users.filter((u) => u.businessId === b.businessId && u.active && (permissionsOf(d, u) === 'all' || (u.branchIds?.length ? u.branchIds : [u.branchId]).includes(b.id))).length,
        tables: d.tables.filter((t) => t.branchId === b.id).length,
      })))
    },
    async save(input: Partial<Branch> & { name: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'settings.manage')
        const name = input.name.trim()
        if (!name) throw new ApiError('Enter a branch name')
        const prefix = (input.invoicePrefix ?? '').trim().toUpperCase()
        if (prefix && mine(d.branches).some((b) => b.id !== input.id && (b.invoicePrefix ?? '').toUpperCase() === prefix)) throw new ApiError(`Bill prefix ${prefix} is already used by another branch`)
        const ex = input.id ? mine(d.branches).find((b) => b.id === input.id) : null
        if (ex) {
          if (ex.isDefault && input.active === false) throw new ApiError('The main branch can’t be closed')
          Object.assign(ex, { name, address: input.address ?? ex.address, phone: input.phone !== undefined ? cleanPhone(input.phone, biz(d).defaultCountry) : ex.phone, active: input.active ?? ex.active, invoicePrefix: prefix || ex.invoicePrefix, nextInvoiceNumber: input.nextInvoiceNumber ?? ex.nextInvoiceNumber })
          audit(d, 'branch', ex.id, 'update', name)
          return clone(ex)
        }
        const b = biz(d), used = mine(d.branches).length
        if (used >= (b.maxBranches ?? 1)) throw new ApiError(branchLimitMessage(b.maxBranches ?? 1))
        const auto = prefix || `${name.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || 'BR'}-`
        const nb: Branch = { id: uid('br_'), businessId: s.businessId, name, address: input.address ?? '', phone: cleanPhone(input.phone, biz(d).defaultCountry), isDefault: false, active: true, invoicePrefix: auto, nextInvoiceNumber: input.nextInvoiceNumber ?? 10001 }
        if (mine(d.branches).some((b) => (b.invoicePrefix ?? '').toUpperCase() === auto)) nb.invoicePrefix = `${auto.slice(0, -1)}${mine(d.branches).length + 1}-`
        d.branches.push(nb)
        audit(d, 'branch', nb.id, 'create', name)
        return clone(nb)
      })
    },
    /** Sample data for two extra branches so multi-branch screens can be tried out. */
    async addDemo() {
      return tx((d) => {
        const s = requirePerm(d, 'settings.manage')
        const max = biz(d).maxBranches ?? 1
        if (mine(d.branches).length + 2 > max) throw new ApiError(`Sample branches need ${mine(d.branches).length + 2} branches, but ${branchLimitMessage(max).charAt(0).toLowerCase()}${branchLimitMessage(max).slice(1)}`)
        addDemoBranches(d, s.businessId)
      })
    },
  },

  roles: {
    async list() { return clone(mine(getDB().roles)) },
    async save(role: Omit<Role, 'businessId' | 'id'> & { id?: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        const existing = d.roles.find((r) => r.id === role.id && r.businessId === s.businessId)
        if (existing) {
          if (existing.system && existing.name === 'Owner') throw new ApiError('Owner role always has full access')
          Object.assign(existing, { name: role.name, permissions: role.permissions })
          audit(d, 'role', existing.id, 'update', role.name)
          return clone(existing)
        }
        const r: Role = { ...role, id: uid('role_'), businessId: s.businessId, system: false }
        d.roles.push(r)
        audit(d, 'role', r.id, 'create', r.name)
        return clone(r)
      })
    },
    async remove(id: string) {
      return tx((d) => {
        requirePerm(d, 'users.manage')
        const r = d.roles.find((x) => x.id === id)
        if (!r || r.system) throw new ApiError('Built-in roles cannot be deleted')
        if (d.users.some((u) => u.roleId === id)) throw new ApiError('Role is assigned to staff — reassign them first')
        d.roles = d.roles.filter((x) => x.id !== id)
      })
    },
  },

  users: {
    async list() { return clone(mine(getDB().users)) },
    async save(u: Partial<User> & { name: string; phone: string; roleId: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        const phone = cleanPhone(u.phone, biz(d).defaultCountry, { required: 'Enter the mobile number (used to sign in)' })
        if (d.users.some((x) => x.phone === phone && x.id !== u.id)) throw new ApiError('Mobile number already used by another user')
        const existing = u.id ? d.users.find((x) => x.id === u.id && x.businessId === s.businessId) : null
        if (existing) {
          Object.assign(existing, { name: u.name, phone, email: u.email ?? '', roleId: u.roleId, active: u.active ?? existing.active })
          if (u.branchIds) Object.assign(existing, branchAccess(d, s.businessId, u.branchIds))
          if (u.password) existing.password = u.password
          touch(existing, s.userId)
          audit(d, 'user', existing.id, 'update', u.name)
          return clone(existing)
        }
        const nu: User = {
          id: uid('usr_'), businessId: s.businessId, name: u.name, phone, email: u.email ?? '',
          password: u.password || 'demo123', roleId: u.roleId, active: true, ...stamp(s.userId),
          ...branchAccess(d, s.businessId, u.branchIds?.length ? u.branchIds : [writeBranch(d, { fallback: true })]),
        }
        d.users.push(nu)
        audit(d, 'user', nu.id, 'create', nu.name)
        return clone(nu)
      })
    },
  },

  categories: {
    async list() { return clone(mine(getDB().categories).sort((a, b) => a.sort - b.sort)) },
    async save(c: Partial<Category> & { name: string }) {
      // Only compressed images (≤ 50 KB) are ever stored.
      assertCanWrite(getDB(), 'products.manage')
      const img = await storeImage(c.imageUrl, c.thumbUrl)
      return tx((d) => {
        const s = requirePerm(d, 'products.manage')
        const ex = c.id ? d.categories.find((x) => x.id === c.id) : null
        if (ex) { Object.assign(ex, { name: c.name, emoji: c.emoji ?? ex.emoji, ...(img ?? {}) }); return clone(ex) }
        const nc: Category = { id: uid('cat_'), businessId: s.businessId, name: c.name, emoji: c.emoji ?? '', imageUrl: img?.imageUrl ?? null, thumbUrl: img?.thumbUrl ?? null, sort: mine(d.categories).length }
        d.categories.push(nc)
        return clone(nc)
      })
    },
    async remove(id: string) {
      return tx((d) => {
        const s = requirePerm(d, 'products.manage')
        if (d.products.some((p) => p.businessId === s.businessId && p.categoryId === id)) throw new ApiError('Move or delete the items in this category first')
        d.categories = d.categories.filter((c) => !(c.id === id && c.businessId === s.businessId))
      })
    },
  },

  products: {
    async list() {
      const d = getDB()
      const sc = scope(d)
      const nextExpiry = (p: Product) => {
        if (!p.trackExpiry) return null
        const dates = d.batches.filter((x) => x.productId === p.id && sc.has(x.branchId) && x.qty > 0 && x.expiry).map((x) => x.expiry).sort()
        return dates[0] ?? null
      }
      return clone(mine(d.products).map((p): Product => ({ ...p, stock: p.trackStock ? stockIn(p, sc) : p.stock, nextExpiry: nextExpiry(p) })))
    },
    async save(input: Partial<Product> & { name: string; openingBatch?: BatchInput }) {
      // Only compressed images (≤ 50 KB) are ever stored — whatever the client sends.
      assertCanWrite(getDB(), 'products.manage')
      const img = await storeImage(input.imageUrl, input.thumbUrl)
      const p = img ? { ...input, ...img } : input
      return tx((d) => {
        const s = requirePerm(d, 'products.manage')
        if (!p.name.trim()) throw new ApiError('Name is required')
        const code = (p.barcode ?? '').trim()
        const dup = code && mine(d.products).find((x) => x.id !== p.id && x.barcode === code)
        if (dup) throw new ApiError(`Barcode ${code} is already used by ${dup.name}`)
        const ex = p.id ? d.products.find((x) => x.id === p.id && x.businessId === s.businessId) : null
        if (ex) {
          const { stock: _ignored, stockByBranch: _ignored2, nextExpiry: _ignored3, ...rest } = p as Product & { openingBatch?: BatchInput } // stock changes only through movements
          Object.assign(ex, rest)
          touch(ex, s.userId)
          audit(d, 'product', ex.id, 'update', ex.name)
          return clone(ex)
        }
        const np: Product = {
          id: uid('prd_'), businessId: s.businessId, name: p.name.trim(), categoryId: p.categoryId ?? null, kind: p.kind ?? 'goods',
          emoji: p.emoji ?? '', imageUrl: p.imageUrl ?? null, thumbUrl: p.thumbUrl ?? null, mrp: p.mrp ?? null, sku: p.sku ?? '', barcode: p.barcode ?? '', unit: p.unit || 'pc', price: p.price ?? 0,
          costPrice: p.costPrice ?? 0, wholesalePrice: p.wholesalePrice ?? null, variants: p.variants ?? [], addOns: p.addOns ?? [], taxRateId: p.taxRateId ?? null,
          trackStock: p.trackStock ?? false, trackExpiry: p.trackExpiry ?? false, stock: 0, stockByBranch: {}, lowStockAt: p.lowStockAt ?? 0, isVeg: p.isVeg ?? true,
          sendToKitchen: p.sendToKitchen ?? true, active: p.active ?? true, ...stamp(s.userId),
        }
        d.products.push(np)
        if (np.trackStock && (p.stock ?? 0) > 0) moveStock(d, np.id, 'opening', p.stock!, 'Opening stock', null, writeBranch(d, { fallback: true }), (p as { openingBatch?: BatchInput }).openingBatch)
        audit(d, 'product', np.id, 'create', np.name)
        return clone(np)
      })
    },
    /**
     * Import many products at once (from CSV). One transaction: all or nothing.
     * Existing products (same barcode, otherwise same name) are skipped or updated.
     */
    async importMany(rows: (ImportItem & { row: number })[], opts: { onExisting: 'skip' | 'update'; fileName: string }) {
      assertCanWrite(getDB(), 'products.manage')
      // Photo links in the CSV: download and compress each one first (4 at a time).
      let photosCompressed = 0, photosLinked = 0
      const items = [...rows]
      const withPhoto = items.map((it, i) => ({ it, i })).filter((x) => x.it.imageUrl)
      for (let k = 0; k < withPhoto.length; k += 4) {
        await Promise.all(withPhoto.slice(k, k + 4).map(async ({ it, i }) => {
          const r = await storeImage(it.imageUrl).catch(() => ({ imageUrl: null, thumbUrl: null, linked: false }))
          if (r?.imageUrl && !('linked' in r && r.linked)) photosCompressed++; else if (r?.imageUrl) photosLinked++
          items[i] = { ...it, imageUrl: r?.imageUrl ?? null, thumbUrl: r?.thumbUrl ?? null }
        }))
      }
      return tx((d) => {
        const s = requirePerm(d, 'products.manage')
        if (!items.length) throw new ApiError('Choose at least one row to import')
        if (items.length > 5000) throw new ApiError('Up to 5,000 rows at a time')
        const b = biz(d)
        const branch = writeBranch(d, { fallback: true })
        const catByName = new Map(mine(d.categories).map((c) => [c.name.trim().toLowerCase(), c]))
        const newCats: string[] = []
        const categoryFor = (name?: string) => {
          if (!name?.trim()) return undefined
          const key = name.trim().toLowerCase()
          let c = catByName.get(key)
          if (!c) {
            c = { id: uid('cat_'), businessId: s.businessId, name: name.trim(), emoji: '📦', sort: mine(d.categories).length }
            d.categories.push(c); catByName.set(key, c); newCats.push(c.name)
          }
          return c.id
        }
        const all = mine(d.products)
        const byBarcode = new Map(all.filter((p) => p.barcode).map((p) => [p.barcode, p]))
        const byName = new Map(all.map((p) => [p.name.trim().toLowerCase(), p]))
        const seen = new Set<string>()
        let created = 0, updated = 0
        const skippedRows: number[] = []
        for (const it of items) {
          // The browser already checked the rows; the server checks the basics again.
          const name = (it.name ?? '').trim()
          if (!name || !(it.price >= 0)) throw new ApiError(`Row ${it.row + 2}: name and a valid price are needed`)
          if (it.barcode) {
            if (seen.has(it.barcode)) throw new ApiError(`Row ${it.row + 2}: barcode ${it.barcode} is used twice in the file`)
            seen.add(it.barcode)
          }
          const opt = (list?: { name: string; price: number }[]) => list?.map((x) => ({ id: uid('opt_'), name: x.name, price: x.price }))
          const ex = (it.barcode && byBarcode.get(it.barcode)) || byName.get(name.toLowerCase())
          if (ex) {
            if (opts.onExisting === 'skip') { skippedRows.push(it.row); continue }
            const patch: Partial<Product> = { name, price: it.price }
            const set = <K extends keyof Product>(k: K, v: Product[K] | undefined) => { if (v !== undefined) patch[k] = v }
            set('categoryId', categoryFor(it.categoryName)); set('mrp', it.mrp); set('wholesalePrice', it.wholesalePrice); set('costPrice', it.costPrice); set('barcode', it.barcode); set('sku', it.sku)
            set('unit', it.unit); set('taxRateId', it.taxRateId); set('isVeg', it.isVeg); set('variants', opt(it.variants)); set('addOns', opt(it.addOns))
            set('trackStock', it.trackStock); set('lowStockAt', it.lowStockAt); set('trackExpiry', it.trackExpiry); set('sendToKitchen', it.sendToKitchen)
            set('kind', it.kind); set('imageUrl', it.imageUrl); set('thumbUrl', it.thumbUrl); set('active', it.active)
            Object.assign(ex, patch)
            touch(ex, s.userId)
            updated++
            continue // stock of existing items changes only through Inventory, never by re-importing
          }
          const service = it.kind === 'service'
          const p: Product = {
            id: uid('prd_'), businessId: s.businessId, name, categoryId: categoryFor(it.categoryName) ?? null, kind: it.kind ?? (b.category === 'service' ? 'service' : 'goods'),
            emoji: '', imageUrl: it.imageUrl ?? null, thumbUrl: it.thumbUrl ?? null, mrp: it.mrp ?? null, sku: it.sku ?? '', barcode: it.barcode ?? '', unit: it.unit || (service ? 'service' : templateFor(b.category).units[0] ?? 'pc'),
            price: it.price, wholesalePrice: it.wholesalePrice ?? null, costPrice: it.costPrice ?? 0, variants: opt(it.variants) ?? [], addOns: opt(it.addOns) ?? [], taxRateId: it.taxRateId ?? null,
            trackStock: !service && (it.trackStock ?? b.category === 'retail'), trackExpiry: it.trackExpiry ?? false, stock: 0, stockByBranch: {}, lowStockAt: it.lowStockAt ?? (b.category === 'retail' ? 5 : 0),
            isVeg: it.isVeg ?? true, sendToKitchen: it.sendToKitchen ?? (b.category === 'food' || b.category === 'restaurant'), active: it.active ?? true, ...stamp(s.userId),
          }
          d.products.push(p)
          byName.set(name.toLowerCase(), p); if (p.barcode) byBarcode.set(p.barcode, p)
          if (p.trackStock && (it.stock ?? 0) > 0) moveStock(d, p.id, 'opening', it.stock!, 'Opening stock (import)', null, branch, p.trackExpiry ? { batchNo: it.batchNo, expiry: it.expiry } : undefined)
          created++
        }
        audit(d, 'product', 'import', 'import', `${created} added, ${updated} updated, ${skippedRows.length} skipped from ${opts.fileName}`)
        return { created, updated, skippedRows, newCategories: newCats, photosCompressed, photosLinked }
      })
    },
    /** Give every listed product without a barcode its own in-store EAN-13 (prefix 20), for printing labels. */
    async assignBarcodes(ids: ID[]) {
      return tx((d) => {
        const s = requirePerm(d, 'products.manage')
        const all = mine(d.products)
        const out: Record<ID, string> = {}
        for (const p of all.filter((x) => ids.includes(x.id) && !x.barcode.trim())) {
          p.barcode = nextInStoreBarcode(all.map((x) => x.barcode))
          touch(p, s.userId)
          audit(d, 'product', p.id, 'update', `${p.name}: barcode ${p.barcode}`)
          out[p.id] = p.barcode
        }
        return out
      })
    },
  },

  customers: {
    async list() {
      const d = getDB()
      return clone(mine(d.customers).map((c) => ({ ...c, stats: customerStats(d, c.id) })))
    },
    async history(customerId: string) {
      const d = getDB()
      return clone({
        orders: mine(d.orders).filter((o) => o.customerId === customerId && o.status !== 'open').sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        payments: mine(d.payments).filter((p) => p.customerId === customerId && !p.voided).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      })
    },
    async save(c: Partial<Customer> & { name: string }) {
      return tx((d) => {
        const s = ctx()
        const phone = cleanPhone(c.phone, biz(d).defaultCountry)
        if (phone && d.customers.some((x) => x.businessId === s.businessId && x.phone === phone && x.id !== c.id)) throw new ApiError('A customer with this phone already exists')
        const ex = c.id ? d.customers.find((x) => x.id === c.id && x.businessId === s.businessId) : null
        if (ex) { Object.assign(ex, { ...c, phone }); touch(ex, s.userId); return clone(ex) }
        const nc: Customer = { id: uid('cus_'), businessId: s.businessId, name: c.name.trim(), phone, email: c.email ?? '', address: c.address ?? '', notes: c.notes ?? '', marketingOptIn: c.marketingOptIn ?? true, priceTier: c.priceTier === 'wholesale' ? 'wholesale' : 'retail', ...stamp(s.userId) }
        d.customers.push(nc)
        audit(d, 'customer', nc.id, 'create', nc.name)
        return clone(nc)
      })
    },
    /** Collect outstanding dues — allocated to the oldest unpaid bills first (FIFO). */
    async collectDue(customerId: string, amount: number, method: PaymentMethod, reference = '') {
      return tx((d) => {
        const s = requirePerm(d, 'payments.collect')
        let left = r2(amount)
        if (left <= 0) throw new ApiError('Enter an amount')
        const dues = mine(d.orders).filter((o) => o.customerId === customerId && o.status === 'completed' && o.balance > 0)
          .sort((a, b) => a.billedAt!.localeCompare(b.billedAt!))
        const outstanding = r2(dues.reduce((a, o) => a + o.balance, 0))
        if (left > outstanding + 0.001) throw new ApiError(`Amount is more than outstanding (${outstanding})`)
        for (const o of dues) {
          if (left <= 0) break
          const part = Math.min(left, o.balance)
          d.payments.push({ id: uid('pay_'), businessId: s.businessId, branchId: writeBranch(d, { fallback: true }), orderId: o.id, customerId, method, kind: 'due_collection', amount: r2(part), reference, voided: false, ...stamp(s.userId) })
          o.paid = r2(o.paid + part); o.balance = r2(o.total - o.paid)
          o.paymentStatus = o.balance <= 0 ? 'paid' : 'partial'
          touch(o, s.userId)
          left = r2(left - part)
        }
        audit(d, 'customer', customerId, 'collect_due', `${amount} via ${method}`)
      })
    },
  },

  orders: {
    async list(filter: { from?: Date; to?: Date; status?: Order['status'] | 'all' } = {}) {
      const d = getDB()
      return clone(here(d, d.orders).filter((o) => {
        if (filter.status && filter.status !== 'all' && o.status !== filter.status) return false
        if (filter.from && filter.to && !inRange(o.createdAt, filter.from, filter.to) && !inRange(o.billedAt, filter.from, filter.to)) return false
        return true
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    },
    async running() {
      return clone(here(getDB(), getDB().orders).filter((o) => o.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    },
    async get(id: string) {
      const d = getDB()
      const o = here(d, d.orders).find((x) => x.id === id)
      if (!o) throw new ApiError('Order not found')
      return clone({ order: o, payments: d.payments.filter((p) => p.orderId === id), kots: d.kots.filter((k) => k.orderId === id) })
    },
    /** Create/update a running order (tables, mobile). Optionally sends new items to the kitchen. */
    async save(draft: OrderDraft, opts: { sendToKitchen?: boolean } = {}) {
      return tx((d) => {
        if (draft.type === 'dine_in' && !draft.tableId) throw new ApiError('Select a table')
        if (draft.tableId && !draft.id) {
          const busy = here(d, d.orders).find((o) => o.status === 'open' && o.tableId === draft.tableId)
          if (busy) throw new ApiError('This table already has a running order')
        }
        const o = writeOrder(d, draft)
        const kot = opts.sendToKitchen && biz(d).modules.kitchen ? kitchenDelta(d, o) : null
        return clone({ order: o, kot })
      })
    },
    /** Move a customer order on the orders board (New → Packing → Ready). Delivered happens when it's paid. */
    async setFulfilment(orderId: string, stage: 'new' | 'packing' | 'ready') {
      return tx((d) => {
        const s = requirePerm(d, 'orders.view')
        const o = here(d, d.orders).find((x) => x.id === orderId)
        if (!o || o.status !== 'open') throw new ApiError('This order is no longer open')
        o.fulfilment = stage
        touch(o, s.userId)
        audit(d, 'order', o.id, `stage_${stage}`, o.number)
      })
    },
    /** Customer orders for the board: open ones + those delivered today. */
    async board() {
      const since = new Date(); since.setHours(0, 0, 0, 0)
      return clone(here(getDB(), getDB().orders).filter((o) => (o.status === 'open' && o.qrStatus !== 'pending' && !o.tableId) || (o.status === 'completed' && o.fulfilment === 'delivered' && (o.billedAt ?? '') >= since.toISOString()))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    },
    async sendToKitchen(orderId: string) {
      return tx((d) => {
        const o = here(d, d.orders).find((x) => x.id === orderId)
        if (!o) throw new ApiError('Order not found')
        return clone(kitchenDelta(d, o))
      })
    },
    /** Fast billing: create + (kitchen) + settle in one transaction. */
    async checkout(draft: OrderDraft, pays: PaymentInput[]) {
      return tx((d) => {
        requirePerm(d, 'billing.create')
        if (!draft.items.length) throw new ApiError('Add at least one item')
        const o = writeOrder(d, draft)
        if (biz(d).modules.kitchen && draft.type !== 'counter') kitchenDelta(d, o)
        settle(d, o, pays)
        return clone(o)
      })
    },
    async settle(orderId: string, pays: PaymentInput[], patch?: { discount?: number; customerId?: string | null }) {
      return tx((d) => {
        requirePerm(d, 'billing.create')
        const o = here(d, d.orders).find((x) => x.id === orderId)
        if (!o || o.status !== 'open') throw new ApiError('Order is not running')
        if (patch) {
          if (patch.customerId !== undefined) o.customerId = patch.customerId
          if (patch.discount !== undefined) {
            Object.assign(o, computeTotals(o.items, patch.discount, biz(d).billing))
            o.balance = r2(o.total - o.paid)
          }
        }
        settle(d, o, pays)
        return clone(o)
      })
    },
    async cancel(orderId: string, reason: string) {
      return tx((d) => {
        const s = requirePerm(d, 'orders.cancel')
        if (!reason.trim()) throw new ApiError('Reason is required')
        const o = here(d, d.orders).find((x) => x.id === orderId)
        if (!o || o.status === 'cancelled') throw new ApiError('Order not found')
        const wasBilled = o.status === 'completed'
        o.status = 'cancelled'; o.cancelledAt = nowIso(); o.cancelReason = reason
        touch(o, s.userId)
        // Reverse money and stock instead of deleting.
        d.payments.filter((p) => p.orderId === o.id && !p.voided).forEach((p) => { p.voided = true; touch(p, s.userId) })
        if (wasBilled) o.items.forEach((i) => moveStock(d, i.productId, 'return', i.qty, `Cancelled — ${o.invoiceNumber}`, o.id, o.branchId))
        d.kots.filter((k) => k.orderId === o.id && k.status !== 'completed').forEach((k) => { k.status = 'cancelled'; k.statusAt = nowIso() })
        if (o.tableId) d.tables.forEach((t) => { if (t.mergedInto === o.tableId) t.mergedInto = null })
        audit(d, 'order', o.id, 'cancel', reason)
        return clone(o)
      })
    },
    async transferTable(orderId: string, toTableId: string) {
      return tx((d) => {
        const o = here(d, d.orders).find((x) => x.id === orderId && x.status === 'open')
        if (!o) throw new ApiError('Order not found')
        if (here(d, d.orders).some((x) => x.status === 'open' && x.tableId === toTableId)) throw new ApiError('Target table is occupied')
        const from = o.tableId
        o.tableId = toTableId; o.type = 'dine_in'
        touch(o, ctx().userId)
        d.tables.forEach((t) => { if (t.mergedInto === from) t.mergedInto = toTableId })
        const label = d.tables.find((t) => t.id === toTableId)?.label ?? null
        d.kots.filter((k) => k.orderId === o.id).forEach((k) => { k.tableLabel = label })
        audit(d, 'order', o.id, 'transfer', `${from} -> ${toTableId}`)
      })
    },
    /** Merge: move the other table's items into the primary order and link the table. */
    async mergeTables(primaryOrderId: string, otherTableId: string) {
      return tx((d) => {
        const s = ctx()
        const primary = here(d, d.orders).find((x) => x.id === primaryOrderId && x.status === 'open')
        if (!primary || !primary.tableId) throw new ApiError('Order not found')
        const other = here(d, d.orders).find((x) => x.status === 'open' && x.tableId === otherTableId)
        if (other) {
          primary.items = [...primary.items, ...other.items]
          Object.assign(primary, computeTotals(primary.items, primary.discount + other.discount, biz(d).billing))
          primary.balance = r2(primary.total - primary.paid)
          other.status = 'cancelled'; other.cancelledAt = nowIso(); other.cancelReason = `Merged into ${primary.number}`
          d.kots.filter((k) => k.orderId === other.id).forEach((k) => { k.orderId = primary.id; k.orderNumber = primary.number })
          touch(other, s.userId)
        }
        const t = d.tables.find((x) => x.id === otherTableId)
        if (t) t.mergedInto = primary.tableId
        touch(primary, s.userId)
        audit(d, 'order', primary.id, 'merge', otherTableId)
      })
    },
  },

  payments: {
    async list(from: Date, to: Date) {
      return clone(here(getDB(), getDB().payments).filter((p) => inRange(p.createdAt, from, to)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    },
  },

  kitchen: {
    async list() {
      const since = new Date(); since.setHours(0, 0, 0, 0)
      return clone(here(getDB(), getDB().kots).filter((k) => k.status === 'new' || k.status === 'preparing' || k.status === 'ready' || k.createdAt >= since.toISOString())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    },
    async setStatus(id: string, status: KotStatus) {
      return tx((d) => {
        const k = here(d, d.kots).find((x) => x.id === id)
        if (!k) throw new ApiError('Ticket not found')
        k.status = status; k.statusAt = nowIso()
        touch(k, ctx().userId)
      })
    },
  },

  tables: {
    async list() { return clone(here(getDB(), getDB().tables)) },
    async save(t: Partial<DiningTable> & { label: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'settings.manage')
        const ex = t.id ? d.tables.find((x) => x.id === t.id) : null
        if (ex) { Object.assign(ex, t); return clone(ex) }
        const nt: DiningTable = { id: uid('tbl_'), businessId: s.businessId, branchId: writeBranch(d), label: t.label, floor: t.floor || 'Main', seats: t.seats ?? 4, mergedInto: null }
        d.tables.push(nt)
        return clone(nt)
      })
    },
    async remove(id: string) {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        if (here(d, d.orders).some((o) => o.status === 'open' && o.tableId === id)) throw new ApiError('Table has a running order')
        d.tables = d.tables.filter((t) => t.id !== id)
      })
    },
    /** Unlink a merged table without closing the primary order. */
    async unmerge(id: string) {
      return tx((d) => { const t = here(d, d.tables).find((x) => x.id === id); if (t) t.mergedInto = null })
    },
  },

  expenses: {
    async list(from: Date, to: Date) {
      return clone(here(getDB(), getDB().expenses).filter((e) => inRange(e.date, from, to)).sort((a, b) => b.date.localeCompare(a.date)))
    },
    async save(e: Partial<Expense> & { amount: number; category: Expense['category'] }) {
      return tx((d) => {
        const s = requirePerm(d, 'expenses.manage')
        if (!(e.amount > 0)) throw new ApiError('Enter a valid amount')
        const ex = e.id ? d.expenses.find((x) => x.id === e.id && x.businessId === s.businessId) : null
        if (ex) { Object.assign(ex, e); touch(ex, s.userId); audit(d, 'expense', ex.id, 'update', String(e.amount)); return clone(ex) }
        const ne: Expense = {
          id: uid('exp_'), businessId: s.businessId, branchId: writeBranch(d, { requested: e.branchId }), date: e.date ?? nowIso(), category: e.category,
          amount: r2(e.amount), method: e.method ?? 'cash', notes: e.notes ?? '', voided: false, ...stamp(s.userId),
        }
        d.expenses.push(ne)
        audit(d, 'expense', ne.id, 'create', String(ne.amount))
        return clone(ne)
      })
    },
    async void(id: string) {
      return tx((d) => {
        const s = requirePerm(d, 'expenses.manage')
        const e = d.expenses.find((x) => x.id === id && x.businessId === s.businessId)
        if (e) { e.voided = true; touch(e, s.userId); audit(d, 'expense', id, 'void') }
      })
    },
  },

  inventory: {
    async movements(productId?: string) {
      return clone(here(getDB(), getDB().stockMovements).filter((m) => !productId || m.productId === productId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    },
    async adjust(productId: string, type: StockMovementType, qty: number, note: string, cost?: number, batch?: BatchInput) {
      return tx((d) => {
        requirePerm(d, 'inventory.manage')
        const p = mine(d.products).find((x) => x.id === productId)
        if (!p) throw new ApiError('Product not found')
        if (!p.trackStock) p.trackStock = true
        const signed = type === 'purchase' || type === 'opening' || type === 'return' ? Math.abs(qty) : type === 'adjustment' ? qty : -Math.abs(qty)
        if (stockIn(p, [writeBranch(d)]) + signed < 0) throw new ApiError('Stock cannot go below zero')
        if (p.trackExpiry && signed > 0 && (type === 'purchase' || type === 'opening') && !batch?.expiry) throw new ApiError('Enter the expiry date for this batch')
        if (batch?.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(batch.expiry)) throw new ApiError('Expiry date is not valid')
        moveStock(d, productId, type, signed, note, null, undefined, signed > 0 ? batch : undefined)
        if (type === 'purchase' && cost && cost > 0) {
          const s = ctx()
          d.expenses.push({ id: uid('exp_'), businessId: s.businessId, branchId: writeBranch(d), date: nowIso(), category: 'purchase', amount: r2(cost), method: 'cash', notes: `Stock purchase — ${p.name} × ${qty}`, voided: false, ...stamp(s.userId) })
        }
        audit(d, 'stock', productId, type, `${signed} ${note}`)
      })
    },
    /** Batches in the current view with days to expiry (negative = already expired). */
    async batches() {
      const d = getDB()
      const today = dateKey()
      const day = (k: string) => new Date(`${k}T00:00:00`).getTime()
      return clone(here(d, d.batches).filter((b) => b.qty > 0).map((b) => {
        const p = d.products.find((x) => x.id === b.productId)
        return { ...b, product: p ? { id: p.id, name: p.name, unit: p.unit, emoji: p.emoji, imageUrl: p.imageUrl ?? null, costPrice: p.costPrice, barcode: p.barcode } : null,
          daysLeft: b.expiry ? Math.round((day(b.expiry) - day(today)) / 86400000) : null }
      }).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999')))
    },
    /** Remove what's left of a batch from stock (expired / damaged), recorded as wastage. */
    async writeOffBatch(batchId: string, reason = 'Expired') {
      return tx((d) => {
        const s = requirePerm(d, 'inventory.manage')
        const bt = here(d, d.batches).find((x) => x.id === batchId)
        if (!bt || bt.qty <= 0) throw new ApiError('Batch not found')
        const p = d.products.find((x) => x.id === bt.productId)!
        const qty = bt.qty
        // Take it from this exact batch, not FEFO.
        bt.qty = 0; touch(bt, s.userId)
        p.stockByBranch ??= {}
        p.stockByBranch[bt.branchId] = r2((p.stockByBranch[bt.branchId] ?? 0) - qty)
        p.stock = r2(Object.values(p.stockByBranch).reduce((a, v) => a + v, 0))
        d.stockMovements.push({ id: uid('stm_'), businessId: s.businessId, branchId: bt.branchId, productId: p.id, type: 'wastage', qty: -qty, balanceAfter: p.stockByBranch[bt.branchId], refId: bt.id, note: `${reason} — batch ${bt.batchNo || '—'} (exp ${bt.expiry || '—'})`, ...stamp(s.userId) })
        audit(d, 'stock', p.id, 'write_off_batch', `${qty} ${reason}`)
      })
    },
  },

  specials: {
    async list(date = dateKey()) { return clone(specialsFor(getDB(), ctx().businessId, date).sort((a, b) => a.sort - b.sort)) },
    /** Replace the specials list for one day. */
    async save(date: string, rows: Omit<Special, 'id' | 'businessId' | 'date'>[]) {
      return tx((d) => {
        const s = requirePerm(d, 'products.manage')
        d.specials = d.specials.filter((x) => !(x.businessId === s.businessId && x.date === date))
        rows.forEach((r, i) => d.specials.push({ ...r, id: uid('spl_'), businessId: s.businessId, date, sort: i }))
        audit(d, 'specials', date, 'update', `${rows.length} items`)
      })
    },
  },

  /** Help & support: tickets to the product team. Works even when the account is read-only. */
  support: {
    async uploadScreenshot(file: Blob) {
      if (session.get()?.support) throw new ApiError(SUPPORT_MESSAGE)
      // Screenshots stay readable: up to 1600 px / 200 KB (product photos are 800 px / 50 KB).
      try { return (await compressImage(file, { maxBytes: 200 * 1024, maxSide: 1600 })).url } catch (e) { throw new ApiError((e as Error).message) }
    },
    async mine() {
      const d = getDB(); const s = ctx()
      return clone(d.tickets.filter((t) => t.businessId === s.businessId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    },
    async create(input: { subject: string; category: TicketCategory; priority?: TicketPriority; message: string; images?: string[]; page?: string }) {
      return dbTx((d) => {
        const s = ctx()
        if (s.support) throw new ApiError(SUPPORT_MESSAGE)
        const u = d.users.find((x) => x.id === s.userId)!
        const b = d.businesses.find((x) => x.id === s.businessId)!
        const subject = input.subject.trim(), text = input.message.trim()
        if (subject.length < 4) throw new ApiError('Write a short title for the problem')
        if (text.length < 5) throw new ApiError('Tell us what happened')
        if ((input.images ?? []).length > 5) throw new ApiError('Up to 5 screenshots')
        const t = nowIso()
        const n = d.tickets.length + 1001
        const ticket: Ticket = {
          id: uid('tkt_'), number: `T-${n}`, businessId: b.id, businessName: b.name, userId: u.id, userName: u.name, userPhone: u.phone,
          subject: subject.slice(0, 120), category: input.category, priority: input.priority ?? 'normal', status: 'open', assignedTo: null,
          context: { page: input.page ?? '', browser: navigator.userAgent.replace(/^.*?(Chrome|Firefox|Safari|Edg)\/([\d.]+).*$/, '$1 $2').slice(0, 60), version: APP_VERSION },
          messages: [{ id: uid('tm_'), from: 'customer', authorId: u.id, authorName: u.name, text: text.slice(0, 4000), images: input.images ?? [], at: t }],
          createdAt: t, updatedAt: t, unreadForAdmin: true, unreadForCustomer: false,
        }
        d.tickets.push(ticket)
        return clone(ticket)
      })
    },
    async reply(id: string, text: string, images: string[] = []) {
      return dbTx((d) => {
        const s = ctx()
        if (s.support) throw new ApiError(SUPPORT_MESSAGE)
        const t = d.tickets.find((x) => x.id === id && x.businessId === s.businessId)
        if (!t) throw new ApiError('Ticket not found')
        if (!text.trim() && !images.length) throw new ApiError('Write a message')
        const u = d.users.find((x) => x.id === s.userId)!
        t.messages.push({ id: uid('tm_'), from: 'customer', authorId: u.id, authorName: u.name, text: text.trim().slice(0, 4000), images, at: nowIso() })
        if (t.status === 'resolved' || t.status === 'closed' || t.status === 'waiting') t.status = 'open'
        t.updatedAt = nowIso(); t.unreadForAdmin = true
      })
    },
    async markRead(id: string) {
      const s = ctx()
      if (!getDB().tickets.some((x) => x.id === id && x.businessId === s.businessId && x.unreadForCustomer)) return
      return dbTx((d) => { const t = d.tickets.find((x) => x.id === id && x.businessId === s.businessId); if (t) t.unreadForCustomer = false })
    },
    async resolve(id: string) {
      return dbTx((d) => { const s = ctx(); const t = d.tickets.find((x) => x.id === id && x.businessId === s.businessId); if (t) { t.status = 'resolved'; t.updatedAt = nowIso(); t.unreadForAdmin = true } })
    },
  },

  /** Owner downloads everything their business has (Settings → Audit & Data). */
  dataExport: {
    async mine() {
      const d = getDB()
      requirePerm(d, 'settings.manage')
      const s = ctx()
      if (s.support) throw new ApiError(SUPPORT_MESSAGE)
      return clone(exportTables(d, s.businessId, false))
    },
  },

  /** Daily background jobs — on the real server a cron runs these at 9 AM. */
  system: {
    async runDailyJobs() {
      const d = getDB()
      if (!candidatesForReminder(d, 'auto').length) return 0
      return dbTx((db) => sendReminders(db, { trigger: 'auto' }))
    },
  },

  /** Staff attendance, salary and commission (Staff page). */
  staff: {
    /** People who work in the current branch. */
    async list() {
      const d = getDB(); requirePerm(d, 'users.manage')
      const sc = scope(d)
      return clone(mine(d.users).filter((u) => u.active && allowedBranches(d, u).some((b) => sc.has(b))).map((u) => ({ id: u.id, name: u.name, phone: u.phone, role: d.roles.find((r) => r.id === u.roleId)?.name ?? '', pay: u.pay ?? null })))
    },
    async day(date: string) {
      const d = getDB(); requirePerm(d, 'users.manage')
      return clone(here(d, d.attendance).filter((a) => a.date === date))
    },
    async mark(userId: string, date: string, patch: { status?: AttendanceStatus; checkIn?: string | null; checkOut?: string | null; note?: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError('Choose a date')
        if (date > dateKey()) throw new ApiError('Attendance can’t be marked for a future date')
        if (!mine(d.users).some((u) => u.id === userId)) throw new ApiError('Staff member not found')
        const t = (v?: string | null) => (v == null || v === '' ? null : /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : (() => { throw new ApiError('Time must be like 09:30') })())
        const branchId = writeBranch(d, { fallback: true })
        let a = d.attendance.find((x) => x.businessId === s.businessId && x.branchId === branchId && x.userId === userId && x.date === date)
        if (!a) {
          if (!patch.status) throw new ApiError('Choose present, half day, absent or leave first')
          a = { id: uid('att_'), businessId: s.businessId, branchId, userId, date, status: patch.status, checkIn: null, checkOut: null, note: '', markedBy: s.userId, markedAt: nowIso() }
          d.attendance.push(a)
        }
        if (patch.status) a.status = patch.status
        if (patch.checkIn !== undefined) a.checkIn = t(patch.checkIn)
        if (patch.checkOut !== undefined) a.checkOut = t(patch.checkOut)
        if (a.checkIn && a.checkOut && a.checkOut < a.checkIn) throw new ApiError('Check-out is before check-in')
        if (patch.note !== undefined) a.note = patch.note.slice(0, 200)
        a.markedBy = s.userId; a.markedAt = nowIso()
        return clone(a)
      })
    },
    /** Everyone not marked yet that day → present. */
    async markAll(date: string, userIds: string[]) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        if (date > dateKey()) throw new ApiError('Attendance can’t be marked for a future date')
        const branchId = writeBranch(d, { fallback: true })
        let n = 0
        for (const userId of userIds) {
          if (d.attendance.some((x) => x.businessId === s.businessId && x.branchId === branchId && x.userId === userId && x.date === date)) continue
          d.attendance.push({ id: uid('att_'), businessId: s.businessId, branchId, userId, date, status: 'present', checkIn: null, checkOut: null, note: '', markedBy: s.userId, markedAt: nowIso() })
          n++
        }
        return n
      })
    },
    async setPay(userId: string, pay: StaffPay) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        const u = mine(d.users).find((x) => x.id === userId)
        if (!u) throw new ApiError('Staff member not found')
        if (!['monthly', 'daily'].includes(pay.type)) throw new ApiError('Choose monthly or daily')
        if (!(pay.amount >= 0)) throw new ApiError('Enter a valid salary')
        if (!(pay.commissionPct >= 0 && pay.commissionPct <= 50)) throw new ApiError('Commission must be between 0 and 50%')
        u.pay = { type: pay.type, amount: r2(pay.amount), commissionPct: r2(pay.commissionPct) }
        touch(u, s.userId)
        audit(d, 'user', u.id, 'pay', `${pay.type} ${pay.amount}${pay.commissionPct ? ` + ${pay.commissionPct}%` : ''}`)
      })
    },
    async giveAdvance(userId: string, input: { amount: number; method: PaymentMethod; note?: string; date?: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        const u = mine(d.users).find((x) => x.id === userId)
        if (!u) throw new ApiError('Staff member not found')
        if (!(input.amount > 0)) throw new ApiError('Enter the advance amount')
        const branchId = writeBranch(d, { fallback: true })
        const date = input.date || dateKey()
        d.advances.push({ id: uid('adv_'), businessId: s.businessId, branchId, userId, date, amount: r2(input.amount), method: input.method, note: (input.note ?? '').slice(0, 200), settledIn: null, ...stamp(s.userId) })
        d.expenses.push({ id: uid('exp_'), businessId: s.businessId, branchId, date: date === dateKey() ? nowIso() : new Date(`${date}T12:00:00`).toISOString(), category: 'salary', amount: r2(input.amount), method: input.method, notes: `Advance — ${u.name}${input.note ? ` (${input.note})` : ''}`, voided: false, ...stamp(s.userId) })
        audit(d, 'user', u.id, 'advance', String(input.amount))
      })
    },
    /** Attendance, commission and salary for a month (YYYY-MM), per staff member. */
    async month(month: string) {
      const d = getDB(); requirePerm(d, 'users.manage')
      return clone(payroll(d, month))
    },
    async paySalary(userId: string, month: string, input: { bonus?: number; deduction?: number; method: PaymentMethod; note?: string }) {
      return tx((d) => {
        const s = requirePerm(d, 'users.manage')
        const row = payroll(d, month).find((r) => r.userId === userId)
        if (!row) throw new ApiError('Staff member not found')
        if (!row.pay) throw new ApiError('Set the salary first')
        if (row.paid) throw new ApiError(`Salary for ${month} is already paid`)
        const bonus = r2(Math.max(0, input.bonus ?? 0)), deduction = r2(Math.max(0, input.deduction ?? 0))
        const net = r2(row.basePay + row.commission + bonus - deduction - row.advances)
        const branchId = writeBranch(d, { fallback: true })
        const sp: SalaryPayment = {
          id: uid('sal_'), businessId: s.businessId, branchId, userId, month, payType: row.pay.type, rate: row.pay.amount, daysInMonth: row.daysInMonth,
          present: row.present, half: row.half, leave: row.leave, absent: row.absent, unmarked: row.unmarked, basePay: row.basePay,
          commissionSales: row.sales, commission: row.commission, bonus, deduction, advances: row.advances, net, method: input.method, note: (input.note ?? '').slice(0, 200), ...stamp(s.userId),
        }
        d.salaries.push(sp)
        for (const a of d.advances) if (a.businessId === s.businessId && a.userId === userId && !a.settledIn && a.date.slice(0, 7) <= month) a.settledIn = sp.id
        if (net > 0) d.expenses.push({ id: uid('exp_'), businessId: s.businessId, branchId, date: nowIso(), category: 'salary', amount: net, method: input.method, notes: `Salary ${month} — ${row.name}`, voided: false, ...stamp(s.userId) })
        audit(d, 'user', userId, 'salary', `${month} · ${net}`)
        return clone(sp)
      })
    },
  },

  /** Returns, refunds and exchanges. Each return is a credit note (CN-1001). */
  returns: {
    /** What can still be returned from a bill (quantity already returned is taken off). */
    async forOrder(orderId: string) {
      const d = getDB()
      const o = mine(d.orders).find((x) => x.id === orderId)
      if (!o) throw new ApiError('Bill not found')
      const done = mine(d.returns).filter((r) => r.orderId === orderId)
      const returned = (itemId: string) => done.reduce((a, r) => a + r.lines.filter((l) => l.orderItemId === itemId).reduce((x, l) => x + l.qty, 0), 0)
      return clone({ returns: done, items: o.items.map((i) => ({ ...i, returned: returned(i.id), returnable: r2(i.qty - returned(i.id)) })), ratio: o.subtotal > 0 ? o.total / o.subtotal : 0 })
    },
    async list(limit = 200) {
      return clone(here(getDB(), getDB().returns).slice(-limit).reverse())
    },
    async creditNote(number: string) {
      const cn = mine(getDB().returns).find((r) => r.number.toUpperCase() === number.trim().toUpperCase())
      if (!cn) throw new ApiError(`Credit note ${number} not found`)
      return clone(cn)
    },
    async create(input: { orderId: string; lines: { orderItemId: string; qty: number; restock: boolean }[]; reason: ReturnReason; note?: string; settle: 'refund' | 'credit_note'; refundMethod?: PaymentMethod }) {
      return tx((d) => {
        const s = requirePerm(d, 'orders.cancel')
        const b = biz(d)
        const o = mine(d.orders).find((x) => x.id === input.orderId)
        if (!o || o.status !== 'completed' || !o.invoiceNumber) throw new ApiError('Only completed bills can be returned')
        const done = mine(d.returns).filter((r) => r.orderId === o.id)
        const ratio = o.subtotal > 0 ? o.total / o.subtotal : 0
        const lines: SaleReturnLine[] = []
        for (const l of input.lines) {
          if (!(l.qty > 0)) continue
          const it = o.items.find((x) => x.id === l.orderItemId)
          if (!it) throw new ApiError('That item isn’t on this bill')
          const already = done.reduce((a, r) => a + r.lines.filter((x) => x.orderItemId === it.id).reduce((y, x) => y + x.qty, 0), 0)
          if (l.qty > r2(it.qty - already) + 0.0001) throw new ApiError(`Only ${r2(it.qty - already)} of ${it.name} can be returned`)
          lines.push({ orderItemId: it.id, productId: it.productId, name: it.variantName ? `${it.name} (${it.variantName})` : it.name, qty: l.qty, unit: it.unit, unitPrice: it.unitPrice, amount: r2(it.unitPrice * l.qty * ratio), restock: !!l.restock })
        }
        if (!lines.length) throw new ApiError('Choose at least one item to return')
        // Whole rupees when the shop rounds its bills (but never more than what's left of the bill).
        const exact = lines.reduce((a, l) => a + l.amount, 0)
        const returnedBefore = done.reduce((a, r) => a + r.total, 0)
        const total = r2(Math.min(b.billing.roundOff ? Math.round(exact) : exact, o.total - returnedBefore))
        const gross = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0)
        const tax = o.subtotal > 0 ? r2(o.tax * gross / o.subtotal) : 0
        // A pending due on this bill is reduced first — nobody gets money back for something not paid for.
        const dueAdjusted = r2(Math.min(total, o.balance))
        const rest = r2(total - dueAdjusted)
        let refunded = 0, creditIssued = 0
        if (rest > 0 && input.settle === 'refund') {
          const method = input.refundMethod && !['credit', 'credit_note'].includes(input.refundMethod) ? input.refundMethod : 'cash'
          refunded = rest
          d.payments.push({ id: uid('pay_'), businessId: s.businessId, branchId: writeBranch(d, { fallback: true }), orderId: o.id, customerId: o.customerId, method, kind: 'refund', amount: rest, reference: '', voided: false, ...stamp(s.userId) })
        } else if (rest > 0) creditIssued = rest
        if (dueAdjusted > 0) {
          o.balance = r2(o.balance - dueAdjusted)
          o.paymentStatus = o.balance <= 0 ? 'paid' : o.paid > 0 ? 'partial' : 'unpaid'
          touch(o, s.userId)
        }
        b.billing.creditNotePrefix ??= 'CN-'
        b.billing.nextCreditNoteNumber ??= 1001
        const r: SaleReturn = {
          id: uid('ret_'), businessId: s.businessId, branchId: writeBranch(d, { fallback: true }), number: `${b.billing.creditNotePrefix}${b.billing.nextCreditNoteNumber++}`,
          orderId: o.id, invoiceNumber: o.invoiceNumber, customerId: o.customerId, lines, total, tax, reason: input.reason, note: (input.note ?? '').trim().slice(0, 300),
          dueAdjusted, refunded, refundMethod: refunded ? (input.refundMethod ?? 'cash') : null, creditIssued, creditRemaining: creditIssued, ...stamp(s.userId),
        }
        d.returns.push(r)
        for (const l of lines) if (l.restock) moveStock(d, l.productId, 'return', l.qty, `Returned — ${r.number} (${o.invoiceNumber})`, r.id, r.branchId)
        audit(d, 'order', o.id, 'return', `${r.number} · ${b.currencySymbol}${total} · ${lines.length} item(s)`)
        return clone(r)
      })
    },
  },

  /** File uploads (mock of POST /api/uploads). Photos are compressed here before anything is stored. */
  media: {
    async upload(file: Blob) {
      assertCanWrite(getDB(), 'products.manage')
      try { return await compressImage(file) } catch (e) { throw new ApiError((e as Error).message) }
    },
  },

  campaigns: {
    async today() {
      return clone(mine(getDB().campaigns).filter((c) => c.date === dateKey()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    },
    async create(input: { message: string; productIds: string[] }) {
      return tx((d) => {
        const s = requirePerm(d, 'customers.manage')
        const c: Campaign = { id: uid('cmp_'), businessId: s.businessId, date: dateKey(), channel: 'whatsapp', message: input.message, productIds: input.productIds, sends: [], createdAt: nowIso(), createdBy: s.userId }
        d.campaigns.push(c)
        audit(d, 'campaign', c.id, 'create', `${input.productIds.length} items`)
        return clone(c)
      })
    },
    async update(id: string, message: string, productIds: string[]) {
      return tx((d) => {
        const c = mine(d.campaigns).find((x) => x.id === id)
        if (c) { c.message = message; c.productIds = productIds }
      })
    },
    async markSent(id: string, customerId: string) {
      return tx((d) => {
        const s = ctx()
        const c = mine(d.campaigns).find((x) => x.id === id)
        if (!c) throw new ApiError('Campaign not found')
        if (!c.sends.some((x) => x.customerId === customerId)) c.sends.push({ customerId, at: nowIso(), by: s.userId })
      })
    },
  },

  qr: {
    async pending() {
      return clone(here(getDB(), getDB().orders).filter((o) => o.source === 'qr' && o.qrStatus === 'pending' && o.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    },
    async recent() {
      const since = new Date(); since.setHours(0, 0, 0, 0)
      return clone(here(getDB(), getDB().orders).filter((o) => o.source === 'qr' && o.createdAt >= since.toISOString()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    },
    async accept(orderId: string) {
      return tx((d) => {
        const s = requirePerm(d, 'tables.manage')
        const o = here(d, d.orders).find((x) => x.id === orderId)
        if (!o || o.qrStatus !== 'pending' || o.status !== 'open') throw new ApiError('This QR order is no longer pending')
        touch(o, s.userId)
        const target = acceptQr(d, o, s.userId)
        audit(d, 'order', o.id, 'qr_accept', target.number)
        return clone(target)
      })
    },
    async reject(orderId: string, reason: string) {
      return tx((d) => {
        const s = requirePerm(d, 'tables.manage')
        const o = here(d, d.orders).find((x) => x.id === orderId)
        if (!o || o.qrStatus !== 'pending') throw new ApiError('This QR order is no longer pending')
        o.qrStatus = 'rejected'; o.status = 'cancelled'; o.cancelledAt = nowIso(); o.cancelReason = reason || 'Rejected'
        touch(o, s.userId)
        audit(d, 'order', o.id, 'qr_reject', reason)
      })
    },
  },

  /** Endpoints that work without staff login (customer QR menu, TV display). */
  public: {
    async menu(businessId: string, branchId?: string | null, tableId?: string | null) {
      const d = getDB()
      const b = d.businesses.find((x) => x.id === businessId)
      if (!b) throw new ApiError('Menu not found')
      // A table QR identifies its branch through the table.
      const tableBranchId = tableId ? d.tables.find((t) => t.id === tableId && t.businessId === businessId)?.branchId : null
      const br = publicBranch(d, businessId, tableBranchId ?? branchId)
      const products = d.products.filter((p) => p.businessId === businessId && p.active && !(p.trackStock && stockIn(p, [br.id]) <= 0))
      const sp = applySpecials(products, specialsFor(d, businessId))
      return clone({
        business: { id: b.id, name: b.name, logoEmoji: b.logoEmoji, subType: b.subType, address: b.address, phone: b.phone, defaultCountry: b.defaultCountry ?? 'IN', currencySymbol: b.currencySymbol, billing: b.billing, modules: b.modules, terminology: b.terminology, qr: qrSettings(b) },
        categories: d.categories.filter((c) => c.businessId === businessId).sort((a, x) => a.sort - x.sort),
        products: sp.products,
        specials: sp.specials,
        specialInfo: [...sp.info.entries()].map(([productId, v]) => ({ productId, tag: v.special.tag, originalPrice: v.originalPrice, specialPrice: v.special.specialPrice })),
        tables: d.tables.filter((t) => t.businessId === businessId && t.branchId === br.id).map((t) => ({ id: t.id, label: t.label })),
        branch: { id: br.id, name: br.name, address: br.address, phone: br.phone ?? '' },
        branchCount: d.branches.filter((x) => x.businessId === businessId).length,
      })
    },
    async placeOrder(businessId: string, input: PublicOrderInput) {
      return dbTx((d) => {
        // Guests order for this business — check its account, not whoever is signed in on this device.
        const ob = d.businesses.find((x) => x.id === businessId)
        if (ob && !subscriptionState(ob).blocked && subscriptionState(ob).readOnly) throw new ApiError('Online ordering is not available right now.')
        assertWritable(ob)
        const b = d.businesses.find((x) => x.id === businessId)
        if (!b || !b.modules.qrOrdering) throw new ApiError('Online ordering is not available right now')
        const qr = qrSettings(b)
        if (!qr.orderTypes.includes(input.type)) throw new ApiError('This order type is not available')
        const table = input.tableId ? d.tables.find((t) => t.id === input.tableId && t.businessId === businessId) : null
        const br = publicBranch(d, businessId, table?.branchId ?? input.branchId)
        if (input.type === 'dine_in' && !table) throw new ApiError('Please scan the QR code on your table')
        const phone = cleanPhone(input.guest.phone, b.defaultCountry, input.type !== 'dine_in' ? { required: 'Enter your mobile number' } : {})
        if (input.type !== 'dine_in' && !input.guest.name.trim()) throw new ApiError('Enter your name')
        if (input.type === 'delivery' && input.guest.address.trim().length < 8) throw new ApiError('Enter the full delivery address')
        if (!input.items.length || input.items.length > 40) throw new ApiError('Add items to your order')
        // Never trust prices from the customer's device: re-price every line from the catalogue.
        const catalogue = applySpecials(d.products.filter((p) => p.businessId === businessId && p.active), specialsFor(d, businessId)).products
        const items = input.items.map((i) => {
          const p = catalogue.find((x) => x.id === i.productId)
          if (!p) throw new ApiError('An item in your cart is no longer available')
          if (p.trackStock && stockIn(p, [br.id]) < i.qty) throw new ApiError(`${p.name} is out of stock`)
          const qty = Math.min(50, Math.max(1, Math.round(i.qty)))
          const variant = p.variants.find((v) => v.id === i.variantId) ?? (p.variants[0] ?? null)
          return makeItem(p, b.billing, { variant, addOns: p.addOns.filter((a) => i.addOnIds.includes(a.id)), qty, notes: i.notes.slice(0, 120) })
        })
        const branchId = br.id
        // Link to an existing customer by phone, or create one.
        let customerId: string | null = null
        if (phone) {
          let c = d.customers.find((x) => x.businessId === businessId && x.phone === phone)
          if (!c) {
            const t = nowIso()
            c = { id: uid('cus_'), businessId, name: input.guest.name.trim() || 'Guest', phone, email: '', address: input.guest.address.trim(), notes: 'Created from QR order', createdAt: t, createdBy: 'guest', updatedAt: t, updatedBy: 'guest' }
            d.customers.push(c)
          }
          customerId = c.id
        }
        const totals = computeTotals(items, 0, b.billing)
        const t = nowIso()
        const o: Order = {
          id: uid('ord_'), number: `${b.billing.orderPrefix}${b.billing.nextOrderNumber++}`, businessId, branchId,
          type: input.type, tableId: table?.id ?? null, customerId, status: 'open', items, notes: input.notes.slice(0, 200),
          ...totals, paid: 0, balance: totals.total, paymentStatus: 'unpaid', invoiceNumber: null, billedAt: null, cancelledAt: null, cancelReason: null,
          source: 'qr', qrStatus: 'pending', guest: { name: input.guest.name.trim(), phone, address: input.guest.address.trim() },
          createdAt: t, createdBy: 'guest', updatedAt: t, updatedBy: 'guest',
        }
        d.orders.push(o)
        if (qr.autoAccept) acceptQr(d, o, 'guest')
        d.auditLogs.push({ id: uid('aud_'), businessId, entity: 'order', entityId: o.id, action: 'qr_place', userId: 'guest', at: t, detail: `${o.number} ${input.type}` })
        return { orderId: o.id, number: o.number }
      })
    },
    /** Status for the customer's tracking screen — only that one order is exposed. */
    async order(businessId: string, orderId: string) {
      const d = getDB()
      let o = d.orders.find((x) => x.id === orderId && x.businessId === businessId)
      if (!o) throw new ApiError('Order not found')
      const merged = o.cancelReason?.startsWith('Merged into ') ? d.orders.find((x) => x.businessId === businessId && x.number === o!.cancelReason!.slice(12)) : null
      if (merged) o = { ...merged, qrStatus: 'accepted' }
      const kots = d.kots.filter((k) => k.orderId === o!.id).map((k) => k.status)
      return clone({
        number: o.number, type: o.type, status: o.status, qrStatus: o.qrStatus, total: o.total, items: o.items,
        table: d.tables.find((t) => t.id === o!.tableId)?.label ?? null, cancelReason: merged ? null : o.cancelReason,
        kitchen: kots.length ? (kots.includes('new') ? 'new' : kots.includes('preparing') ? 'preparing' : kots.includes('ready') ? 'ready' : 'completed') : null,
        paymentStatus: o.paymentStatus,
      })
    },
    async specials(businessId: string) {
      const d = getDB()
      const b = d.businesses.find((x) => x.id === businessId)
      if (!b) throw new ApiError('Not found')
      const sp = applySpecials(d.products.filter((p) => p.businessId === businessId && p.active), specialsFor(d, businessId))
      return clone({
        business: { name: b.name, logoEmoji: b.logoEmoji, subType: b.subType, currencySymbol: b.currencySymbol, qr: qrSettings(b), qrOn: b.modules.qrOrdering },
        items: sp.specials.map((p) => ({ product: p, ...sp.info.get(p.id)! })),
      })
    },
  },

  reports: {
    async summary(from: Date, to: Date) { return summarize(getDB(), from, to) },
    /** One summary per branch in the current view, plus live alerts — for the multi-branch dashboard. */
    async byBranch(from: Date, to: Date) {
      const d = getDB()
      const sc = scope(d)
      const late = Date.now() - 20 * 60000
      return clone(mine(d.branches).filter((b) => sc.has(b.id)).map((b) => ({
        branch: b,
        summary: summarize(d, from, to, new Set([b.id])),
        running: mine(d.orders).filter((o) => o.branchId === b.id && o.status === 'open').length,
        pendingQr: mine(d.orders).filter((o) => o.branchId === b.id && o.status === 'open' && o.qrStatus === 'pending').length,
        lateKots: mine(d.kots).filter((k) => k.branchId === b.id && (k.status === 'new' || k.status === 'preparing') && new Date(k.createdAt).getTime() < late).map((k) => ({ number: k.number, minutes: Math.floor((Date.now() - new Date(k.createdAt).getTime()) / 60000) })),
        lowStock: mine(d.products).filter((p) => p.active && p.trackStock && stockIn(p, [b.id]) <= p.lowStockAt).map((p) => ({ name: p.name, stock: stockIn(p, [b.id]), unit: p.unit })),
      })))
    },
    async receivables() {
      const d = getDB()
      return clone(mine(d.customers).map((c) => ({ customer: c, ...customerStats(d, c.id) })).filter((x) => x.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding))
    },
  },

  audit: {
    async list(limit = 50) {
      const d = getDB()
      return clone(mine(d.auditLogs).slice(-limit).reverse().map((a) => ({ ...a, userName: d.users.find((u) => u.id === a.userId)?.name ?? '—' })))
    },
  },

  /**
   * WhatsApp Business integration. Mock: Meta isn't called — connection checks, template approval and
   * delivery are simulated so the screens can be tried. The real server calls the WhatsApp Cloud API.
   */
  whatsapp: {
    async status() {
      const d = getDB()
      const b = biz(d)
      const on = featureOn(d.platform.features, 'whatsapp', b.id)
      const st = on ? waState(b) : { state: 'off' as const, step: 0, ready: { offer: false, bill: false } }
      return clone({ feature: on, ...st, config: on && b.whatsapp ? { ...b.whatsapp, templates: liveTemplates(b.whatsapp) } : null })
    },
    async enable() {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        b.whatsapp ??= { enabled: true, provider: 'meta_cloud', businessNumber: '', wabaId: '', phoneNumberId: '', tokenLast4: '', verified: null, templates: {}, autoSendBill: false, finishedAt: null, updatedAt: nowIso() }
        b.whatsapp.enabled = true
        audit(d, 'whatsapp', b.id, 'enable')
      })
    },
    async connect(input: { businessNumber: string; wabaId: string; phoneNumberId: string; token?: string }) {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        const w = waConfig(b)
        const businessNumber = cleanPhone(input.businessNumber, b.defaultCountry, { required: 'Enter your WhatsApp Business number' })
        const wabaId = input.wabaId.trim(), phoneNumberId = input.phoneNumberId.trim()
        if (!/^\d{10,20}$/.test(wabaId)) throw new ApiError('WhatsApp Business Account ID is a 10–20 digit number (Meta Business Suite → WhatsApp accounts)')
        if (!/^\d{10,20}$/.test(phoneNumberId)) throw new ApiError('Phone number ID is a 10–20 digit number (WhatsApp Manager → API setup)')
        const token = (input.token ?? '').trim()
        const hasToken = d.secrets.some((x) => x.businessId === b.id && x.kind === 'whatsapp_token')
        if (!token && !hasToken) throw new ApiError('Paste the permanent access token')
        if (token && (token.length < 30 || /\s/.test(token))) throw new ApiError('That doesn’t look like an access token — copy the whole token without spaces')
        if (token) {
          d.secrets = d.secrets.filter((x) => !(x.businessId === b.id && x.kind === 'whatsapp_token'))
          d.secrets.push({ businessId: b.id, kind: 'whatsapp_token', value: token })
        }
        const changed = w.businessNumber !== businessNumber || w.wabaId !== wabaId || w.phoneNumberId !== phoneNumberId || !!token
        Object.assign(w, { businessNumber, wabaId, phoneNumberId, tokenLast4: token ? token.slice(-4) : w.tokenLast4, updatedAt: nowIso() })
        if (changed) { w.verified = null; w.finishedAt = null }
        audit(d, 'whatsapp', b.id, 'connect', formatNumberForLog(businessNumber))
      })
    },
    /** Mock of GET /{phone-number-id}: Meta returns the verified business name, number and quality. */
    async test() {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        const w = waConfig(b)
        if (!w.phoneNumberId || !d.secrets.some((x) => x.businessId === b.id && x.kind === 'whatsapp_token')) throw new ApiError('Connect your account first')
        w.verified = { name: b.name, number: w.businessNumber, quality: 'High', at: nowIso() }
        audit(d, 'whatsapp', b.id, 'test', 'Connection OK')
        return clone(w.verified)
      })
    },
    async sendTest() {
      return tx((d) => {
        const s = requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        const w = waConfig(b)
        if (!w.verified) throw new ApiError('Test the connection first')
        const owner = d.users.find((u) => u.id === s.userId)
        const to = owner?.phone
        if (!to) throw new ApiError('Add your mobile number to your profile first')
        return clone(logWa(d, b, s.userId, { kind: 'test', to, customerName: owner!.name, customerId: null, refId: null, body: `Test message from ${b.name} on BillPoodum. Your WhatsApp integration works.`, attachment: null }))
      })
    },
    /** Save a template as a draft, or submit it to Meta for approval. */
    async saveTemplate(kind: WaTemplateKind, input: { language: WaLang; body: string; attach: boolean }, submit: boolean) {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        const w = waConfig(b)
        if (!w.verified) throw new ApiError('Connect and test your account first')
        if (!WA_KIND[kind]) throw new ApiError('Unknown template')
        if (!['en', 'ta'].includes(input.language)) throw new ApiError('Choose a language')
        const body = input.body.trim()
        if (submit) { const errs = templateErrors(kind, body); if (errs.length) throw new ApiError(`Fix the template first: ${errs.join(' · ')}`) }
        const t: WaTemplate = { kind, language: input.language, body, attach: !!input.attach, status: submit ? 'pending' : 'draft', submittedAt: submit ? nowIso() : null, updatedAt: nowIso() }
        w.templates = { ...w.templates, [kind]: t }
        audit(d, 'whatsapp', b.id, submit ? 'template_submit' : 'template_save', WA_KIND[kind].name)
        return clone(t)
      })
    },
    async finishSetup() {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        const w = waConfig(b)
        if (!w.verified) throw new ApiError('Connect and test your account first')
        if (!Object.values(w.templates).some((t) => t && t.status !== 'draft')) throw new ApiError('Submit at least one template')
        w.finishedAt = nowIso()
      })
    },
    async setAutoSendBill(on: boolean) {
      return tx((d) => { requirePerm(d, 'settings.manage'); waConfig(waBiz(d)).autoSendBill = on })
    },
    async disconnect() {
      return tx((d) => {
        requirePerm(d, 'settings.manage')
        const b = waBiz(d)
        delete b.whatsapp
        d.secrets = d.secrets.filter((x) => !(x.businessId === b.id && x.kind === 'whatsapp_token'))
        audit(d, 'whatsapp', b.id, 'disconnect')
      })
    },
    async sendBill(orderId: string) {
      return tx((d) => {
        const s = requirePerm(d, 'billing.create')
        const b = waBiz(d)
        const st = waState(b)
        if (!st.ready.bill) throw new ApiError('WhatsApp bill messages aren’t set up yet (Settings → Integrations)')
        const o = mine(d.orders).find((x) => x.id === orderId)
        if (!o || !o.invoiceNumber) throw new ApiError('Bill not found')
        const c = o.customerId ? mine(d.customers).find((x) => x.id === o.customerId) : null
        const to = c?.phone || o.guest?.phone || ''
        if (!to) throw new ApiError('This bill has no customer mobile number')
        const t = liveTemplates(b.whatsapp!).bill!
        const values = { customer_name: (c?.name || o.guest?.name || 'Customer').split(' ')[0], shop_name: b.name, bill_no: o.invoiceNumber, amount: `${b.currencySymbol}${o.total.toFixed(2)}`, date: new Date(o.billedAt ?? o.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) }
        return clone(logWa(d, b, s.userId, { kind: 'bill', to, customerName: c?.name || o.guest?.name || '', customerId: c?.id ?? null, refId: o.id, body: renderTemplate(t.body, values), attachment: t.attach ? `${o.invoiceNumber}.pdf` : null }))
      })
    },
    /** Send today's offer to many customers at once (only those who agreed to offers and have a valid mobile). */
    async sendOffer(input: { details: string; customerIds: string[]; productIds: string[]; poster: boolean }) {
      return tx((d) => {
        const s = requirePerm(d, 'customers.manage')
        const b = waBiz(d)
        if (!waState(b).ready.offer) throw new ApiError('WhatsApp offer messages aren’t set up yet (Settings → Integrations)')
        const details = input.details.replace(/\s*\n+\s*/g, ' · ').trim()
        if (details.length < 3) throw new ApiError('Write the offer details')
        if (details.length > 300) throw new ApiError('Offer details: up to 300 characters')
        const t = liveTemplates(b.whatsapp!).offer!
        const today = dateKey()
        const already = new Set(mine(d.waMessages).filter((m) => m.kind === 'offer' && m.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).map((m) => m.customerId))
        let sent = 0, skipped = 0
        const camp: Campaign = { id: uid('cmp_'), businessId: s.businessId, date: today, channel: 'whatsapp', message: details, productIds: input.productIds, sends: [], createdAt: nowIso(), createdBy: s.userId }
        for (const id of [...new Set(input.customerIds)]) {
          const c = mine(d.customers).find((x) => x.id === id)
          if (!c || !c.phone || c.marketingOptIn === false || already.has(c.id)) { skipped++; continue }
          logWa(d, b, s.userId, { kind: 'offer', to: c.phone, customerName: c.name, customerId: c.id, refId: camp.id, body: renderTemplate(t.body, { customer_name: c.name.split(' ')[0], shop_name: b.name, offer_details: details }), attachment: t.attach && input.poster ? 'offer-poster.png' : null })
          camp.sends.push({ customerId: c.id, at: nowIso(), by: s.userId })
          sent++
        }
        if (!sent) throw new ApiError('No one to send to — everyone selected was skipped (no mobile, didn’t agree to offers, or already sent today)')
        d.campaigns.push(camp)
        audit(d, 'campaign', camp.id, 'whatsapp_send', `${sent} sent · ${skipped} skipped`)
        return { sent, skipped }
      })
    },
    async messages(limit = 200) {
      const d = getDB()
      return clone(mine(d.waMessages).slice(-limit).reverse().map(liveMessage))
    },
  },

  /** Product admin (platform owner). Separate login; never sees or uses a customer session. */
  admin: {
    async login(username: string, password: string) {
      const d = getDB()
      const a = d.admins.find((x) => x.username === username.trim().toLowerCase() && x.active)
      if (!a || a.password !== password) throw new ApiError('Wrong admin username or password')
      dbTx((db) => { const x = db.admins.find((y) => y.id === a.id); if (x) x.lastLoginAt = nowIso() })
      adminSession.set({ adminId: a.id })
      return adminView(a)
    },
    async logout() { adminSession.set(null) },
    async me() {
      const s = adminSession.get()
      const a = s && getDB().admins.find((x) => x.id === s.adminId && x.active)
      if (!a) { if (s) adminSession.set(null); return null }
      return adminView(a)
    },

    async customers() {
      const d = getDB(); requireAdmin(d, 'customers.view')
      return clone(d.businesses.map((b) => customerRow(d, b)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    },
    async customer(id: string) {
      const d = getDB(); requireAdmin(d, 'customers.view')
      const b = d.businesses.find((x) => x.id === id)
      if (!b) throw new ApiError('Customer not found')
      const orders = d.orders.filter((o) => o.businessId === id)
      return clone({
        ...customerRow(d, b),
        address: b.address, gstin: b.gstin, adminNote: b.adminNote ?? '',
        branches: d.branches.filter((x) => x.businessId === id).map((x) => ({ id: x.id, name: x.name, active: x.active !== false, isDefault: x.isDefault, bills: orders.filter((o) => o.branchId === x.id && o.status === 'completed').length })),
        usage: {
          staff: d.users.filter((u) => u.businessId === id && u.active).length,
          products: d.products.filter((p) => p.businessId === id).length,
          customers: d.customers.filter((c) => c.businessId === id).length,
          bills: orders.filter((o) => o.status === 'completed').length,
        },
        periods: d.subscriptionPeriods.filter((p) => p.businessId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        history: d.adminAudit.filter((a) => a.businessId === id).slice().reverse(),
        features: featuresFor(d.platform.features, id),
        whatsappState: waState(b).state,
      })
    },

    async createCustomer(input: {
      businessName: string; ownerName: string; username: string; password: string; phone: string; email?: string
      validity: Validity; maxBranches: number; note?: string
    }) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.create')
        const businessName = input.businessName.trim(), ownerName = input.ownerName.trim()
        if (!businessName) throw new ApiError('Enter the business name')
        if (!ownerName) throw new ApiError('Enter the owner’s name')
        const username = checkUsername(d, input.username)
        checkPassword(input.password)
        const maxBranches = checkBranches(input.maxBranches)
        const phone = cleanPhone(input.phone, 'IN', { required: 'Enter the owner’s mobile number — it is their login ID' })
        if (d.users.some((u) => u.phone === phone)) throw new ApiError('This mobile number is already used by another account')
        const email = (input.email ?? '').trim().toLowerCase()
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Enter a valid email')
        const t = nowIso()
        const { startAt, endAt, months } = periodFor(input.validity, new Date())
        const businessId = uid('biz_'), branchId = uid('br_'), userId = uid('usr_')
        const b = newBusiness({ id: businessId, name: businessName, category: 'food', subType: 'Fast Food', phone, createdAt: t })
        Object.assign(b, { onboarded: false, email, status: 'active', maxBranches, subscription: { startAt, endAt }, adminNote: input.note?.trim() ?? '' })
        d.businesses.push(b)
        d.branches.push({ id: branchId, businessId, name: 'Main', address: '', isDefault: true, active: true })
        const roles = defaultRoles(businessId)
        d.roles.push(...roles)
        d.users.push({ id: userId, businessId, branchId, name: ownerName, phone, email, username, password: input.password, roleId: roles[0].id, active: true, createdAt: t, createdBy: a.id, updatedAt: t, updatedBy: a.id })
        addPeriod(d, a.id, b, 'new', startAt, endAt, months, input.note ?? '')
        adminLog(d, a, 'create', b, `Username ${username} · ${maxBranches} branch${maxBranches === 1 ? '' : 'es'} · valid till ${fmtDay(endAt)}`)
        return { id: businessId, username }
      })
    },
    async updateCustomer(id: string, patch: { businessName?: string; ownerName?: string; username?: string; phone?: string; email?: string; adminNote?: string }) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.edit')
        const b = findBiz(d, id)
        const owner = ownerOf(d, b)
        const changed: string[] = []
        if (patch.businessName !== undefined && patch.businessName.trim() !== b.name) { if (!patch.businessName.trim()) throw new ApiError('Enter the business name'); b.name = patch.businessName.trim(); changed.push('business name') }
        if (owner) {
          if (patch.ownerName !== undefined && patch.ownerName.trim() && patch.ownerName.trim() !== owner.name) { owner.name = patch.ownerName.trim(); changed.push('owner name') }
          if (patch.username !== undefined && patch.username.trim().toLowerCase() !== owner.username) { owner.username = checkUsername(d, patch.username, owner.id); changed.push(`username → ${owner.username}`) }
          if (patch.phone !== undefined) {
            const phone = cleanPhone(patch.phone, b.defaultCountry, { required: 'The owner’s mobile number is their login ID and can’t be empty' })
            if (phone !== owner.phone) {
              if (phone && d.users.some((u) => u.id !== owner.id && u.phone === phone)) throw new ApiError('This mobile number is already used by another account')
              owner.phone = phone; changed.push('mobile')
            }
          }
          if (patch.email !== undefined && patch.email.trim().toLowerCase() !== owner.email) { owner.email = patch.email.trim().toLowerCase(); changed.push('email') }
          touch(owner, a.id)
        }
        if (patch.adminNote !== undefined && patch.adminNote !== (b.adminNote ?? '')) { b.adminNote = patch.adminNote; changed.push('note') }
        if (changed.length) adminLog(d, a, 'update', b, changed.join(', '))
        return clone(b)
      })
    },
    async resetPassword(id: string, password: string) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.password')
        const b = findBiz(d, id)
        const owner = ownerOf(d, b)
        if (!owner) throw new ApiError('This customer has no owner login')
        checkPassword(password)
        owner.password = password
        touch(owner, a.id)
        adminLog(d, a, 'password', b, `Password reset for ${owner.username ?? owner.name}`)
      })
    },
    /** Renew or extend. Months are added to the current end date while it's still valid, otherwise from today. */
    async renew(id: string, validity: Validity, note = '') {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.renew')
        const b = findBiz(d, id)
        const st = subscriptionState(b)
        const from = st.readOnly || !b.subscription ? new Date() : new Date(new Date(b.subscription.endAt).getTime() + 1)
        const p = periodFor(validity, from)
        if (new Date(p.endAt) <= new Date()) throw new ApiError('Choose an end date in the future')
        const kind = st.readOnly ? 'renew' : 'extend'
        const startAt = st.readOnly || !b.subscription ? p.startAt : b.subscription.startAt
        addPeriod(d, a.id, b, kind, p.startAt, p.endAt, p.months, note)
        b.subscription = { startAt, endAt: p.endAt }
        adminLog(d, a, 'renew', b, `${kind === 'renew' ? 'Renewed' : 'Extended'}${p.months ? ` by ${p.months} month${p.months === 1 ? '' : 's'}` : ''} · valid till ${fmtDay(p.endAt)}${note ? ` · ${note}` : ''}`)
        return clone(b.subscription)
      })
    },
    async setBranchLimit(id: string, max: number) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.branches')
        const b = findBiz(d, id)
        const n = checkBranches(max)
        const used = d.branches.filter((x) => x.businessId === id).length
        if (n < used) throw new ApiError(`This customer already has ${used} branches. The limit can’t be lower than that.`)
        const before = b.maxBranches ?? 1
        if (n === before) return n
        b.maxBranches = n
        adminLog(d, a, 'branch_limit', b, `Branch limit ${before} → ${n} (${d.platform.pricePerBranchMonth * n}/month from next renewal)`)
        return n
      })
    },
    async setStatus(id: string, status: 'active' | 'deactivated', reason = '') {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.status')
        const b = findBiz(d, id)
        if ((b.status ?? 'active') === status) return
        b.status = status
        adminLog(d, a, status === 'active' ? 'activate' : 'deactivate', b, reason || (status === 'active' ? 'Account activated' : 'Account deactivated'))
      })
    },
    /** Permanently removes the customer and every row that belongs to it. Needs the exact business name. */
    async deleteCustomer(id: string, confirmName: string) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.delete')
        const b = findBiz(d, id)
        if (confirmName.trim() !== b.name) throw new ApiError('Type the business name exactly to confirm')
        const counts: string[] = []
        const tables = ['branches', 'roles', 'users', 'categories', 'products', 'customers', 'orders', 'payments', 'kots', 'tables', 'expenses', 'stockMovements', 'batches', 'specials', 'campaigns', 'auditLogs', 'subscriptionPeriods', 'waMessages', 'secrets'] as const
        for (const t of tables) {
          const rows = d[t] as { businessId: string }[]
          const keep = rows.filter((r) => r.businessId !== id)
          if (rows.length !== keep.length) counts.push(`${rows.length - keep.length} ${t}`)
          ;(d[t] as unknown) = keep
        }
        d.businesses = d.businesses.filter((x) => x.id !== id)
        adminLog(d, a, 'delete', b, `Deleted permanently: ${counts.join(', ') || 'no data'}`)
      })
    },

    // ---- Renewal reminders ----
    async renewals() {
      const d = getDB(); requireAdmin(d, 'customers.view')
      const cfg = reminderSettings(d)
      const rows = d.businesses.map((b) => {
        const st = subscriptionState(b)
        const logs = d.reminderLog.filter((l) => l.businessId === b.id)
        const owner = ownerOf(d, b)
        const days = st.endAt ? Math.ceil((new Date(st.endAt).getTime() - Date.now()) / 86_400_000) : null
        return {
          id: b.id, name: b.name, state: st.state, endAt: st.endAt, daysLeft: days, paused: !!b.remindersPaused, ownerName: owner?.name ?? '', phone: owner?.phone ?? '',
          monthly: (b.maxBranches ?? 1) * d.platform.pricePerBranchMonth,
          sentThisCycle: logs.filter((l) => st.endAt && l.createdAt > new Date(new Date(st.endAt).getTime() - (cfg.daysBefore + 1) * 86_400_000).toISOString()).length,
          lastSent: logs.reduce((m, l) => (l.createdAt > m ? l.createdAt : m), '') || null,
          dueToday: candidatesForReminder(d, 'auto').some((c) => c.id === b.id),
        }
      })
      return clone({
        settings: cfg,
        expiring: rows.filter((r) => r.state !== 'deactivated' && r.daysLeft !== null && r.daysLeft > 0 && r.daysLeft <= Math.max(cfg.daysBefore, 14)).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
        expired: rows.filter((r) => r.state === 'expired' && r.daysLeft !== null && r.daysLeft > -30).sort((a, b) => (b.daysLeft ?? 0) - (a.daysLeft ?? 0)),
        log: d.reminderLog.slice(-200).reverse(),
        whatsapp: { ready: remindersReady(d), connected: !!platformWa(d)?.verified, templateStatus: platformWa(d)?.template?.status ?? null, preview: fillReminder(d, cfg.template, null) },
      })
    },
    async runReminders() {
      return dbTx((d) => { requireAdmin(d, 'customers.renew'); return sendReminders(d, { trigger: 'auto' }) })
    },
    async sendReminder(businessId: string) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.renew')
        findBiz(d, businessId)
        const n = sendReminders(d, { trigger: 'manual', businessId, adminName: a.name })
        if (!n) throw new ApiError('Not sent — the owner has no valid mobile number')
        return n
      })
    },
    async pauseReminders(businessId: string, paused: boolean) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.renew')
        const b = findBiz(d, businessId)
        b.remindersPaused = paused
        adminLog(d, a, 'reminder', b, paused ? 'Renewal reminders paused' : 'Renewal reminders resumed')
      })
    },
    async updateReminderSettings(patch: Partial<ReminderSettings>) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        const next = { ...reminderSettings(d), ...patch }
        if (!(next.daysBefore >= 1 && next.daysBefore <= 30)) throw new ApiError('Start between 1 and 30 days before')
        d.platform.reminders = next
        adminLog(d, a, 'settings', null, `Renewal reminders: ${next.enabled ? `on, from ${next.daysBefore} days before` : 'off'}`)
        return clone(next)
      })
    },

    // ---- Platform WhatsApp (sends renewal reminders from BillPoodum's own number) ----
    async waStatus() {
      const d = getDB(); requireAdmin(d, 'customers.view')
      const w = platformWa(d)
      const cfg = reminderSettings(d)
      const step = !w?.phoneNumberId ? 1 : !w.verified ? 2 : !w.template || w.template.status === 'draft' ? 3 : 4
      return clone({ config: w, step, ready: remindersReady(d), template: cfg.template, daysBefore: cfg.daysBefore, preview: fillReminder(d, cfg.template, null), sent7: d.reminderLog.filter((l) => l.status === 'sent' && Date.now() - new Date(l.createdAt).getTime() < 7 * 86_400_000).length, log: d.reminderLog.slice(-50).reverse() })
    },
    async waConnect(input: { businessNumber: string; wabaId: string; phoneNumberId: string; token?: string }) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        const businessNumber = cleanPhone(input.businessNumber, 'IN', { required: 'Enter the WhatsApp Business number' })
        const wabaId = input.wabaId.trim(), phoneNumberId = input.phoneNumberId.trim()
        if (!/^\d{10,20}$/.test(wabaId)) throw new ApiError('WhatsApp Business Account ID is a 10–20 digit number (Meta Business Suite → WhatsApp accounts)')
        if (!/^\d{10,20}$/.test(phoneNumberId)) throw new ApiError('Phone number ID is a 10–20 digit number (WhatsApp Manager → API setup)')
        const token = (input.token ?? '').trim()
        const hasToken = d.secrets.some((x) => x.businessId === PLATFORM && x.kind === 'whatsapp_token')
        if (!token && !hasToken) throw new ApiError('Paste the permanent access token')
        if (token && (token.length < 30 || /\s/.test(token))) throw new ApiError('That doesn’t look like an access token — copy the whole token without spaces')
        if (token) {
          d.secrets = d.secrets.filter((x) => !(x.businessId === PLATFORM && x.kind === 'whatsapp_token'))
          d.secrets.push({ businessId: PLATFORM, kind: 'whatsapp_token', value: token })
        }
        const w = d.platform.whatsapp ?? { businessNumber: '', wabaId: '', phoneNumberId: '', tokenLast4: '', verified: null, template: null, updatedAt: nowIso() }
        const changed = w.businessNumber !== businessNumber || w.wabaId !== wabaId || w.phoneNumberId !== phoneNumberId || !!token
        Object.assign(w, { businessNumber, wabaId, phoneNumberId, tokenLast4: token ? token.slice(-4) : w.tokenLast4, updatedAt: nowIso() })
        if (changed) w.verified = null
        d.platform.whatsapp = w
        adminLog(d, a, 'settings', null, `WhatsApp account saved (${formatNumberForLog(businessNumber)})`)
      })
    },
    /** Mock of GET /{phone-number-id}. */
    async waTest() {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        const w = d.platform.whatsapp
        if (!w?.phoneNumberId || !d.secrets.some((x) => x.businessId === PLATFORM && x.kind === 'whatsapp_token')) throw new ApiError('Connect the account first')
        w.verified = { name: 'BillPoodum', number: w.businessNumber, quality: 'High', at: nowIso() }
        adminLog(d, a, 'settings', null, 'WhatsApp connection tested — OK')
        return clone(w.verified)
      })
    },
    async waSendTest(to: string) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        if (!d.platform.whatsapp?.verified) throw new ApiError('Test the connection first')
        const num = cleanPhone(to, 'IN', { required: 'Enter a mobile number' })
        adminLog(d, a, 'settings', null, `WhatsApp test message sent to ${formatNumberForLog(num)}`)
        return num
      })
    },
    /** Save the renewal reminder template as a draft, or submit it to Meta for approval. */
    async waSaveTemplate(input: { language: 'en' | 'ta'; body: string }, submit: boolean) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        const w = d.platform.whatsapp
        if (!w?.verified) throw new ApiError('Connect and test the account first')
        const body = input.body.trim()
        const errs = reminderTemplateErrors(body)
        if (submit && errs.length) throw new ApiError(`Fix the template first: ${errs.join(' · ')}`)
        if (!body) throw new ApiError('Write the message')
        d.platform.reminders = { ...reminderSettings(d), template: body }
        w.template = { language: input.language, status: submit ? 'pending' : 'draft', submittedAt: submit ? nowIso() : null }
        adminLog(d, a, 'settings', null, submit ? 'Renewal reminder template sent to Meta for approval' : 'Renewal reminder template saved as draft')
      })
    },
    async waDisconnect() {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        delete d.platform.whatsapp
        d.secrets = d.secrets.filter((x) => x.businessId !== PLATFORM)
        adminLog(d, a, 'settings', null, 'WhatsApp disconnected — renewal reminders stopped')
      })
    },

    // ---- Support tickets ----
    async tickets() {
      const d = getDB(); requireAdmin(d, 'customers.view')
      return clone(d.tickets.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, images: m.images.length ? [m.images[0]] : [] })), imageCount: t.messages.reduce((a, m) => a + m.images.length, 0) })))
    },
    async ticket(id: string) {
      const d = getDB(); requireAdmin(d, 'customers.view')
      const t = d.tickets.find((x) => x.id === id)
      if (!t) throw new ApiError('Ticket not found')
      // Only write when it changes — every write refreshes the screens that read tickets.
      if (t.unreadForAdmin) dbTx((db) => { const x = db.tickets.find((y) => y.id === id); if (x) x.unreadForAdmin = false })
      const b = d.businesses.find((x) => x.id === t.businessId)
      return clone({ ...t, unreadForAdmin: false, business: b ? { state: subscriptionState(b).state, subType: b.subType } : null, admins: d.admins.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name })) })
    },
    async replyTicket(id: string, text: string, images: string[] = [], status?: TicketStatus) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.view')
        const t = d.tickets.find((x) => x.id === id)
        if (!t) throw new ApiError('Ticket not found')
        if (!text.trim() && !images.length) throw new ApiError('Write a reply')
        t.messages.push({ id: uid('tm_'), from: 'admin', authorId: a.id, authorName: a.name, text: text.trim().slice(0, 4000), images, at: nowIso() })
        t.status = status ?? (t.status === 'open' ? 'waiting' : t.status)
        t.assignedTo ??= a.id
        t.updatedAt = nowIso(); t.unreadForCustomer = true; t.unreadForAdmin = false
      })
    },
    async updateTicket(id: string, patch: { status?: TicketStatus; priority?: TicketPriority; assignedTo?: string | null }) {
      return dbTx((d) => {
        requireAdmin(d, 'customers.view')
        const t = d.tickets.find((x) => x.id === id)
        if (!t) throw new ApiError('Ticket not found')
        Object.assign(t, patch)
        t.updatedAt = nowIso()
      })
    },
    async uploadScreenshot(file: Blob) {
      requireAdmin(getDB(), 'customers.view')
      try { return (await compressImage(file, { maxBytes: 200 * 1024, maxSide: 1600 })).url } catch (e) { throw new ApiError((e as Error).message) }
    },

    // ---- Data export ----
    async exportCustomer(id: string) {
      const d = getDB(); const a = requireAdmin(d, 'customers.edit')
      const b = findBiz(d, id)
      const out = exportTables(d, id, true)
      dbTx((db) => adminLog(db, a, 'export', b, `Exported ${out.tables.reduce((n, t) => n + t.rows.length, 0)} rows, ${out.images.length} photos`))
      return clone(out)
    },

    // ---- Feature releases ----
    async features() {
      const d = getDB(); requireAdmin(d, 'customers.view')
      return clone(Object.entries(FEATURES).map(([key, f]) => ({ key: key as FeatureKey, ...f, flag: d.platform.features?.[key as FeatureKey] ?? { mode: 'off' as const, businessIds: [] } })))
    },
    async setFeature(key: FeatureKey, flag: FeatureFlag) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'features.manage')
        if (!FEATURES[key]) throw new ApiError('Unknown feature')
        if (!['off', 'selected', 'all'].includes(flag.mode)) throw new ApiError('Choose who gets it')
        const ids = [...new Set(flag.businessIds)].filter((id) => d.businesses.some((b) => b.id === id))
        const before = d.platform.features?.[key] ?? { mode: 'off', businessIds: [] }
        d.platform.features = { ...d.platform.features, [key]: { mode: flag.mode, businessIds: ids } }
        const who = flag.mode === 'all' ? 'all customers' : flag.mode === 'off' ? 'off' : `${ids.length} selected customer${ids.length === 1 ? '' : 's'}`
        const added = ids.filter((x) => !before.businessIds.includes(x)).map((x) => d.businesses.find((b) => b.id === x)?.name).filter(Boolean)
        const removed = before.businessIds.filter((x) => !ids.includes(x)).map((x) => d.businesses.find((b) => b.id === x)?.name).filter(Boolean)
        adminLog(d, a, 'feature', null, `${FEATURES[key].name}: ${who}${added.length ? ` · added ${added.join(', ')}` : ''}${removed.length ? ` · removed ${removed.join(', ')}` : ''}`)
      })
    },
    /** Turn a feature on / off for one customer (switches the flag to "selected" when needed). */
    async setCustomerFeature(businessId: string, key: FeatureKey, on: boolean) {
      const d = getDB(); requireAdmin(d, 'features.manage')
      const f = d.platform.features?.[key] ?? { mode: 'off' as const, businessIds: [] }
      if (f.mode === 'all' && !on) {
        // Everyone except this customer.
        return api.admin.setFeature(key, { mode: 'selected', businessIds: d.businesses.map((b) => b.id).filter((x) => x !== businessId) })
      }
      if (f.mode === 'all') return
      const ids = on ? [...f.businessIds, businessId] : f.businessIds.filter((x) => x !== businessId)
      return api.admin.setFeature(key, { mode: ids.length ? 'selected' : 'off', businessIds: ids })
    },

    // ---- Admin team ----
    async team() {
      const d = getDB(); requireAdmin(d, 'team.manage')
      return clone(d.admins.map((a) => ({ ...adminView(a), active: a.active, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt ?? null })))
    },
    async saveAdmin(input: { id?: string; name: string; username: string; role: AdminRole; password?: string }) {
      return dbTx((d) => {
        const me = requireAdmin(d, 'team.manage')
        const name = input.name.trim()
        if (!name) throw new ApiError('Enter the admin’s name')
        if (!ADMIN_ROLES[input.role]) throw new ApiError('Choose a role')
        const username = input.username.trim().toLowerCase()
        if (!/^[a-z0-9._-]{4,30}$/.test(username)) throw new ApiError('Username: 4–30 letters, numbers, dot, dash or underscore (no spaces)')
        if (d.admins.some((x) => x.username === username && x.id !== input.id) || d.users.some((u) => u.username === username)) throw new ApiError(`Username ${username} is already taken`)
        const ex = input.id ? d.admins.find((x) => x.id === input.id) : null
        if (ex) {
          if (ex.role === 'super' && input.role !== 'super' && activeSupers(d) <= 1 && ex.active) throw new ApiError('Keep at least one active super admin')
          if (ex.id === me.id && input.role !== ex.role) throw new ApiError('You can’t change your own role')
          const changes = [ex.name !== name && 'name', ex.username !== username && `username → ${username}`, ex.role !== input.role && `role ${ADMIN_ROLES[ex.role].name} → ${ADMIN_ROLES[input.role].name}`].filter(Boolean)
          Object.assign(ex, { name, username, role: input.role })
          if (input.password) { checkPassword(input.password); ex.password = input.password; changes.push('password reset') }
          if (changes.length) adminLog(d, me, 'admin_update', null, `${name}: ${changes.join(', ')}`)
          return adminView(ex)
        }
        checkPassword(input.password ?? '')
        const a: PlatformAdmin = { id: uid('adm_'), name, username, password: input.password!, role: input.role, active: true, createdAt: nowIso(), lastLoginAt: null }
        d.admins.push(a)
        adminLog(d, me, 'admin_create', null, `${name} (${username}) added as ${ADMIN_ROLES[a.role].name}`)
        return adminView(a)
      })
    },
    async setAdminActive(id: string, active: boolean) {
      return dbTx((d) => {
        const me = requireAdmin(d, 'team.manage')
        const a = d.admins.find((x) => x.id === id)
        if (!a) throw new ApiError('Admin not found')
        if (a.id === me.id && !active) throw new ApiError('You can’t deactivate yourself')
        if (!active && a.role === 'super' && activeSupers(d) <= 1) throw new ApiError('Keep at least one active super admin')
        if (a.active === active) return
        a.active = active
        adminLog(d, me, 'admin_update', null, `${a.name}: ${active ? 'activated' : 'deactivated'}`)
      })
    },

    // ---- Support view ----
    /** Opens the customer's app in this browser, strictly read-only, as their owner. Logged with the reason. */
    async startSupport(businessId: string, reason: string) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'customers.support')
        const b = findBiz(d, businessId)
        if (reason.trim().length < 4) throw new ApiError('Write why you are opening this account (e.g. the customer’s complaint)')
        const owner = ownerOf(d, b)
        if (!owner) throw new ApiError('This customer has no owner login yet')
        const main = d.branches.find((x) => x.businessId === b.id && x.isDefault) ?? d.branches.find((x) => x.businessId === b.id)
        session.set({ userId: owner.id, businessId: b.id, branchId: main?.id ?? owner.branchId, support: { adminId: a.id, adminName: a.name, reason: reason.trim(), startedAt: nowIso() } })
        adminLog(d, a, 'support_start', b, `Support view opened: ${reason.trim()}`)
        return { onboarded: b.onboarded }
      })
    },
    async endSupport() {
      const s = session.get()
      if (!s?.support) return null
      dbTx((d) => {
        const a = d.admins.find((x) => x.id === s.support!.adminId)
        const b = d.businesses.find((x) => x.id === s.businessId)
        const mins = Math.max(1, Math.round((Date.now() - new Date(s.support!.startedAt).getTime()) / 60000))
        if (a) adminLog(d, a, 'support_end', b ?? null, `Support view closed after ${mins} min`)
      })
      session.set(null)
      return s.businessId
    },

    // ---- Usage report ----
    async usage() {
      const d = getDB(); requireAdmin(d, 'reports.view')
      const now = Date.now(), DAY = 86_400_000
      const rows = d.businesses.map((b) => {
        const orders = d.orders.filter((o) => o.businessId === b.id && o.status === 'completed')
        const at = (o: Order) => new Date(o.billedAt ?? o.createdAt).getTime()
        const lastBill = orders.reduce((m, o) => Math.max(m, at(o)), 0)
        const lastLogin = d.users.filter((u) => u.businessId === b.id).reduce((m, u) => (u.lastLoginAt && u.lastLoginAt > m ? u.lastLoginAt : m), '')
        const st = subscriptionState(b)
        return {
          id: b.id, name: b.name || '(setup not finished)', subType: b.subType, state: st.state,
          bills7: orders.filter((o) => now - at(o) <= 7 * DAY).length,
          bills30: orders.filter((o) => now - at(o) <= 30 * DAY).length,
          sales30: r2(orders.filter((o) => now - at(o) <= 30 * DAY).reduce((a, o) => a + o.total, 0)),
          lastBillAt: lastBill ? new Date(lastBill).toISOString() : null,
          lastLoginAt: lastLogin || null,
          branches: d.branches.filter((x) => x.businessId === b.id).length,
          monthlyPrice: (b.maxBranches ?? 1) * d.platform.pricePerBranchMonth,
        }
      })
      // Subscription money by the month it was recorded, last 12 months.
      const months: { key: string; label: string; amount: number; customers: number }[] = []
      const base = new Date(); base.setDate(1); base.setHours(0, 0, 0, 0)
      for (let i = 11; i >= 0; i--) {
        const m = new Date(base); m.setMonth(m.getMonth() - i)
        months.push({ key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, label: m.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }), amount: 0, customers: 0 })
      }
      for (const p of d.subscriptionPeriods) {
        const k = p.createdAt.slice(0, 7)
        const m = months.find((x) => x.key === k)
        if (m) m.amount += p.amount
      }
      for (const b of d.businesses) { const m = months.find((x) => x.key === b.createdAt.slice(0, 7)); if (m) m.customers++ }
      const live = rows.filter((r) => r.state !== 'deactivated' && r.state !== 'expired')
      return clone({
        rows,
        months,
        summary: {
          customers: rows.length,
          billing7: rows.filter((r) => r.bills7 > 0).length,
          inactive14: rows.filter((r) => !r.lastBillAt || now - new Date(r.lastBillAt).getTime() > 14 * DAY).length,
          logins7: rows.filter((r) => r.lastLoginAt && now - new Date(r.lastLoginAt).getTime() <= 7 * DAY).length,
          mrr: live.reduce((a, r) => a + r.monthlyPrice, 0),
          thisMonth: months[months.length - 1].amount,
          last12: months.reduce((a, m) => a + m.amount, 0),
        },
      })
    },

    async settings() { const d = getDB(); requireAdmin(d, 'customers.view'); return clone(d.platform) },
    async updateSettings(patch: { pricePerBranchMonth: number }) {
      return dbTx((d) => {
        const a = requireAdmin(d, 'pricing.manage')
        if (!(patch.pricePerBranchMonth >= 0)) throw new ApiError('Enter a valid price')
        const before = d.platform.pricePerBranchMonth
        d.platform.pricePerBranchMonth = Math.round(patch.pricePerBranchMonth)
        adminLog(d, a, 'settings', null, `Price per branch / month ${before} → ${d.platform.pricePerBranchMonth}`)
        return clone(d.platform)
      })
    },
    async audit(limit = 200) {
      const d = getDB(); requireAdmin(d, 'customers.view')
      return clone(d.adminAudit.slice(-limit).reverse())
    },
  },

  dev: {
    async reset() { resetDB() },
    /** Mock only, for trying read-only mode: set a customer's period directly (e.g. into the past). */
    async setSubscription(businessId: string, sub: { startAt: string; endAt: string }, removePeriodId?: string) {
      return dbTx((d) => {
        findBiz(d, businessId).subscription = sub
        if (removePeriodId) d.subscriptionPeriods = d.subscriptionPeriods.filter((p) => p.id !== removePeriodId)
      })
    },
  },
}

export type Api = typeof api
export type { Payment, StockMovement }
export { ApiError }
