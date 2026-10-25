// Suppliers, purchase bills (stock in + input GST) and supplier payments (suppliers, purchases,
// purchase_items, supplier_payments). Same rules as the app's mock API (src/core/purchases.ts).
import { cleanPartyGst, isInterState, shopStateOf } from '@/core/gst'
import { planPurchase, SUPPLIER_PAY_METHODS, supplierLedger, type PurchaseInput, type SupplierPayMethod } from '@/core/purchases'
import { r2 } from '@/core/pricing'
import type { Purchase, Supplier, SupplierPayment } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import type { Row } from '../db/types'
import { DEFAULT_SEQ } from '../domain/business'
import { clientUuid, selectIn } from '../domain/orders'
import { moveStock, stockOf, stockProduct } from '../domain/stock'
import { audit, bizDay, code, E, fromMilli, fromMinor, isId, keyPart, nameOf, nextNumber, own, str, strOrNull, toBp, toMilli, toMinor, fromBp } from '../domain/util'
import { cleanPhone } from './business'
import { categoryIdFor } from './ops'

const perm = { perm: 'inventory.manage' } as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

function supplierFrom(r: Row, stats?: { balance: number; purchases: number; last: string | null }): Supplier {
  return {
    id: r.ROWID, businessId: str(r.business_id), name: str(r.name), phone: str(r.phone), gstin: str(r.gstin), stateCode: strOrNull(r.state_code),
    address: str(r.address), notes: str(r.notes), openingBalance: fromMinor(r.opening_balance_minor), active: r.is_active !== false,
    ...(stats ? { balance: stats.balance, purchases: stats.purchases, lastPurchaseOn: stats.last } : {}),
  }
}
function purchaseFrom(r: Row, items: Row[], supplierName: string): Purchase {
  const total = fromMinor(r.total_minor), paid = fromMinor(r.paid_minor)
  return {
    id: r.ROWID, number: str(r.number), businessId: str(r.business_id), branchId: str(r.branch_id), supplierId: strOrNull(r.supplier_id), supplierName,
    supplierBillNo: str(r.supplier_bill_no), date: str(r.purchase_date),
    lines: items.filter((i) => str(i.purchase_id) === r.ROWID).sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map((i) => ({
      id: i.ROWID, productId: str(i.product_id), name: str(i.product_name), unit: str(i.unit) || 'pc', hsn: str(i.hsn_code), qty: fromMilli(i.qty_milli),
      cost: fromMinor(i.cost_minor), taxRate: fromBp(i.tax_bp), taxable: fromMinor(i.taxable_minor), tax: fromMinor(i.tax_minor),
      ...(i.batch_no ? { batchNo: str(i.batch_no) } : {}), ...(i.expiry_date ? { expiry: str(i.expiry_date) } : {}),
    })),
    taxable: fromMinor(r.subtotal_minor), tax: fromMinor(r.tax_minor), igst: !!r.is_igst, roundOff: fromMinor(r.round_off_minor), total, paid,
    balance: r2(total - paid), status: nameOf(E.PurchaseStatus, r.status) === 'void' ? 'void' : 'final', note: str(r.note), voidReason: strOrNull(r.void_reason),
    createdAt: r.CREATEDTIME, createdBy: str(r.created_by), updatedAt: r.MODIFIEDTIME, updatedBy: str(r.created_by),
  }
}
function paymentFrom(r: Row): SupplierPayment {
  return {
    id: r.ROWID, supplierId: str(r.supplier_id), purchaseId: strOrNull(r.purchase_id), date: str(r.paid_on), method: nameOf(E.PayMethod, r.method) as SupplierPayMethod,
    amount: fromMinor(r.amount_minor), reference: str(r.reference), note: str(r.note), voided: !!r.is_voided, createdAt: r.CREATEDTIME,
  }
}

/** Balance per supplier: opening + final purchase bills − payments (not voided). */
async function balances(c: Ctx, suppliers: Row[]) {
  const ids = suppliers.map((s) => s.ROWID)
  if (!ids.length) return new Map<string, { balance: number; purchases: number; last: string | null }>()
  const [bills, pays] = await Promise.all([
    selectIn(c, 'purchases', 'supplier_id', ids, { business_id: c.businessId, status: E.PurchaseStatus.final }),
    selectIn(c, 'supplier_payments', 'supplier_id', ids, { business_id: c.businessId, is_voided: false }),
  ])
  return new Map(suppliers.map((s) => {
    const mine = bills.filter((b) => str(b.supplier_id) === s.ROWID)
    const owed = Number(s.opening_balance_minor ?? 0) + mine.reduce((a, b) => a + Number(b.total_minor), 0) - pays.filter((p) => str(p.supplier_id) === s.ROWID).reduce((a, p) => a + Number(p.amount_minor), 0)
    return [s.ROWID, { balance: fromMinor(owed), purchases: mine.length, last: mine.map((b) => str(b.purchase_date)).sort().pop() ?? null }]
  }))
}

async function loadPurchases(c: Ctx, rows: Row[]) {
  if (!rows.length) return []
  const [items, sups] = await Promise.all([
    selectIn(c, 'purchase_items', 'purchase_id', rows.map((r) => r.ROWID)),
    selectIn(c, 'suppliers', 'ROWID', [...new Set(rows.map((r) => str(r.supplier_id)).filter(Boolean))], { business_id: c.businessId }),
  ])
  return rows.map((r) => purchaseFrom(r, items, str(sups.find((s) => s.ROWID === str(r.supplier_id))?.name)))
}

async function pay(c: Ctx, supplierId: string, input: { amount: number; method: SupplierPayMethod; date?: string; reference?: string; note?: string }, purchaseId: string | null, suffix: string) {
  const amount = r2(Number(input.amount))
  if (!(amount > 0)) throw new ApiError('Enter the amount paid')
  if (!SUPPLIER_PAY_METHODS.includes(input.method)) throw new ApiError('Choose how it was paid')
  const day = input.date || bizDay(c)
  if (!DAY.test(day) || day > bizDay(c)) throw new ApiError('Enter a valid payment date')
  const uuid = clientUuid(c, suffix)
  const again = await c.db.first('supplier_payments', { client_uuid: uuid })
  if (again) return again
  const supplier = await c.db.get('suppliers', supplierId)
  const row = await c.db.insert('supplier_payments', {
    business_id: c.businessId, branch_id: c.writeBranch({ fallback: true }), supplier_id: supplierId, purchase_id: purchaseId, client_uuid: uuid,
    method: code(E.PayMethod, input.method), amount_minor: toMinor(amount), paid_on: day, reference: String(input.reference ?? '').trim().slice(0, 80) || null,
    note: String(input.note ?? '').trim().slice(0, 255) || null, is_voided: false, created_by: c.actorId,
  })
  // Money that left the shop: also an expense ("Purchase"), so Daily Income matches the cash paid out.
  // The bill itself isn't an expense — on credit nothing is paid yet.
  await c.db.insert('expenses', {
    business_id: c.businessId, branch_id: str(row.branch_id), category_id: await categoryIdFor(c, 'purchase'),
    expense_date: day === bizDay(c) ? c.now.toISOString() : `${day}T06:30:00.000Z`, amount_minor: toMinor(amount), method: code(E.PayMethod, input.method),
    notes: `Paid ${str(supplier?.name)}${input.reference ? ` · ${String(input.reference).trim()}` : ''}`.slice(0, 255),
    ref_type: E.ExpenseRef.supplier_payment, ref_id: row.ROWID, is_voided: false, created_by: c.actorId,
  })
  return row
}

define('suppliers', {
  list: userRead(async (c) => {
    const rows = await c.db.select('suppliers', { where: { business_id: c.businessId }, orderBy: [['name', 'ASC']] })
    const stats = await balances(c, rows)
    return rows.map((r) => supplierFrom(r, stats.get(r.ROWID)))
  }, perm),

  save: userWrite(async (c, input: Partial<Supplier> & { name: string }) => {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim()
    if (!name) throw new ApiError('Enter the supplier’s name')
    let gst
    try { gst = cleanPartyGst(input) } catch (e) { throw new ApiError((e as Error).message) }
    const opening = Number(input.openingBalance ?? 0)
    if (!Number.isFinite(opening) || Math.abs(opening) > 1e9) throw new ApiError('Enter a valid opening balance')
    const nameKey = `${c.businessId}:${keyPart(name)}`
    const dup = await c.db.first('suppliers', { business_id: c.businessId, name_key: nameKey })
    if (dup && dup.ROWID !== input.id) throw new ApiError(`A supplier called ${name} already exists`)
    const data = {
      name: name.slice(0, 150), name_key: nameKey, phone: cleanPhone(input.phone ?? '', c.business.defaultCountry) || null, gstin: gst.gstin, state_code: gst.stateCode,
      address: String(input.address ?? '').trim().slice(0, 255) || null, notes: String(input.notes ?? '').trim().slice(0, 255) || null,
      opening_balance_minor: toMinor(r2(opening)), is_active: input.active !== false,
    }
    const row = input.id ? await c.db.update('suppliers', (await own(c, 'suppliers', input.id, 'Supplier not found')).ROWID, data) : await c.db.insert('suppliers', { business_id: c.businessId, ...data })
    await audit(c, 'supplier', row.ROWID, input.id ? 'update' : 'create', name)
    return supplierFrom(row, (await balances(c, [row])).get(row.ROWID))
  }, perm),

  /** Statement: opening balance, purchase bills and payments with the running balance. */
  ledger: userRead(async (c, supplierId: string) => {
    const s = await own(c, 'suppliers', supplierId, 'Supplier not found')
    const [bills, pays] = await Promise.all([
      c.db.select('purchases', { where: { business_id: c.businessId, supplier_id: s.ROWID }, orderBy: [['purchase_date', 'ASC']] }),
      c.db.select('supplier_payments', { where: { business_id: c.businessId, supplier_id: s.ROWID }, orderBy: [['paid_on', 'ASC']] }),
    ])
    const purchases = await loadPurchases(c, bills)
    const payments = pays.map(paymentFrom)
    const { rows, balance } = supplierLedger(fromMinor(s.opening_balance_minor), purchases, payments)
    return { supplier: supplierFrom(s, { balance, purchases: purchases.filter((p) => p.status === 'final').length, last: purchases.map((p) => p.date).sort().pop() ?? null }), rows, balance, purchases, payments }
  }, perm),

  /** Money paid to the supplier against their balance. */
  pay: userWrite(async (c, supplierId: string, input: { amount: number; method: SupplierPayMethod; date?: string; reference?: string; note?: string }) => {
    const s = await own(c, 'suppliers', supplierId, 'Supplier not found')
    const row = await pay(c, s.ROWID, input, null, ':sp')
    await audit(c, 'supplier', s.ROWID, 'update', `paid ${input.amount} via ${input.method}`)
    return paymentFrom(row)
  }, perm),

  voidPayment: userWrite(async (c, paymentId: string, reason: string) => {
    const p = await own(c, 'supplier_payments', paymentId, 'Payment not found')
    if (p.is_voided) throw new ApiError('This payment is already voided')
    if (!String(reason ?? '').trim()) throw new ApiError('Enter a reason')
    await c.db.update('supplier_payments', p.ROWID, { is_voided: true, voided_at: c.now.toISOString(), note: `${str(p.note)} [void: ${String(reason).trim()}]`.trim().slice(0, 255) })
    const exp = await c.db.select('expenses', { where: { business_id: c.businessId, ref_type: E.ExpenseRef.supplier_payment, ref_id: p.ROWID } })
    if (exp.length) await c.db.updateMany('expenses', exp.map((e) => ({ ROWID: e.ROWID, is_voided: true })))
    await audit(c, 'supplier', str(p.supplier_id), 'void', `payment ${fromMinor(p.amount_minor)}: ${reason}`.slice(0, 250))
  }, perm),
})

define('purchases', {
  list: userRead(async (c, from?: string, to?: string) => {
    const where = { business_id: c.businessId, branch_id: { in: c.scope() }, ...(from && DAY.test(from) ? { purchase_date: { gte: from, ...(to && DAY.test(to) ? { lte: to } : {}) } } : {}) }
    const rows = await c.db.select('purchases', { where, orderBy: [['purchase_date', 'DESC'], ['ROWID', 'DESC']], limit: 1000 })
    return loadPurchases(c, rows)
  }, perm),

  get: userRead(async (c, id: string) => {
    const r = await own(c, 'purchases', id, 'Purchase not found')
    return (await loadPurchases(c, [r]))[0]
  }, perm),

  /**
   * A supplier's bill: stock in (with batch / expiry), cost price updated, input GST recorded, and what was
   * paid now. A re-sent request returns the bill already saved.
   */
  create: userWrite(async (c, input: PurchaseInput) => {
    const uuid = clientUuid(c, ':pu')
    const again = await c.db.first('purchases', { business_id: c.businessId, client_uuid: uuid })
    if (again) return (await loadPurchases(c, [again]))[0]
    const supplier = await own(c, 'suppliers', input?.supplierId, 'Choose the supplier')
    const ids = [...new Set((input.lines ?? []).map((l) => String(l.productId)).filter(isId))]
    const prows = await selectIn(c, 'products', 'ROWID', ids, { business_id: c.businessId })
    const products = new Map(prows.map((p) => [p.ROWID, { name: str(p.name), unit: str(p.unit) || 'pc', trackExpiry: !!p.track_batches, hsn: str(p.hsn_code) }]))
    let plan
    try { plan = planPurchase(input, products, bizDay(c)) } catch (e) { throw new ApiError((e as Error).message) }
    const igst = isInterState(shopStateOf(c.business), strOrNull(supplier.state_code))
    const branchId = c.writeBranch()
    const num = await nextNumber(c.db, c.businessId, null, 'purchase', DEFAULT_SEQ.purchase)
    const row = await c.db.insert('purchases', {
      business_id: c.businessId, branch_id: branchId, supplier_id: supplier.ROWID, number: num.text, supplier_bill_no: plan.supplierBillNo || null, purchase_date: plan.date,
      subtotal_minor: toMinor(plan.taxable), tax_minor: toMinor(plan.tax), total_minor: toMinor(plan.total), paid_minor: toMinor(plan.paid), round_off_minor: toMinor(plan.roundOff),
      status: E.PurchaseStatus.final, note: plan.note || null, client_uuid: uuid, is_igst: igst, created_by: c.actorId,
    })
    const items = await c.db.insertMany('purchase_items', plan.lines.map((l, k) => ({
      business_id: c.businessId, purchase_id: row.ROWID, product_id: l.productId, product_name: l.name.slice(0, 150), unit: l.unit.slice(0, 10), hsn_code: l.hsn || null,
      qty_milli: toMilli(l.qty), cost_minor: toMinor(l.cost), tax_bp: toBp(l.taxRate), taxable_minor: toMinor(l.taxable), tax_minor: toMinor(l.tax),
      batch_no: l.batchNo ?? null, expiry_date: l.expiry ?? null, sort_order: k,
    })))
    // Stock in, and the latest cost price on the item (HSN too, when the item had none).
    for (const [k, l] of plan.lines.entries()) {
      let p = prows.find((x) => x.ROWID === l.productId)!
      p = await c.db.update('products', p.ROWID, { cost_minor: toMinor(l.cost), track_stock: true, ...(l.hsn && !p.hsn_code ? { hsn_code: l.hsn } : {}) })
      await moveStock(c, stockProduct(p), branchId, l.qty, 'purchase', { note: `Purchase ${num.text}${plan.supplierBillNo ? ` · bill ${plan.supplierBillNo}` : ''}`, refType: 'purchase', refId: row.ROWID, batch: l.expiry || l.batchNo ? { batchNo: l.batchNo, expiry: l.expiry } : undefined })
      if (l.expiry || l.batchNo) {
        const bt = await c.db.select('stock_batches', { where: { business_id: c.businessId, branch_id: branchId, product_id: l.productId, purchase_item_id: null } })
        const mine = bt.filter((b) => str(b.batch_no) === (l.batchNo ?? '') && str(b.expiry_date) === (l.expiry ?? ''))
        if (mine.length) await c.db.updateMany('stock_batches', mine.map((b) => ({ ROWID: b.ROWID, purchase_item_id: items[k].ROWID, cost_minor: toMinor(l.cost) })))
      }
    }
    if (plan.paid > 0) await pay(c, supplier.ROWID, { amount: plan.paid, method: input.method, date: plan.date, reference: input.reference }, row.ROWID, ':pp')
    await audit(c, 'purchase', row.ROWID, 'create', `${num.text} · ${str(supplier.name)} · ${plan.total}`.slice(0, 250), branchId)
    return (await loadPurchases(c, [row]))[0]
  }, perm),

  /**
   * Cancel a purchase bill entered by mistake: the stock goes back out (only if it is still on the shelf).
   * Payments already made stay on the supplier's statement as an advance.
   */
  void: userWrite(async (c, id: string, reason: string) => {
    const r = await own(c, 'purchases', id, 'Purchase not found')
    if (Number(r.status) === E.PurchaseStatus.void) throw new ApiError('This purchase is already voided')
    if (!String(reason ?? '').trim()) throw new ApiError('Enter a reason')
    const items = await c.db.select('purchase_items', { where: { purchase_id: r.ROWID } })
    const prows = await selectIn(c, 'products', 'ROWID', items.map((i) => str(i.product_id)), { business_id: c.businessId })
    const branchId = str(r.branch_id)
    for (const i of items) {
      const have = await stockOf(c, str(i.product_id), branchId)
      if (have + 1e-9 < fromMilli(i.qty_milli)) throw new ApiError(`${str(i.product_name)}: only ${have} left in stock — the purchase can’t be voided`)
    }
    if (!(await c.db.updateIfVersion('purchases', r.ROWID, Number(r.row_version), { status: E.PurchaseStatus.void, void_reason: String(reason).trim().slice(0, 255), voided_at: c.now.toISOString() }))) {
      throw new ApiError('This purchase was just changed on another device. Please try again.', 409, 'CONFLICT')
    }
    for (const i of items) {
      const p = prows.find((x) => x.ROWID === str(i.product_id))
      if (p) await moveStock(c, stockProduct(p), branchId, -fromMilli(i.qty_milli), 'adjustment', { note: `Purchase ${str(r.number)} voided`, refType: 'purchase', refId: r.ROWID })
    }
    await audit(c, 'purchase', r.ROWID, 'void', `${str(r.number)}: ${reason}`.slice(0, 250), branchId)
    return (await loadPurchases(c, [await c.db.get('purchases', r.ROWID) as Row]))[0]
  }, perm),
})
