// Data export: every row a business owns, as tables (the browser turns them into Excel sheets / a CSV ZIP)
// plus links to its product photos. Used by the owner (Settings → Audit & Data) and by the product admin.
// Never contains password hashes, PINs, tokens or secrets.
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { SUPPORT_MESSAGE } from '../core/context'
import { adminWrite, define, userRead } from '../core/registry'
import type { Row, Where } from '../db/types'
import type { TableName } from '../db/schema.gen'
import { loadOrders } from '../domain/orders'
import { audit, E, fromBp, fromMilli, fromMinor, nameOf, nameOrNull, r2, str } from '../domain/util'
import { adminLog, findBiz } from './admin/shared'

/** Most rows read per table (newest kept). A shop reaching this should export by date range instead. */
export const EXPORT_LIMIT = 20_000

type Cell = string | number | boolean | null
export interface ExportBundle {
  businessName: string
  exportedAt: string
  tables: { name: string; rows: Record<string, Cell>[] }[]
  /** Product photos for the ZIP: the browser downloads each `url` and stores it at `path`. */
  images: { path: string; url: string }[]
}

export async function exportTables(c: Ctx, businessId: string, forAdmin: boolean): Promise<ExportBundle> {
  const b = await c.platform.get('businesses', businessId)
  if (!b || b.deleted_at) throw new ApiError('Customer not found', 404, 'NOT_FOUND')
  await c.useShop(businessId) // the product admin: that shop's database
  const where: Where = { business_id: businessId }
  /** Every row of a small table, or the newest EXPORT_LIMIT of a big one (returned oldest first). */
  const all = (t: TableName, extra: Where = {}) => c.db.select(t, { where: { ...extra, ...where } })
  const newest = async (t: TableName, extra: Where = {}) => (await c.db.select(t, { where: { ...extra, ...where }, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: EXPORT_LIMIT })).reverse()

  const [branches, users, roles, categories, products, variants, addons, lists, prices, stock, media, customers, dues,
    payments, returns, returnItems, expenses, expenseCats, movements, batches, attendance, salaries, advances, tables, wa, logs, periods] = await Promise.all([
    all('branches'), all('users'), all('roles'), all('categories'), all('products'),
    all('product_variants', { is_active: true }), all('product_addons', { is_active: true }), all('price_lists'), all('product_prices'), all('branch_stock'),
    all('media_files', { purpose: E.MediaPurpose.product }), all('customers'),
    c.db.aggregate('orders', { where: { ...where, status: E.OrderStatus.completed }, groupBy: ['customer_id'], fns: { due: ['SUM', 'balance_minor'] } }),
    newest('payments'), newest('sale_returns'), newest('sale_return_items'), newest('expenses'), all('expense_categories'),
    newest('stock_movements'), all('stock_batches'), newest('attendance'), all('salary_payments'), all('staff_advances'), all('dining_tables'),
    newest('whatsapp_messages', { sender: E.WaSender.business }), newest('audit_logs'),
    forAdmin ? c.platform.select('subscription_periods', { where, orderBy: [['CREATEDTIME', 'ASC']] }) : Promise.resolve([] as Row[]),
  ])
  const orders = (await loadOrders(c, {}, { businessId, orderBy: [['CREATEDTIME', 'DESC']], limit: EXPORT_LIMIT })).reverse()

  const tz = str(b.timezone) || 'Asia/Kolkata'
  const dt = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleString('en-IN', { timeZone: tz }) : '')
  const byId = (rows: Row[]) => new Map(rows.map((r) => [r.ROWID, r]))
  const B = byId(branches), U = byId(users), R = byId(roles), C = byId(categories), P = byId(products), K = byId(customers), M = byId(media), X = byId(expenseCats)
  const O = new Map(orders.map((o) => [o.id, o]))
  const branch = (id: unknown) => str(B.get(str(id as string))?.name)
  const userName = (id: unknown) => (id ? str(U.get(String(id))?.name) : '') || (id === 'guest' ? 'QR customer' : '')
  const product = (id: unknown) => str(P.get(str(id as string))?.name)
  const customer = (id: unknown) => (id ? str(K.get(String(id))?.name) : '')
  const category = (id: unknown) => (id ? str(C.get(String(id))?.name) : '')
  const method = (v: unknown) => nameOrNull(E.PayMethod, v as number) ?? ''
  const wholesale = lists.find((l) => !l.is_default)
  const group = (rows: Row[], col: string) => { const m = new Map<string, Row[]>(); for (const r of rows) { const k = str(r[col]); m.set(k, [...(m.get(k) ?? []), r]) } return m }
  const V = group(variants.sort((x, y) => Number(x.sort_order) - Number(y.sort_order)), 'product_id')
  const A = group(addons.sort((x, y) => Number(x.sort_order) - Number(y.sort_order)), 'product_id')
  const S = group(stock, 'product_id')
  const RI = group(returnItems, 'return_id')
  const photo = (p: Row) => {
    const m = M.get(str(p.image_media_id))
    if (!m) return null
    if (m.bucket === 'external') return { cell: str(m.object_key), image: null } // a photo link kept as is (CSV import)
    const path = `images/${p.ROWID}.${str(m.content_type) === 'image/webp' ? 'webp' : 'jpg'}`
    return { cell: path, image: { path, url: c.files.url(str(m.object_key)) } }
  }
  const category0 = nameOf(E.BusinessCategory, b.category)

  const out: ExportBundle['tables'] = [
    { name: 'Business', rows: [{ Name: str(b.name), Type: `${category0} · ${str(b.sub_type)}`, Phone: str(b.phone), Email: str(b.email), Address: str(b.address), GSTIN: str(b.gstin), Currency: str(b.currency_code) || 'INR', Created: dt(b.CREATEDTIME), 'Valid until': dt(b.subscription_end_at), 'Branch limit': Number(b.max_branches ?? 1) }] },
    { name: 'Branches', rows: branches.map((x) => ({ Name: str(x.name), Address: str(x.address), Phone: str(x.phone), Main: !!x.is_default, Active: x.is_active !== false, 'Bill prefix': str(x.invoice_prefix) })) },
    { name: 'Staff', rows: users.map((u) => ({
      Name: str(u.name), Mobile: str(u.phone), Email: str(u.email), Username: str(u.username), Role: str(R.get(str(u.role_id))?.name), Branch: branch(u.default_branch_id), Active: u.is_active !== false,
      'Salary type': u.pay_type != null ? nameOf(E.PayType, u.pay_type) : '', Salary: u.pay_type != null ? fromMinor(u.pay_amount_minor) : '', 'Commission %': u.pay_type != null ? fromBp(u.commission_bp) : '', 'Last login': dt(u.last_login_at),
    })) },
    { name: 'Categories', rows: categories.filter((x) => x.is_active !== false).map((x) => ({ Name: str(x.name), Icon: str(x.emoji) })) },
    { name: 'Products', rows: products.map((p) => {
      const pp = wholesale ? prices.filter((x) => x.product_id === p.ROWID && x.price_list_id === wholesale.ROWID && x.variant_id == null)[0] : undefined
      return {
        Name: str(p.name), Category: category(p.category_id), Price: fromMinor(p.price_minor), MRP: p.mrp_minor != null ? fromMinor(p.mrp_minor) : '', 'Wholesale price': pp ? fromMinor(pp.price_minor) : '',
        'Cost price': fromMinor(p.cost_minor), Barcode: str(p.barcode), SKU: str(p.sku), Unit: str(p.unit) || 'pc', Stock: Math.round((S.get(p.ROWID) ?? []).reduce((n, s) => n + fromMilli(s.qty_milli), 0) * 1000) / 1000,
        'Low stock at': fromMilli(p.low_stock_milli), Sizes: (V.get(p.ROWID) ?? []).map((v) => `${str(v.name)}:${fromMinor(v.price_minor)}`).join(' | '),
        'Add-ons': (A.get(p.ROWID) ?? []).map((v) => `${str(v.name)}:${fromMinor(v.price_minor)}`).join(' | '), Veg: p.is_veg !== false, Active: p.is_active !== false, Photo: photo(p)?.cell ?? '',
      }
    }) },
    { name: 'Customers', rows: customers.filter((x) => x.is_active !== false).map((x) => ({
      Name: str(x.name), Mobile: str(x.phone), Email: str(x.email), Address: str(x.address), Notes: str(x.notes), 'Price list': wholesale && x.price_list_id === wholesale.ROWID ? 'wholesale' : 'retail',
      'OK with offers': x.marketing_opt_in !== false, Outstanding: fromMinor(dues.find((d) => d.customer_id === x.ROWID)?.due as number | undefined),
    })) },
    { name: 'Bills', rows: orders.map((o) => ({
      'Bill no': o.invoiceNumber ?? '', Order: o.number, Status: o.status, Type: o.type, Branch: branch(o.branchId), Customer: customer(o.customerId) || o.guest?.name || '',
      Subtotal: o.subtotal, Discount: o.discount, Tax: o.tax, 'Round off': o.roundOff, Total: o.total, Paid: o.paid, Balance: o.balance,
      Created: dt(o.createdAt), Billed: dt(o.billedAt), 'Made by': userName(o.createdBy), 'Cancel reason': o.cancelReason ?? '',
    })) },
    { name: 'Bill items', rows: orders.flatMap((o) => o.items.map((i) => ({ 'Bill no': o.invoiceNumber ?? o.number, Item: i.name, Size: i.variantName ?? '', 'Add-ons': i.addOns.map((a) => a.name).join(', '), Qty: i.qty, Unit: i.unit, Rate: i.unitPrice, 'Tax %': i.taxRate, Amount: r2(i.qty * i.unitPrice) }))) },
    { name: 'Payments', rows: payments.map((p) => ({ Date: dt(p.CREATEDTIME), Kind: nameOf(E.PaymentKind, p.kind), Method: method(p.method), Amount: fromMinor(p.amount_minor), Bill: (p.order_id && O.get(str(p.order_id))?.invoiceNumber) || '', Customer: customer(p.customer_id), Reference: str(p.reference), Voided: !!p.is_voided, Branch: branch(p.branch_id) })) },
    { name: 'Returns', rows: returns.flatMap((r) => (RI.get(r.ROWID) ?? []).map((l) => ({
      'Credit note': str(r.number), Date: dt(r.CREATEDTIME), Bill: str(r.invoice_number), Item: str(l.product_name), Qty: fromMilli(l.qty_milli), Amount: fromMinor(l.amount_minor), 'Back to stock': l.restock !== false,
      Reason: nameOrNull(E.ReturnReason, r.reason) ?? '', 'Due adjusted': fromMinor(r.due_adjusted_minor), Refunded: fromMinor(r.refunded_minor), 'Credit issued': fromMinor(r.credit_issued_minor), 'Credit left': fromMinor(r.credit_remaining_minor),
    }))) },
    { name: 'Expenses', rows: expenses.map((e) => {
      const cat = X.get(str(e.category_id))
      return { Date: dt(e.expense_date), Category: cat ? (nameOrNull(E.ExpenseKey, cat.system_key) ?? str(cat.name)) : '', Amount: fromMinor(e.amount_minor), Method: method(e.method), Notes: str(e.notes), Voided: !!e.is_voided, Branch: branch(e.branch_id) }
    }) },
    { name: 'Stock movements', rows: movements.map((m) => ({ Date: dt(m.CREATEDTIME), Item: product(m.product_id), Type: nameOf(E.StockReason, m.reason), Qty: fromMilli(m.qty_milli), 'Balance after': fromMilli(m.balance_milli), Note: str(m.note), Branch: branch(m.branch_id) })) },
    { name: 'Stock batches', rows: batches.map((x) => ({ Item: product(x.product_id), Batch: str(x.batch_no), Expiry: str(x.expiry_date), Qty: fromMilli(x.qty_left_milli), Received: fromMilli(x.qty_in_milli), Branch: branch(x.branch_id) })) },
    { name: 'Attendance', rows: attendance.map((a) => ({ Date: str(a.work_date), Staff: userName(a.user_id), Status: nameOf(E.AttendanceStatus, a.status), In: str(a.in_time), Out: str(a.out_time), Note: str(a.note), Branch: branch(a.branch_id) })) },
    { name: 'Salary', rows: salaries.map((x) => ({ Month: str(x.month), Staff: userName(x.user_id), Base: fromMinor(x.base_minor), Commission: fromMinor(x.commission_minor), Bonus: fromMinor(x.bonus_minor), Deduction: fromMinor(x.deduction_minor), Advance: fromMinor(x.advances_minor), 'Net paid': fromMinor(x.net_minor), Method: method(x.method), Paid: dt(x.CREATEDTIME) })) },
    { name: 'Advances', rows: advances.map((x) => ({ Date: str(x.given_on), Staff: userName(x.user_id), Amount: fromMinor(x.amount_minor), Method: method(x.method), Note: str(x.note), Recovered: !!x.salary_payment_id })) },
    { name: 'Tables', rows: tables.filter((x) => x.is_active !== false).map((x) => ({ Table: str(x.label), Floor: str(x.area) || 'Main', Seats: Number(x.seats ?? 4), Branch: branch(x.branch_id) })) },
    { name: 'WhatsApp messages', rows: wa.map((m) => ({ Date: dt(m.CREATEDTIME), Kind: nameOf(E.WaMessageKind, m.kind), To: str(m.to_number), Customer: customer(m.customer_id), Status: nameOf(E.WaMessageStatus, m.status), Message: str(m.body) })) },
    { name: 'Audit log', rows: logs.map((a) => ({ Date: dt(a.CREATEDTIME), User: userName(a.user_id), What: nameOrNull(E.AuditEntity, a.entity) ?? '', Action: nameOrNull(E.AuditAction, a.action) ?? '', Detail: str(a.detail) })) },
  ]
  if (forAdmin) out.push({ name: 'Subscription', rows: periods.map((p) => ({ Kind: nameOf(E.PeriodKind, p.kind), From: dt(p.start_at), To: dt(p.end_at), Months: p.months == null ? 'custom' : Number(p.months), Branches: Number(p.branches), Amount: fromMinor(p.amount_minor), Note: str(p.note) })) })
  const images = products.map((p) => photo(p)?.image).filter((x): x is { path: string; url: string } => !!x)
  return { businessName: str(b.name), exportedAt: c.now.toISOString(), tables: out, images }
}

const rowCount = (x: ExportBundle) => x.tables.reduce((n, t) => n + t.rows.length, 0)

define('admin', {
  exportCustomer: adminWrite('customers.edit', async (c, id: string) => {
    const a = c.requireAdmin()
    const r = await findBiz(c, id)
    const out = await exportTables(c, r.ROWID, true)
    await adminLog(c, a, 'export', { id: r.ROWID, name: str(r.name) }, `Exported ${rowCount(out)} rows, ${out.images.length} photos`)
    return out
  }, { tx: 'none' }), // a long read: no platform write lock while it runs
})

define('dataExport', {
  /** The owner downloads everything their business has (Settings → Audit & Data). Not in support view. */
  mine: userRead(async (c) => {
    if (c.s.support) throw new ApiError(SUPPORT_MESSAGE, 403, 'SUPPORT_VIEW')
    const out = await exportTables(c, c.businessId, false)
    await audit(c, 'settings', null, 'export', `Data export: ${rowCount(out)} rows, ${out.images.length} photos`)
    return out
  }, { perm: 'settings.manage' }),
})
