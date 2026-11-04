// Reports (dashboard summary, branch overview, receivables) and the audit log. Same numbers as the app's mock.
//
// The Data Store free tier counts every row read, so a report reads each table once for the whole
// range (and all branches in view) and works the figures out in memory.
import { B2CL_LIMIT, buildGstReport, monthRange, returnLines, shopStateOf, splitLineTax, uqcOf, type GstBill, type GstCreditNote, type GstPreAdded, type GstPurchase } from '@/core/gst'
import { r2 } from '@/core/pricing'
import type { Branch, Order, PaymentMethod } from '@/core/types'
import { pastReport } from '../domain/reportCache'
import { withGstSplit } from '../domain/gstSql'
import type { Ctx } from '../core/context'
import { ApiError, forbidden } from '../core/errors'
import { define, userRead } from '../core/registry'
import type { Row, SqlRow, Where } from '../db/types'
import { imageOf, loadProducts, mediaMap, wholesaleList } from '../domain/catalog'
import { customerFrom, loadOrders, paymentFrom, selectIn } from '../domain/orders'
import { bizDay, bizDayStart, E, moduleOn, fromMilli, fromMinor, nameOf, selectOlder, str, strOrNull } from '../domain/util'
import { categoryNames, expenseFrom } from './ops'
import { dateFormat } from '@/core/intl'

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
  const hourFmt = dateFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
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

// ---------- Turso: the same summary added up by the database ----------
// One database per shop (Turso/SQLite): the totals come from ~10 small SQL queries instead of reading every bill,
// item, payment and expense into memory. The result is the same `Summary` (field for field) as summarize().
// The Data Store keeps summarize() (no joins or time functions there). REPORTS_SQL=off switches this off.

/** Minutes the zone is ahead of UTC at that moment (India: 330). */
function zoneOffset(tz: string, at: Date) {
  const name = dateFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? ''
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}
/** Can this range be added up in SQL? (Turso, and one clock offset for the whole range.) */
function sqlSummaryOk(c: Ctx, from: Date, to: Date) {
  if (process.env.REPORTS_SQL === 'off' || !c.dbs.perShop || typeof c.db.sql !== 'function') return false
  const tz = c.business.timezone || 'Asia/Kolkata'
  return zoneOffset(tz, from) === zoneOffset(tz, to)
}

const sortLike = (rows: Row[], ids: string[]) => { const at = new Map(ids.map((id, k) => [id, k])); return rows.sort((a, b) => (at.get(a.ROWID) ?? 0) - (at.get(b.ROWID) ?? 0)) }

/**
 * reports.gst on Turso: the month's bills added up by the database (outward tax, walk-in B2CS, HSN summary, invoice
 * range), plus the ids of the bills listed one by one (B2B, B2CL). GST is split per line (per bill × rate for B2CS)
 * as before: the database groups the lines by their GST amount and each amount is split once, then counted.
 * Null = read every bill as before (switch off, not Turso, or bills from before GST lines were stored).
 */
async function gstPreAdded(c: Ctx, start: string, end: string): Promise<{ pre: GstPreAdded; listed: string[] } | null> {
  if (process.env.REPORTS_SQL === 'off' || !c.dbs.perShop || typeof c.db.sql !== 'function') return null
  const sql = c.db.sql!.bind(c.db)
  const billed = `o."business_id" = ? AND o."status" = ? AND o."billed_at" >= ? AND o."billed_at" < ?`
  const args = [Number(c.businessId), E.OrderStatus.completed, start, end]
  const ig = `(COALESCE(o."is_igst", 0) <> 0)`
  const listed = `(COALESCE(o."customer_gstin", '') <> '' OR (${ig} AND o."total_minor" > ${B2CL_LIMIT * 100}))`
  const lines = `"order_items" i JOIN "orders" o ON o."id" = i."order_id" WHERE ${billed}`
  const at = `o."billed_at" || printf('|%020d|%06d', o."id", i."sort_order")`
  const tax = `COALESCE(i."tax_minor", 0)`
  const hsnKey = `COALESCE(i."hsn_code", '')`, bpKey = `COALESCE(i."tax_bp", 0)`, unitKey = `COALESCE(NULLIF(i."unit", ''), 'pc')`
  // GST split in the database, per line (per bill × rate for B2CS), with splitTax's exact rounding (withGstSplit),
  // then added up in whole paise — so only a few rows come back, not one per distinct tax amount.
  const split = withGstSplit
  const sums = `SUM(CASE WHEN ig THEN igp ELSE 0 END) AS sIg, SUM(CASE WHEN ig THEN 0 ELSE cg END) AS sCg, SUM(CASE WHEN ig THEN 0 ELSE sg END) AS sSg`
  const lineRows = (extra: string) => `(SELECT ${ig} AS ig, ${tax} AS t, i."taxable_minor" AS tx${extra} FROM ${lines})`
  const [legacy, outward, hsnRows, b2csRows, docs, ids] = await Promise.all([
    sql(`SELECT COUNT(*) AS n FROM ${lines} AND i."taxable_minor" IS NULL`, args),
    sql(`SELECT COUNT(*) AS n, SUM(tx) AS tx, ${sums} FROM ${split(lineRows(''))}`, args),
    // (SQLite: with one MIN(), the plain column `name` comes from that same first line.)
    sql(`SELECT h, bp, u, ig, COUNT(*) AS n, SUM(tx) AS tx, SUM(q) AS q, SUM(q % 10 <> 0) AS odd, MIN(first) AS first, name, ${sums}
      FROM ${split(lineRows(`, ${hsnKey} AS h, ${bpKey} AS bp, ${unitKey} AS u, COALESCE(i."qty_milli", 0) AS q, ${at} AS first, COALESCE(i."product_name", '') AS name`))}
      GROUP BY h, bp, u, ig`, args),
    sql(`SELECT pos, bp, ig, COUNT(*) AS n, SUM(tx) AS tx, MIN(first) AS first, ${sums} FROM ${split(`(
      SELECT o."id" AS bill, NULLIF(o."place_of_supply", '') AS pos, ${bpKey} AS bp, ${ig} AS ig, SUM(${tax}) AS t, SUM(i."taxable_minor") AS tx, MIN(${at}) AS first
      FROM ${lines} AND NOT ${listed} GROUP BY 1, 3)`)} GROUP BY pos, bp, ig`, args),
    sql(`SELECT MIN(o."invoice_number") AS a, MAX(o."invoice_number") AS z, COUNT(*) AS n FROM "orders" o WHERE ${billed} AND COALESCE(o."invoice_number", '') <> ''`, args),
    sql(`SELECT o."id" AS id FROM "orders" o WHERE ${billed} AND ${listed} ORDER BY o."billed_at", o."id"`, args),
  ])
  if (Number(legacy[0]?.n ?? 0) > 0) return null
  const num = (v: unknown) => Number(v ?? 0)
  const byFirst = (a: SqlRow, b: SqlRow) => (str(a.first) < str(b.first) ? -1 : str(a.first) > str(b.first) ? 1 : 0)
  const splitOf = (ig: number, cg: number, sg: number) => ({ igst: fromMinor(ig), cgst: fromMinor(cg), sgst: fromMinor(sg) })

  // HSN × rate × UQC (several units can share one UQC), in the order each first appears on the bills.
  type H = Omit<GstPreAdded['hsn'][number], 'split'> & { milli: number; odd: number; tx: number; ig: number; cg: number; sg: number }
  const hsn = new Map<string, H>()
  let missingHsn = 0
  for (const r of [...hsnRows].sort(byFirst)) {
    const rate = num(r.bp) / 100, uqc = uqcOf(str(r.u)), key = `${str(r.h) || '—'}|${rate}|${uqc}`
    const g = hsn.get(key) ?? { hsn: str(r.h), name: str(r.name), uqc, rate, qty: 0, taxable: 0, milli: 0, odd: 0, tx: 0, ig: 0, cg: 0, sg: 0 }
    g.milli += num(r.q); g.odd += num(r.odd); g.tx += num(r.tx); g.ig += num(r.sIg); g.cg += num(r.sCg); g.sg += num(r.sSg)
    hsn.set(key, g)
    if (!str(r.h)) missingHsn += num(r.n)
  }
  // Quantities are added line by line to 2 decimals; whole-10 g/ml lines add up exactly, others are added again in bill order.
  const odd = [...hsn.entries()].filter(([, g]) => g.odd > 0)
  if (odd.length) {
    const pairs = [...new Set(odd.map(([, g]) => `${g.hsn}|${Math.round(g.rate * 100)}`))]
    const rows = await sql(`SELECT ${hsnKey} AS h, ${bpKey} AS bp, ${unitKey} AS u, COALESCE(i."qty_milli", 0) AS q FROM ${lines}
      AND (${hsnKey} || '|' || ${bpKey}) IN (${pairs.map(() => '?').join(', ')}) ORDER BY o."billed_at", o."id", i."sort_order"`, [...args, ...pairs])
    const replay = new Map(odd)
    for (const [, g] of odd) g.qty = 0
    for (const r of rows) {
      const g = replay.get(`${str(r.h) || '—'}|${num(r.bp) / 100}|${uqcOf(str(r.u))}`)
      if (g) g.qty = r2(g.qty + fromMilli(num(r.q)))
    }
  }
  for (const g of hsn.values()) { if (!g.odd) g.qty = Math.round(g.milli / 10) / 100; g.taxable = fromMinor(g.tx) }

  return {
    listed: ids.map((r) => str(r.id)),
    pre: {
      outward: { taxable: fromMinor(num(outward[0]?.tx)), split: splitOf(num(outward[0]?.sIg), num(outward[0]?.sCg), num(outward[0]?.sSg)) },
      b2cs: [...b2csRows].sort(byFirst).map((r) => ({ placeOfSupply: strOrNull(r.pos), rate: num(r.bp) / 100, igst: num(r.ig) !== 0, taxable: fromMinor(num(r.tx)), split: splitOf(num(r.sIg), num(r.sCg), num(r.sSg)) })),
      hsn: [...hsn.values()].map(({ hsn: h, name, uqc, rate, qty, taxable, ig, cg, sg }) => ({ hsn: h, name, uqc, rate, qty, taxable, split: splitOf(ig, cg, sg) })),
      missingHsn,
      docs: { from: str(docs[0]?.a), to: str(docs[0]?.z), count: num(docs[0]?.n) },
    },
  }
}

/** The SQL answers for one summary (step 1 — the database work; branches can run this in parallel). */
async function sqlSummaryRows(c: Ctx, from: Date, to: Date, branches: string[]) {
  const sql = c.db.sql!.bind(c.db)
  const f = from.toISOString(), t = to.toISOString(), tSlack = new Date(to.getTime() + PAYMENT_SLACK_MS).toISOString()
  const bid = Number(c.businessId)
  const br = branches.map(Number)
  if (!br.length) return null
  const inBr = (alias: string) => `${alias}."branch_id" IN (${br.map(() => '?').join(', ')})`
  const off = zoneOffset(c.business.timezone || 'Asia/Kolkata', from)
  const shift = `${off >= 0 ? '+' : '-'}${Math.abs(off)} minutes`
  const DONE = E.OrderStatus.completed, SALE = E.PaymentKind.sale
  // Completed bills billed in the range, in the branches asked for.
  const billed = `o."business_id" = ? AND ${inBr('o')} AND o."status" = ? AND o."billed_at" >= ? AND o."billed_at" <= ?`
  const billedArgs = [bid, ...br, DONE, f, t]
  // A bill's sale payments (the money taken when it was billed): same window as summarize() reads.
  const salePay = `p."business_id" = ? AND ${inBr('p')} AND p."is_voided" = 0 AND p."kind" = ? AND p."order_id" IS NOT NULL AND p."created_at" >= ? AND p."created_at" <= ?`
  const salePayArgs = [bid, ...br, SALE, f, tSlack]
  const days = Math.round((to.getTime() - from.getTime()) / 86400000)

  // All the answers in ONE request (read-only, no transaction) where the database allows it; otherwise one by one.
  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    { sql: `SELECT COUNT(*) AS n, SUM(o."total_minor") AS total, SUM(o."tax_minor") AS tax, SUM(o."discount_minor") AS disc, SUM(o."balance_minor") AS bal FROM "orders" o WHERE ${billed}`, args: billedArgs },
    { sql: `SELECT o."order_type" AS k, COUNT(*) AS n, SUM(o."total_minor") AS total, MIN(o."billed_at" || printf('|%020d', o."id")) AS first FROM "orders" o WHERE ${billed} GROUP BY o."order_type"`, args: billedArgs },
    { sql: `SELECT p."method" AS m, SUM(p."amount_minor") AS s FROM "payments" p JOIN "orders" o ON o."id" = p."order_id" WHERE ${salePay} AND ${billed} GROUP BY p."method"`, args: [...salePayArgs, ...billedArgs] },
    // Unpaid part of each bill (never below 0), added up. Each bill's sale payments are added up once (one pass
    // over the window's payments, grouped by bill) — not looked up again for every bill.
    { sql: `SELECT SUM(MAX(0, o."total_minor" - COALESCE(pp."paid", 0))) AS s FROM "orders" o
      LEFT JOIN (SELECT p."order_id" AS oid, SUM(p."amount_minor") AS paid FROM "payments" p WHERE ${salePay} GROUP BY p."order_id") pp ON pp."oid" = o."id"
      WHERE ${billed}`, args: [...salePayArgs, ...billedArgs] },
    { sql: `SELECT p."method" AS m, p."kind" AS k, SUM(p."amount_minor") AS s FROM "payments" p WHERE p."business_id" = ? AND ${inBr('p')} AND p."is_voided" = 0 AND p."created_at" >= ? AND p."created_at" <= ? GROUP BY p."method", p."kind"`, args: [bid, ...br, f, t] },
    { sql: `SELECT e."category_id" AS cat, SUM(e."amount_minor") AS s FROM "expenses" e WHERE e."business_id" = ? AND ${inBr('e')} AND e."is_voided" = 0 AND e."expense_date" >= ? AND e."expense_date" <= ? GROUP BY e."category_id"`, args: [bid, ...br, f, t] },
    { sql: `SELECT COUNT(*) AS n, SUM(r."total_minor") AS s FROM "sale_returns" r WHERE r."business_id" = ? AND ${inBr('r')} AND r."created_at" >= ? AND r."created_at" <= ?`, args: [bid, ...br, f, t] },
    { sql: `SELECT l."product_id" AS pid, SUM(l."qty_milli") AS q FROM "sale_return_items" l JOIN "sale_returns" r ON r."id" = l."return_id" WHERE l."business_id" = ? AND l."restock" = 1 AND r."business_id" = ? AND ${inBr('r')} AND r."created_at" >= ? AND r."created_at" <= ? GROUP BY l."product_id"`, args: [bid, bid, ...br, f, t] },
    // Items per product: quantity, revenue (qty × price before discount, each line rounded to the paisa as the full read
    // and the bill do), and where it first appears (keeps the tie order).
    // (SQLite: with one MIN(), the plain column `name` comes from that same first row — the name on the first bill.)
    { sql: `SELECT i."product_id" AS pid, SUM(i."qty_milli") AS q, SUM((i."qty_milli" * i."unit_price_minor" + 500) / 1000) AS rev, MIN(o."billed_at" || printf('|%020d|%06d', o."id", i."sort_order")) AS first, i."product_name" AS name
      FROM "order_items" i JOIN "orders" o ON o."id" = i."order_id" WHERE ${billed} GROUP BY i."product_id"`, args: billedArgs },
    // Cancelled in the range (cancelled_at), as the count the full read makes.
    { sql: `SELECT COUNT(*) AS n FROM "orders" o WHERE o."business_id" = ? AND ${inBr('o')} AND o."status" = ? AND o."cancelled_at" >= ? AND o."cancelled_at" <= ?`, args: [bid, ...br, E.OrderStatus.cancelled, f, t] },
    days <= 1
      ? { sql: `SELECT CAST(strftime('%H', o."billed_at", ?) AS INTEGER) AS b, SUM(o."total_minor") AS s, COUNT(*) AS n FROM "orders" o WHERE ${billed} GROUP BY b`, args: [shift, ...billedArgs] }
      : { sql: `SELECT date(o."billed_at", ?) AS b, SUM(o."total_minor") AS s, COUNT(*) AS n FROM "orders" o WHERE ${billed} GROUP BY b`, args: [shift, ...billedArgs] },
    ...(days <= 1 ? [] : [{ sql: `SELECT date(e."expense_date", ?) AS b, e."category_id" AS cat, SUM(e."amount_minor") AS s FROM "expenses" e WHERE e."business_id" = ? AND ${inBr('e')} AND e."is_voided" = 0 AND e."expense_date" >= ? AND e."expense_date" <= ? GROUP BY b, e."category_id"`, args: [shift, bid, ...br, f, t] }]),
  ]
  const answers = c.db.sqlReads ? await c.db.sqlReads(stmts) : await Promise.all(stmts.map((x) => sql(x.sql, x.args)))
  const [tot, types, saleBy, credit, payBy, expBy, rets, retLines, items, cancelled, seriesO] = answers
  const seriesE = days <= 1 ? [] : answers[11]
  return { from, to, days, tot, types, saleBy, credit, payBy, expBy, rets, retLines, items, cancelled, seriesO, seriesE }
}
type SummaryRows = NonNullable<Awaited<ReturnType<typeof sqlSummaryRows>>>
/** The products and expense categories a set of summaries needs, read once for all of them. */
async function summaryLookups(c: Ctx, sets: (SummaryRows | null)[]) {
  const pid = (v: unknown) => (v == null ? '' : String(v))
  const ids = [...new Set(sets.flatMap((d) => (d ? [...d.items.map((x) => pid(x.pid)), ...d.retLines.map((x) => pid(x.pid))] : [])).filter(Boolean))]
  const [products, cat] = await Promise.all([productBits(c, ids), categoryNames(c)])
  return { products, cat }
}

/**
 * What a summary needs of each sold item: cost price (profit), emoji and photo — the same values the full product
 * read gives (loadProducts), from only those columns (the full read also builds variants, stock, batches…).
 */
async function productBits(c: Ctx, ids: string[]): Promise<Map<string, { costPrice: number; emoji: string; imageUrl: string | null }>> {
  const out = new Map<string, { costPrice: number; emoji: string; imageUrl: string | null }>()
  if (!ids.length) return out
  const sql = c.db.sql!.bind(c.db)
  const rows: SqlRow[] = []
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500).map(Number)
    rows.push(...await sql(`SELECT "id", "cost_minor", "emoji", "image_media_id" FROM "products" WHERE "business_id" = ? AND "id" IN (${part.map(() => '?').join(', ')})`, [Number(c.businessId), ...part]))
  }
  const media = await mediaMap(c, rows.map((r) => (r.image_media_id == null ? null : String(r.image_media_id))))
  for (const r of rows) out.set(String(r.id), { costPrice: fromMinor(r.cost_minor), emoji: str(r.emoji), imageUrl: imageOf(c, media.get(r.image_media_id == null ? '' : String(r.image_media_id))).imageUrl })
  return out
}
type SummaryLookups = Awaited<ReturnType<typeof summaryLookups>>
const emptySummary = (c: Ctx, from: Date, to: Date) => summarize(c, { from, to, orders: [], products: new Map(), payments: [], salePays: [], expenses: [], returns: [], cancelled: new Map() }, new Set())

/** Step 2: the `Summary` from the SQL answers and the shared lookups (no database work). */
function sqlSummaryFrom(c: Ctx, d: SummaryRows, look: SummaryLookups): Summary {
  const { from, to, days, tot, types, saleBy, credit, payBy, expBy, rets, retLines, items, cancelled, seriesO, seriesE } = d
  const REFUND = E.PaymentKind.refund
  const num = (v: unknown) => Number(v ?? 0)
  const money = (minor: unknown) => r2(num(minor) / 100)
  const cat = look.cat

  const n = num(tot[0]?.n)
  const sales = money(tot[0]?.total)
  const salesByMethod = zero(), paymentsByMethod = zero()
  for (const x of saleBy) { const m = nameOf(E.PayMethod, x.m) as PaymentMethod; salesByMethod[m] = r2(salesByMethod[m] + num(x.s) / 100) }
  salesByMethod.credit = r2(salesByMethod.credit + num(credit[0]?.s) / 100)
  let received = 0
  for (const x of payBy) {
    const m = nameOf(E.PayMethod, x.m) as PaymentMethod
    if (m === 'credit_note') continue
    const v = (num(x.k) === REFUND ? -1 : 1) * num(x.s)
    paymentsByMethod[m] = r2(paymentsByMethod[m] + v / 100)
    received += v
  }
  const expensesByCategory: Record<string, number> = {}
  let expMinor = 0, salaryMinor = 0
  for (const x of expBy) {
    const k = cat(x.cat as Row['category_id'])
    if (k === 'salary') { salaryMinor += num(x.s); continue }
    expMinor += num(x.s)
    expensesByCategory[k] = r2((expensesByCategory[k] ?? 0) + num(x.s) / 100)
  }
  const byType: Summary['byType'] = {}
  for (const x of [...types].sort((a, b) => String(a.first).localeCompare(String(b.first)))) byType[nameOf(E.OrderType, x.k)] = { count: num(x.n), amount: money(x.total) }

  // Products: emoji, photo and cost price (cost of goods = cost × quantity sold, less what came back to the shelf).
  const products = look.products
  let cogs = 0
  // First-sale keys all have one fixed layout (ISO time|20-digit id|6-digit line), so a plain character comparison
  // gives the same order as localeCompare did — without its cost on thousands of items.
  const byFirst = (a: SqlRow, b: SqlRow) => { const x = String(a.first), y = String(b.first); return x < y ? -1 : x > y ? 1 : 0 }
  const topProducts = [...items].sort(byFirst).map((x) => {
    const id = x.pid == null ? '' : String(x.pid)
    const p = products.get(id)
    const qty = fromMilli(num(x.q))
    cogs += (p?.costPrice ?? 0) * qty
    return { productId: id, name: String(x.name ?? ''), emoji: p?.emoji ?? '📦', imageUrl: p?.imageUrl ?? null, qty, revenue: r2(num(x.rev) / 100) }
  }).sort((a, b) => b.revenue - a.revenue)
  for (const x of retLines) cogs -= (products.get(x.pid == null ? '' : String(x.pid))?.costPrice ?? 0) * fromMilli(num(x.q))

  // Chart: hourly (8 AM – 11 PM) for one day, daily otherwise — the same buckets as summarize().
  const series: Summary['series'] = []
  if (days <= 1) {
    for (let h = 8; h <= 23; h++) series.push({ key: String(h), label: `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`, sales: 0, orders: 0, expenses: 0 })
    for (const x of seriesO) { const row = series[Math.max(8, num(x.b)) - 8]; if (row) { row.sales = r2(row.sales + num(x.s) / 100); row.orders += num(x.n) } }
  } else {
    const z = zoned(c)
    const first = Date.parse(`${z.day(from.toISOString())}T12:00:00Z`), last = Date.parse(`${z.day(to.toISOString())}T12:00:00Z`)
    const index = new Map<string, Summary['series'][number]>()
    for (let tt = first, k = 0; tt <= last && k < 400; tt += 86400000, k++) {
      const row = { key: new Date(tt).toISOString().slice(0, 10), label: dayLabel.format(new Date(tt)), sales: 0, orders: 0, expenses: 0 }
      series.push(row); index.set(row.key, row)
    }
    for (const x of seriesO) { const row = index.get(String(x.b)); if (row) { row.sales = r2(row.sales + num(x.s) / 100); row.orders += num(x.n) } }
    for (const x of seriesE) { const row = index.get(String(x.b)); if (row && cat(x.cat as Row['category_id']) !== 'salary') row.expenses = r2(row.expenses + num(x.s) / 100) }
  }
  const returns = money(rets[0]?.s)
  for (const m of METHODS) { salesByMethod[m] = r2(salesByMethod[m]); paymentsByMethod[m] = r2(paymentsByMethod[m]) }
  return {
    sales, orderCount: n, avgOrder: n ? r2(sales / n) : 0,
    paymentsReceived: r2(received / 100),
    expenses: r2(expMinor / 100), salary: r2(salaryMinor / 100), net: r2(sales - returns - r2(expMinor / 100) - r2(salaryMinor / 100)), returns, returnCount: num(rets[0]?.n),
    outstanding: money(tot[0]?.bal), tax: money(tot[0]?.tax), discount: money(tot[0]?.disc), cogs: r2(cogs),
    salesByMethod, paymentsByMethod, expensesByCategory, byType, topProducts, series,
    cancelled: num(cancelled[0]?.n),
  }
}

/** One summary added up in SQL (reports.summary). */
async function sqlSummary(c: Ctx, from: Date, to: Date, branches: string[]): Promise<Summary> {
  const d = await sqlSummaryRows(c, from, to, branches)
  return d ? sqlSummaryFrom(c, d, await summaryLookups(c, [d])) : emptySummary(c, from, to)
}
/** One summary per branch (reports.byBranch): the branches' queries run in parallel, products are read once. */
async function sqlSummaries(c: Ctx, from: Date, to: Date, branches: string[]): Promise<Map<string, Summary>> {
  const sets = await Promise.all(branches.map((b) => sqlSummaryRows(c, from, to, [b])))
  const look = await summaryLookups(c, sets)
  return new Map(branches.map((b, k) => [b, sets[k] ? sqlSummaryFrom(c, sets[k]!, look) : emptySummary(c, from, to)]))
}

/**
 * Low stock per branch for reports.byBranch (Turso): active stock items at or below their low-stock level in
 * that branch — no stock row counts as 0, in item order — the same list the full read builds, without reading
 * every item and stock row.
 */
async function lowStockByBranch(c: Ctx, branchIds: string[]) {
  const sql = c.db.sql!.bind(c.db)
  const bid = Number(c.businessId)
  const lists = await Promise.all(branchIds.map((b) => sql(`SELECT p."name" AS name, p."unit" AS unit, COALESCE(s."qty_milli", 0) AS q
    FROM "products" p LEFT JOIN "branch_stock" s ON s."product_id" = p."id" AND s."business_id" = ? AND s."branch_id" = ?
    WHERE p."business_id" = ? AND p."is_active" = 1 AND p."track_stock" = 1 AND COALESCE(s."qty_milli", 0) <= COALESCE(p."low_stock_milli", 0)
    ORDER BY p."id"`, [bid, Number(b), bid])))
  return new Map(branchIds.map((b, k) => [b, lists[k].map((r) => ({ name: str(r.name), stock: fromMilli(r.q), unit: str(r.unit) || 'pc' }))]))
}

const LATE_KOT_MS = 20 * 60_000

/** Sales figures are for the dashboard / reports; cost of goods (profit) only with "View profit". */
function canSeeSales(c: Ctx) { if (!c.can('dashboard.view') && !c.can('reports.view')) throw forbidden() }
const forViewer = (c: Ctx, s: Summary): Summary => (c.can('reports.profit') ? s : { ...s, cogs: 0 })

define('reports', {
  summary: userRead(async (c, from: string, to: string, opts?: { top?: number }) => {
    canSeeSales(c)
    const f = isoArg(from), t = isoArg(to)
    // `top`: only the first N best-selling items (the dashboard shows 5); the list is sorted in full first, so they
    // are exactly the first N of the whole list. Without it (Reports, older screens): every item, as before.
    const n = Math.floor(Number(opts?.top))
    const cut = (x: Summary): Summary => (n >= 1 && n <= 500 && x.topProducts.length > n ? { ...x, topProducts: x.topProducts.slice(0, n) } : x)
    // Turso: added up by the database; the Data Store (and REPORTS_SQL=off): the full read, as before.
    const build = async () => (sqlSummaryOk(c, f, t) ? sqlSummary(c, f, t, c.scope()) : summarize(c, await loadRange(c, f, t, c.scope()), new Set(c.scope())))
    // A finished range (yesterday, last week…): from the cache until something changes the past.
    // (and late payments can no longer land in it: they count up to PAYMENT_SLACK_MS after the range).
    if (t.getTime() < new Date(bizDayStart(c)).getTime() && c.now.getTime() - t.getTime() > PAYMENT_SLACK_MS) return cut(forViewer(c, await pastReport(c, `sum:${c.scope().join(',')}:${f.toISOString()}:${t.toISOString()}`, build)))
    return cut(forViewer(c, await build()))
  }),
  /** Best sellers of the last `days` finished days (billing screen's quick picks) — from the cache, not today's bills. */
  topProducts: userRead(async (c, days = 7, limit = 10) => {
    const n = Math.min(Math.max(1, Math.floor(Number(days) || 7)), 31)
    const end = new Date(new Date(bizDayStart(c)).getTime() - 1)
    const start = new Date(new Date(bizDayStart(c)).getTime() - n * 86_400_000)
    const s = await pastReport(c, `top:${c.scope().join(',')}:${n}:${start.toISOString()}`, async () => summarize(c, await loadRange(c, start, end, c.scope()), new Set(c.scope())))
    // Billing staff get the product order only; sales amounts need the dashboard / reports right.
    const seeSales = c.can('dashboard.view') || c.can('reports.view')
    return s.topProducts.slice(0, Math.min(Math.max(1, Math.floor(Number(limit) || 10)), 50)).map((p) => (seeSales ? p : { ...p, revenue: 0 }))
  }),

  /**
   * Monthly GST: GSTR-1 tables (B2B, B2C large / small, credit notes, HSN summary, documents) and the GSTR-3B
   * summary (output GST after returns − input GST from purchase bills). For the whole business (one GSTIN).
   */
  gst: userRead(async (c, month: string) => {
    let range
    try { range = monthRange(String(month ?? '')) } catch (e) { throw new ApiError((e as Error).message) }
    const start = bizDayStart(c, new Date(`${range.from}T12:00:00Z`)), end = bizDayStart(c, new Date(`${range.to}T12:00:00Z`))
    const billing = c.business.billing
    // Turso: the database adds up the walk-in bills, and only the B2B / B2CL bills are read one by one.
    const fast = await gstPreAdded(c, String(start), String(end))
    const orders = fast
      ? (fast.listed.length ? sortLike(await selectIn(c, 'orders', 'ROWID', fast.listed, { business_id: c.businessId }), fast.listed) : [])
      : await c.db.select('orders', { where: { business_id: c.businessId, status: E.OrderStatus.completed, billed_at: { gte: start, lt: end } }, orderBy: [['billed_at', 'ASC']], limit: 50000 })
    const items = orders.length ? await selectIn(c, 'order_items', 'order_id', orders.map((o) => o.ROWID)) : []
    const rets = await c.db.select('sale_returns', { where: { business_id: c.businessId, CREATEDTIME: { gte: start, lt: end } }, limit: 20000 })
    const retItems = rets.length ? await selectIn(c, 'sale_return_items', 'return_id', rets.map((r) => r.ROWID)) : []
    const retOrders = rets.length ? await selectIn(c, 'orders', 'ROWID', [...new Set(rets.map((r) => str(r.order_id)))], { business_id: c.businessId }) : []
    const soldLines = retItems.length ? await selectIn(c, 'order_items', 'ROWID', [...new Set(retItems.map((i) => str(i.order_item_id)))]) : []
    const custIds = [...new Set([...orders, ...retOrders].map((o) => str(o.customer_id)).filter(Boolean))]
    const customers = custIds.length ? await selectIn(c, 'customers', 'ROWID', custIds, { business_id: c.businessId }) : []
    // Lookups by id (one pass each) instead of searching the whole list for every bill.
    const group = (rows: Row[], key: string) => { const m = new Map<string, Row[]>(); for (const r of rows) { const k = str(r[key]); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]) } return m }
    const byId = (rows: Row[]) => new Map(rows.map((r) => [r.ROWID, r]))
    const custById = byId(customers)
    const custName = (o: Row) => str(custById.get(str(o.customer_id))?.name) || str(o.customer_name)
    const purchases = await c.db.select('purchases', { where: { business_id: c.businessId, status: E.PurchaseStatus.final, purchase_date: { gte: range.from, lt: range.to } }, limit: 20000 })
    const pItems = purchases.length ? await selectIn(c, 'purchase_items', 'purchase_id', purchases.map((p) => p.ROWID)) : []
    const sups = purchases.length ? await selectIn(c, 'suppliers', 'ROWID', [...new Set(purchases.map((p) => str(p.supplier_id)).filter(Boolean))], { business_id: c.businessId }) : []
    const day = (iso: string) => bizDay(c, new Date(iso))
    const itemsByOrder = group(items, 'order_id'), retItemsByReturn = group(retItems, 'return_id'), pItemsByPurchase = group(pItems, 'purchase_id')
    const retOrderById = byId(retOrders), soldById = byId(soldLines), supById = byId(sups)

    const bills: GstBill[] = orders.map((o) => {
      const mine = (itemsByOrder.get(o.ROWID) ?? []).sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
      // Bills made before GST lines were stored: split with the shop's current tax settings.
      const split = mine.some((i) => i.taxable_minor == null)
        ? splitLineTax(mine.map((i) => ({ qty: fromMilli(i.qty_milli), unitPrice: fromMinor(i.unit_price_minor), taxRate: Number(i.tax_bp ?? 0) / 100 })), fromMinor(o.discount_minor), billing, fromMinor(o.tax_minor))
        : mine.map((i) => ({ taxable: fromMinor(i.taxable_minor), tax: fromMinor(i.tax_minor) }))
      return {
        invoiceNumber: str(o.invoice_number), date: day(str(o.billed_at)), customer: custName(o), gstin: strOrNull(o.customer_gstin), placeOfSupply: strOrNull(o.place_of_supply), igst: !!o.is_igst, total: fromMinor(o.total_minor),
        lines: mine.map((i, k) => ({ hsn: str(i.hsn_code), name: str(i.product_name), unit: str(i.unit) || 'pc', qty: fromMilli(i.qty_milli), rate: Number(i.tax_bp ?? 0) / 100, taxable: split[k].taxable, tax: split[k].tax })),
      }
    })
    const creditNotes: GstCreditNote[] = rets.map((r) => {
      const o = retOrderById.get(str(r.order_id))
      const lines = (retItemsByReturn.get(r.ROWID) ?? []).map((i) => {
        const sold = soldById.get(str(i.order_item_id))
        return { name: str(i.product_name), unit: str(i.unit) || 'pc', hsn: str(sold?.hsn_code), qty: fromMilli(i.qty_milli), rate: Number(sold?.tax_bp ?? 0) / 100, amount: fromMinor(i.amount_minor) }
      })
      return {
        number: str(r.number), date: day(r.CREATEDTIME), invoiceNumber: str(r.invoice_number), customer: o ? custName(o) : '', gstin: o ? strOrNull(o.customer_gstin) : null,
        placeOfSupply: o ? strOrNull(o.place_of_supply) : null, igst: !!o?.is_igst, total: fromMinor(r.total_minor), lines: billing.taxEnabled ? returnLines(lines, fromMinor(r.tax_minor)) : lines.map((l) => ({ ...l, taxable: l.amount, tax: 0 })),
      }
    })
    const gstPurchases: GstPurchase[] = purchases.map((p) => {
      const sp = supById.get(str(p.supplier_id))
      return {
        number: str(p.number), supplierBillNo: str(p.supplier_bill_no), date: str(p.purchase_date), supplier: str(sp?.name), gstin: strOrNull(sp?.gstin), igst: !!p.is_igst, total: fromMinor(p.total_minor),
        lines: (pItemsByPurchase.get(p.ROWID) ?? []).map((i) => ({ rate: Number(i.tax_bp ?? 0) / 100, taxable: fromMinor(i.taxable_minor), tax: fromMinor(i.tax_minor) })),
      }
    })
    return buildGstReport({ month: String(month), shopState: shopStateOf(c.business), bills, creditNotes, purchases: gstPurchases, pre: fast?.pre })
  }, { perm: 'reports.view' }),

  /** One summary per branch in the current view, plus live alerts — for the multi-branch dashboard. */
  byBranch: userRead(async (c, from: string, to: string) => {
    canSeeSales(c)
    const f = isoArg(from), t = isoArg(to)
    const scope = c.scope()
    const branches: Branch[] = c.s.allBranches.filter((b) => scope.includes(b.id))
    const where: Where = { business_id: c.businessId, branch_id: { in: scope } }
    const late = new Date(c.now.getTime() - LATE_KOT_MS).toISOString()
    // Turso: each branch's summary added up in SQL (all branches in parallel); the Data Store: the full read, as before.
    const fast = sqlSummaryOk(c, f, t)
    const [data, open, kots, products, stock] = await Promise.all([
      fast ? sqlSummaries(c, f, t, branches.map((b) => b.id)) : loadRange(c, f, t, scope),
      c.db.aggregate('orders', { where: { ...where, status: E.OrderStatus.open }, groupBy: ['branch_id', 'qr_status'], fns: { n: ['COUNT', 'ROWID'] } }),
      // Late KOTs only with the kitchen on; low stock only with inventory on (no reads otherwise).
      moduleOn(c, 'kitchen') ? c.db.select('kitchen_tickets', { where: { ...where, status: { in: [E.KotStatus.new, E.KotStatus.preparing] }, CREATEDTIME: { lt: late } }, orderBy: [['CREATEDTIME', 'ASC']], limit: 500 }) : [],
      // Turso: only the low items, per branch, from SQL; otherwise every stock item and stock row, as before.
      moduleOn(c, 'inventory') && !fast ? c.db.select('products', { where: { business_id: c.businessId, is_active: true, track_stock: true } }) : [],
      moduleOn(c, 'inventory') && !fast ? c.db.select('branch_stock', { where }) : [],
    ])
    const low = fast && moduleOn(c, 'inventory') ? await lowStockByBranch(c, branches.map((b) => b.id)) : null
    const qty = new Map(stock.map((s) => [`${str(s.branch_id)}:${str(s.product_id)}`, fromMilli(s.qty_milli)]))
    return branches.map((b) => ({
      branch: b,
      summary: forViewer(c, data instanceof Map ? data.get(b.id)! : summarize(c, data, new Set([b.id]))),
      running: open.filter((x) => str(x.branch_id) === b.id).reduce((n, x) => n + Number(x.n ?? 0), 0),
      pendingQr: open.filter((x) => str(x.branch_id) === b.id && Number(x.qr_status) === E.QrStatus.pending).reduce((n, x) => n + Number(x.n ?? 0), 0),
      lateKots: kots.filter((k) => str(k.branch_id) === b.id).map((k) => ({ number: str(k.number), minutes: Math.floor((c.now.getTime() - Date.parse(k.CREATEDTIME)) / 60000) })),
      lowStock: low ? low.get(b.id) ?? [] : products.map((p) => ({ p, s: qty.get(`${b.id}:${p.ROWID}`) ?? 0 })).filter(({ p, s }) => s <= fromMilli(p.low_stock_milli))
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
  /** `before`: the last entry the screen has → the next older ones ("Load older"). */
  list: userRead(async (c, limit = 50, before?: unknown) => {
    const n = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 50))
    const rows = await selectOlder(c, 'audit_logs', { business_id: c.businessId }, before, n)
    const users = await selectIn(c, 'users', 'ROWID', rows.map((r) => str(r.user_id)).filter(Boolean), { business_id: c.businessId })
    const names = new Map(users.map((u: Row) => [u.ROWID, str(u.name)]))
    return rows.map((a) => ({
      id: a.ROWID, businessId: str(a.business_id), entity: nameOf(E.AuditEntity, a.entity), entityId: str(a.entity_id), action: nameOf(E.AuditAction, a.action),
      userId: str(a.user_id), at: a.CREATEDTIME, detail: str(a.detail), userName: names.get(str(a.user_id)) ?? '—',
    }))
  }, { perm: 'settings.manage' }),
})
