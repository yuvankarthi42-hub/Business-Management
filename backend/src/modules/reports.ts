// Reports (dashboard summary, branch overview, receivables) and the audit log. Same numbers as the app's mock.
//
// The Data Store free tier counts every row read, so a report reads each table once for the whole
// range (and all branches in view) and works the figures out in memory.
import { r2 } from '@/core/pricing'
import type { Branch, Order, PaymentMethod } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead } from '../core/registry'
import type { Row, Where } from '../db/types'
import { loadProducts, wholesaleList } from '../domain/catalog'
import { customerFrom, loadOrders, paymentFrom, selectIn } from '../domain/orders'
import { bizDay, E, fromMilli, fromMinor, nameOf, str } from '../domain/util'
import { categoryNames, expenseFrom } from './ops'

/** The app's `Summary` (src/data/api.ts). */
export interface Summary {
  sales: number
  orderCount: number
  avgOrder: number
  paymentsReceived: number
  expenses: number
  salary: number
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
  returns: number
  returnCount: number
}

const isoArg = (v: unknown) => { const d = new Date(String(v)); if (v == null || Number.isNaN(d.getTime())) throw new ApiError('Choose a date range'); return d }
/** Sale payments are written just after the bill is claimed, so a bill billed at the end of the range can have its payment a moment later. */
const PAYMENT_SLACK_MS = 10 * 60_000
const METHODS: PaymentMethod[] = ['cash', 'upi', 'card', 'bank', 'credit', 'credit_note']
const zero = () => Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>

/** Everything a summary needs for the range, read once for all the branches asked for. */
async function loadRange(c: Ctx, from: Date, to: Date, branches: string[]) {
  const f = from.toISOString(), t = to.toISOString()
  const where: Where = { business_id: c.businessId, branch_id: { in: branches } }
  const [orders, pays, expRows, cat, retRows, cancelled] = await Promise.all([
    loadOrders(c, { ...where, status: E.OrderStatus.completed, billed_at: { gte: f, lte: t } }, { orderBy: [['billed_at', 'ASC']], limit: 20000 }),
    c.db.select('payments', { where: { ...where, is_voided: false, CREATEDTIME: { gte: f, lte: new Date(to.getTime() + PAYMENT_SLACK_MS).toISOString() } }, limit: 50000 }),
    c.db.select('expenses', { where: { ...where, is_voided: false, expense_date: { gte: f, lte: t } }, limit: 20000 }),
    categoryNames(c),
    c.db.select('sale_returns', { where: { ...where, CREATEDTIME: { gte: f, lte: t } }, limit: 20000 }),
    c.db.aggregate('orders', { where: { ...where, status: E.OrderStatus.cancelled, cancelled_at: { gte: f, lte: t } }, groupBy: ['branch_id'], fns: { n: ['COUNT', 'ROWID'] } }),
  ])
  // Only lines that went back on the shelf change the cost of goods.
  const retLines = retRows.length ? await selectIn(c, 'sale_return_items', 'return_id', retRows.map((r) => r.ROWID), { business_id: c.businessId, restock: true }) : []
  const ids = [...new Set([...orders.flatMap((o) => o.items.map((i) => i.productId)), ...retLines.map((l) => str(l.product_id)).filter(Boolean)])]
  const products = ids.length ? await loadProducts(c, { ids, withExpiry: false }) : []
  const payments = pays.map(paymentFrom)
  return {
    from, to, orders, products: new Map(products.map((p) => [p.id, p])),
    payments: payments.filter((p) => p.createdAt <= t), salePays: payments.filter((p) => p.kind === 'sale' && p.orderId),
    expenses: expRows.map((r) => expenseFrom(r, cat)),
    returns: retRows.map((r) => ({ id: r.ROWID, branchId: str(r.branch_id), total: fromMinor(r.total_minor), lines: retLines.filter((l) => l.return_id === r.ROWID) })),
    cancelled: new Map(cancelled.map((x) => [str(x.branch_id), Number(x.n ?? 0)])),
  }
}
type RangeData = Awaited<ReturnType<typeof loadRange>>

/** Parts of a timestamp in the shop's time zone (the server runs in UTC; the mock used the browser's local time). */
function zoned(c: Ctx) {
  const tz = c.business.timezone || 'Asia/Kolkata'
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
  return { hour: (iso: string) => Number(hourFmt.format(new Date(iso))) % 24, day: (iso: string) => bizDay(c, new Date(iso)) }
}
const dayLabel = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' })

function summarize(c: Ctx, d: RangeData, branches: Set<string>): Summary {
  const z = zoned(c)
  const inB = <T extends { branchId: string }>(rows: T[]) => rows.filter((r) => branches.has(r.branchId))
  const orders: Order[] = inB(d.orders)
  const payments = inB(d.payments)
  const expenses = inB(d.expenses)
  const salesByMethod = zero()
  const paymentsByMethod = zero()
  const orderIds = new Set(orders.map((o) => o.id))
  const salePays = inB(d.salePays).filter((p) => orderIds.has(p.orderId!))
  for (const p of salePays) salesByMethod[p.method] += p.amount
  const paidAtSale = new Map<string, number>()
  for (const p of salePays) paidAtSale.set(p.orderId!, (paidAtSale.get(p.orderId!) ?? 0) + p.amount)
  for (const o of orders) salesByMethod.credit += Math.max(0, o.total - (paidAtSale.get(o.id) ?? 0))
  // A credit note used on a bill isn't new money — it was counted when the goods were first sold.
  for (const p of payments) if (p.method !== 'credit_note') paymentsByMethod[p.method] += p.kind === 'refund' ? -p.amount : p.amount
  const expensesByCategory: Record<string, number> = {}
  for (const e of expenses) if (e.category !== 'salary') expensesByCategory[e.category] = r2((expensesByCategory[e.category] ?? 0) + e.amount)
  const byType: Summary['byType'] = {}
  const prod = new Map<string, Summary['topProducts'][number]>()
  let cogs = 0
  for (const o of orders) {
    byType[o.type] = { count: (byType[o.type]?.count ?? 0) + 1, amount: r2((byType[o.type]?.amount ?? 0) + o.total) }
    for (const i of o.items) {
      const p = d.products.get(i.productId)
      const cur = prod.get(i.productId) ?? { productId: i.productId, name: i.name, emoji: p?.emoji ?? '📦', imageUrl: p?.imageUrl ?? null, qty: 0, revenue: 0 }
      cur.qty = fromMilli(Math.round((cur.qty + i.qty) * 1000))
      cur.revenue = r2(cur.revenue + i.qty * i.unitPrice)
      prod.set(i.productId, cur)
      cogs += (p?.costPrice ?? 0) * i.qty
    }
  }
  // Time series: hourly (8 AM – 11 PM) for a single day, daily otherwise.
  const days = Math.round((d.to.getTime() - d.from.getTime()) / 86400000)
  const series: Summary['series'] = []
  if (days <= 1) {
    for (let h = 8; h <= 23; h++) series.push({ key: String(h), label: `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`, sales: 0, orders: 0, expenses: 0 })
    for (const o of orders) {
      const row = series[Math.max(8, z.hour(o.billedAt!)) - 8]
      if (row) { row.sales = r2(row.sales + o.total); row.orders++ }
    }
  } else {
    const first = Date.parse(`${z.day(d.from.toISOString())}T12:00:00Z`), last = Date.parse(`${z.day(d.to.toISOString())}T12:00:00Z`)
    const index = new Map<string, Summary['series'][number]>()
    for (let t = first, k = 0; t <= last && k < 400; t += 86400000, k++) {
      const row = { key: new Date(t).toISOString().slice(0, 10), label: dayLabel.format(new Date(t)), sales: 0, orders: 0, expenses: 0 }
      series.push(row); index.set(row.key, row)
    }
    for (const o of orders) { const r = index.get(z.day(o.billedAt!)); if (r) { r.sales = r2(r.sales + o.total); r.orders++ } }
    for (const e of expenses) { const r = index.get(z.day(e.date)); if (r && e.category !== 'salary') r.expenses = r2(r.expenses + e.amount) }
  }
  const rets = inB(d.returns)
  const returns = r2(rets.reduce((a, r) => a + r.total, 0))
  for (const r of rets) for (const l of r.lines) cogs -= (d.products.get(str(l.product_id))?.costPrice ?? 0) * fromMilli(l.qty_milli)
  const sales = r2(orders.reduce((a, o) => a + o.total, 0))
  const salary = r2(expenses.filter((e) => e.category === 'salary').reduce((a, e) => a + e.amount, 0))
  const exp = r2(expenses.filter((e) => e.category !== 'salary').reduce((a, e) => a + e.amount, 0))
  for (const m of METHODS) { salesByMethod[m] = r2(salesByMethod[m]); paymentsByMethod[m] = r2(paymentsByMethod[m]) }
  return {
    sales, orderCount: orders.length, avgOrder: orders.length ? r2(sales / orders.length) : 0,
    paymentsReceived: r2(payments.filter((p) => p.method !== 'credit_note').reduce((a, p) => a + (p.kind === 'refund' ? -p.amount : p.amount), 0)),
    expenses: exp, salary, net: r2(sales - returns - exp - salary), returns, returnCount: rets.length,
    outstanding: r2(orders.reduce((a, o) => a + o.balance, 0)),
    tax: r2(orders.reduce((a, o) => a + o.tax, 0)), discount: r2(orders.reduce((a, o) => a + o.discount, 0)), cogs: r2(cogs),
    salesByMethod, paymentsByMethod, expensesByCategory, byType,
    topProducts: [...prod.values()].sort((a, b) => b.revenue - a.revenue),
    series,
    cancelled: [...branches].reduce((n, b) => n + (d.cancelled.get(b) ?? 0), 0),
  }
}

const LATE_KOT_MS = 20 * 60_000

define('reports', {
  summary: userRead(async (c, from: string, to: string) => {
    const f = isoArg(from), t = isoArg(to)
    return summarize(c, await loadRange(c, f, t, c.scope()), new Set(c.scope()))
  }),

  /** One summary per branch in the current view, plus live alerts — for the multi-branch dashboard. */
  byBranch: userRead(async (c, from: string, to: string) => {
    const f = isoArg(from), t = isoArg(to)
    const scope = c.scope()
    const branches: Branch[] = c.s.allBranches.filter((b) => scope.includes(b.id))
    const where: Where = { business_id: c.businessId, branch_id: { in: scope } }
    const late = new Date(c.now.getTime() - LATE_KOT_MS).toISOString()
    const [data, open, kots, products, stock] = await Promise.all([
      loadRange(c, f, t, scope),
      c.db.aggregate('orders', { where: { ...where, status: E.OrderStatus.open }, groupBy: ['branch_id', 'qr_status'], fns: { n: ['COUNT', 'ROWID'] } }),
      c.db.select('kitchen_tickets', { where: { ...where, status: { in: [E.KotStatus.new, E.KotStatus.preparing] }, CREATEDTIME: { lt: late } }, orderBy: [['CREATEDTIME', 'ASC']], limit: 500 }),
      c.db.select('products', { where: { business_id: c.businessId, is_active: true, track_stock: true } }),
      c.db.select('branch_stock', { where }),
    ])
    const qty = new Map(stock.map((s) => [`${str(s.branch_id)}:${str(s.product_id)}`, fromMilli(s.qty_milli)]))
    return branches.map((b) => ({
      branch: b,
      summary: summarize(c, data, new Set([b.id])),
      running: open.filter((x) => str(x.branch_id) === b.id).reduce((n, x) => n + Number(x.n ?? 0), 0),
      pendingQr: open.filter((x) => str(x.branch_id) === b.id && Number(x.qr_status) === E.QrStatus.pending).reduce((n, x) => n + Number(x.n ?? 0), 0),
      lateKots: kots.filter((k) => str(k.branch_id) === b.id).map((k) => ({ number: str(k.number), minutes: Math.floor((c.now.getTime() - Date.parse(k.CREATEDTIME)) / 60000) })),
      lowStock: products.map((p) => ({ p, s: qty.get(`${b.id}:${p.ROWID}`) ?? 0 })).filter(({ p, s }) => s <= fromMilli(p.low_stock_milli))
        .map(({ p, s }) => ({ name: str(p.name), stock: s, unit: str(p.unit) || 'pc' })),
    }))
  }),

  /** Customers who owe money (whole business), largest first. */
  receivables: userRead(async (c) => {
    // One row per customer instead of every bill.
    const dues = (await c.db.aggregate('orders', {
      where: { business_id: c.businessId, status: E.OrderStatus.completed, customer_id: { ne: null } }, groupBy: ['customer_id'],
      fns: { total: ['SUM', 'total_minor'], n: ['COUNT', 'ROWID'], due: ['SUM', 'balance_minor'], last: ['MAX', 'billed_at'] },
    })).filter((x) => Number(x.due ?? 0) > 0)
    if (!dues.length) return []
    const ids = dues.map((x) => str(x.customer_id))
    const [rows, rets, list] = await Promise.all([
      selectIn(c, 'customers', 'ROWID', ids, { business_id: c.businessId }),
      c.db.aggregate('sale_returns', { where: { business_id: c.businessId, customer_id: { in: ids } }, groupBy: ['customer_id'], fns: { total: ['SUM', 'total_minor'] } }),
      wholesaleList(c),
    ])
    return rows.map((r) => {
      const x = dues.find((y) => str(y.customer_id) === r.ROWID)!, ret = rets.find((y) => str(y.customer_id) === r.ROWID)
      return {
        customer: customerFrom(r, list?.ROWID ?? null), totalPurchases: r2(fromMinor(x.total) - fromMinor(ret?.total)), orderCount: Number(x.n ?? 0),
        outstanding: fromMinor(x.due), lastPurchase: (x.last as string | null) ?? null,
      }
    }).sort((a, b) => b.outstanding - a.outstanding)
  }, { perm: 'reports.view' }),
})

define('audit', {
  list: userRead(async (c, limit = 50) => {
    const n = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 50))
    const rows = await c.db.select('audit_logs', { where: { business_id: c.businessId }, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: n })
    const users = await selectIn(c, 'users', 'ROWID', rows.map((r) => str(r.user_id)).filter(Boolean), { business_id: c.businessId })
    const names = new Map(users.map((u: Row) => [u.ROWID, str(u.name)]))
    return rows.map((a) => ({
      id: a.ROWID, businessId: str(a.business_id), entity: nameOf(E.AuditEntity, a.entity), entityId: str(a.entity_id), action: nameOf(E.AuditAction, a.action),
      userId: str(a.user_id), at: a.CREATEDTIME, detail: str(a.detail), userName: names.get(str(a.user_id)) ?? '—',
    }))
  }, { perm: 'settings.manage' }),
})
