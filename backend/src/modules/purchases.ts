// Suppliers, purchase bills (stock in + input GST) and supplier payments (suppliers, purchases,
// purchase_items, supplier_payments). Same rules as the app's mock API (src/core/purchases.ts).
import { cleanPartyGst, isInterState, shopStateOf } from '@/core/gst'
import { planPurchase, SUPPLIER_PAY_METHODS, supplierLedger, type PurchaseInput, type SupplierPayMethod } from '@/core/purchases'
import { r2 } from '@/core/pricing'
import { idBefore } from '@/core/paging'
import type { Purchase, Supplier, SupplierPayment } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import type { NewRow, Row, Where } from '../db/types'
import { DEFAULT_SEQ } from '../domain/business'
import { clientUuid, selectIn } from '../domain/orders'
import { moveStockMany, stockProduct } from '../domain/stock'
import { audit, bizDay, code, cursorArg, E, fromMilli, fromMinor, isId, keyPart, nameOf, nextNumber, own, str, strOrNull, toBp, toMilli, toMinor, fromBp, money, mayUseBranch, assertBranch } from '../domain/util'
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
  // Each bill's lines and its supplier by id (one pass each), not a search of every line for every bill.
  const linesOf = new Map<string, Row[]>()
  for (const i of items) { const k = str(i.purchase_id); const l = linesOf.get(k); if (l) l.push(i); else linesOf.set(k, [i]) }
  const supName = new Map(sups.map((x) => [x.ROWID, str(x.name)]))
  return rows.map((r) => purchaseFrom(r, linesOf.get(r.ROWID) ?? [], supName.get(str(r.supplier_id)) ?? ''))
}

async function pay(c: Ctx, supplierId: string, input: { amount: number; method: SupplierPayMethod; date?: string; reference?: string; note?: string }, purchaseId: string | null, suffix: string) {
  const amount = money(input?.amount, 'Amount paid', { positive: true })
  if (!SUPPLIER_PAY_METHODS.includes(input.method)) throw new ApiError('Choose how it was paid')
  const day = input.date || bizDay(c)
  if (!DAY.test(day) || day > bizDay(c)) throw new ApiError('Enter a valid payment date')
  const uuid = clientUuid(c, suffix)
  const again = await c.db.first('supplier_payments', { business_id: c.businessId, client_uuid: uuid })
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
    const [allBills, allPays] = await Promise.all([
      c.db.select('purchases', { where: { business_id: c.businessId, supplier_id: s.ROWID }, orderBy: [['purchase_date', 'ASC']] }),
      c.db.select('supplier_payments', { where: { business_id: c.businessId, supplier_id: s.ROWID }, orderBy: [['paid_on', 'ASC']] }),
    ])
    // Staff limited to some branches see those branches' bills and payments only.
    const bills = allBills.filter((r) => mayUseBranch(c, r.branch_id)), pays = allPays.filter((r) => mayUseBranch(c, r.branch_id))
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
    assertBranch(c, p.branch_id, 'Payment not found')
    if (p.is_voided) throw new ApiError('This payment is already voided')
    if (!String(reason ?? '').trim()) throw new ApiError('Enter a reason')
    await c.db.update('supplier_payments', p.ROWID, { is_voided: true, voided_at: c.now.toISOString(), note: `${str(p.note)} [void: ${String(reason).trim()}]`.trim().slice(0, 255) })
    const exp = await c.db.select('expenses', { where: { business_id: c.businessId, ref_type: E.ExpenseRef.supplier_payment, ref_id: p.ROWID } })
    if (exp.length) await c.db.updateMany('expenses', exp.map((e) => ({ ROWID: e.ROWID, is_voided: true })))
    await audit(c, 'supplier', str(p.supplier_id), 'void', `payment ${fromMinor(p.amount_minor)}: ${reason}`.slice(0, 250))
  }, perm),
})

define('purchases', {
  /**
   * The Purchases screen page by page: 50 bills in the list's order (newest bill date first, then the database's id
   * order), each with its lines; `count` for the pager; `month` = that month's final bills added up (the cards).
   * `q` searches purchase no., supplier's bill no. and supplier name.
   */
  page: userRead(async (c, filter: { q?: string; month?: string } = {}, before?: unknown, limit = 50) => {
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50))
    const base: Where = { business_id: c.businessId, branch_id: { in: c.scope() } }
    const order: [string, 'ASC' | 'DESC'][] = [['purchase_date', 'DESC'], ['ROWID', 'DESC']]
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(filter?.month ?? '')) ? String(filter!.month) : bizDay(c).slice(0, 7)
    const [y, mm] = month.split('-').map(Number)
    const nextMonth = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`
    const q = String(filter?.q ?? '').trim().slice(0, 60)
    const cur = cursorArg(before)
    const [monthRow] = await c.db.aggregate('purchases', { where: { ...base, status: E.PurchaseStatus.final, purchase_date: { gte: `${month}-01`, lt: `${nextMonth}-01` } }, fns: { n: ['COUNT', 'ROWID'], t: ['SUM', 'total_minor'], g: ['SUM', 'tax_minor'], p: ['SUM', 'paid_minor'] } })
    const monthTotals = { total: fromMinor(monthRow?.t), tax: fromMinor(monthRow?.g), unpaid: fromMinor(Number(monthRow?.t ?? 0) - Number(monthRow?.p ?? 0)), bills: Number(monthRow?.n ?? 0) }
    let rows: Row[], count: number
    if (q) {
      // A search is a short list: every match, newest first (at most 200 per field).
      const sups = await c.db.select('suppliers', { where: { business_id: c.businessId, name: { contains: q } }, limit: 200 })
      const alts: Where[] = [{ number: { contains: q } }, { supplier_bill_no: { contains: q } }, ...(sups.length ? [{ supplier_id: { in: sups.map((x) => x.ROWID) } }] : [])]
      const found = await Promise.all(alts.map((w) => c.db.select('purchases', { where: { ...base, ...w }, orderBy: order, limit: 200 })))
      const all = [...new Map(found.flat().map((r) => [r.ROWID, r])).values()]
        .sort((a, b) => (str(a.purchase_date) < str(b.purchase_date) ? 1 : str(a.purchase_date) > str(b.purchase_date) ? -1 : idBefore(a.ROWID, b.ROWID) ? 1 : -1))
      count = all.length
      const k = cur ? all.findIndex((r) => r.ROWID === cur.id) : -1
      rows = (k >= 0 ? all.slice(k + 1) : cur ? [] : all).slice(0, n + 1)
    } else {
      const [cnt] = await c.db.aggregate('purchases', { where: base, fns: { n: ['COUNT', 'ROWID'] } })
      count = Number(cnt?.n ?? 0)
      if (!cur) rows = await c.db.select('purchases', { where: base, orderBy: order, limit: n + 1 })
      else {
        // The rest of the cursor's date (in the database's own order), then older dates.
        const same = await c.db.select('purchases', { where: { ...base, purchase_date: cur.at.slice(0, 10) }, orderBy: order })
        const k = same.findIndex((r) => r.ROWID === cur.id)
        const rest = k >= 0 ? same.slice(k + 1) : same.filter((r) => idBefore(r.ROWID, cur.id))
        const older = rest.length > n ? [] : await c.db.select('purchases', { where: { ...base, purchase_date: { lt: cur.at.slice(0, 10) } }, orderBy: order, limit: n + 1 - rest.length })
        rows = [...rest, ...older]
      }
    }
    const pageRows = rows.slice(0, n)
    const last = pageRows[n - 1]
    return {
      rows: await loadPurchases(c, pageRows),
      next: rows.length > n && last ? { at: str(last.purchase_date), id: last.ROWID } : null,
      count, month: monthTotals,
    }
  }, perm),

  get: userRead(async (c, id: string) => {
    const r = await own(c, 'purchases', id, 'Purchase not found')
    assertBranch(c, r.branch_id, 'Purchase not found')
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
    if (input.lines != null && !Array.isArray(input.lines)) throw new ApiError('Add at least one item')
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
    // The latest cost price on each item (HSN too, when the item had none): one write for all of them.
    const prowById = new Map(prows.map((p) => [p.ROWID, p]))
    const changes = new Map<string, NewRow & { ROWID: string }>()
    for (const l of plan.lines) {
      const p = prowById.get(l.productId)!
      changes.set(p.ROWID, { ...changes.get(p.ROWID), ROWID: p.ROWID, cost_minor: toMinor(l.cost), track_stock: true, ...(l.hsn && !p.hsn_code ? { hsn_code: l.hsn } : {}) })
    }
    await c.db.updateMany('products', [...changes.values()])
    // Stock in: every line in one go (plain items in one round trip; expiry items batch by batch, as before).
    const note = `Purchase ${num.text}${plan.supplierBillNo ? ` · bill ${plan.supplierBillNo}` : ''}`
    await moveStockMany(c, plan.lines.map((l) => ({
      p: stockProduct({ ...prowById.get(l.productId)!, track_stock: true }), branchId, qty: l.qty, reason: 'purchase' as const,
      opts: { note, refType: 'purchase' as const, refId: row.ROWID, batch: l.expiry || l.batchNo ? { batchNo: l.batchNo, expiry: l.expiry } : undefined },
    })))
    // Each new batch points at its bill line (cost of that batch): one read for all, linked in line order.
    const batchLines = [...plan.lines.entries()].filter(([, l]) => l.expiry || l.batchNo)
    if (batchLines.length) {
      const open = await c.db.select('stock_batches', { where: { business_id: c.businessId, branch_id: branchId, product_id: { in: [...new Set(batchLines.map(([, l]) => l.productId))] }, purchase_item_id: null } })
      const links: (NewRow & { ROWID: string })[] = []
      const linked = new Set<string>()
      for (const [k, l] of batchLines) {
        const mine = open.filter((b) => !linked.has(b.ROWID) && str(b.product_id) === l.productId && str(b.batch_no) === (l.batchNo ?? '') && str(b.expiry_date) === (l.expiry ?? ''))
        for (const b of mine) { linked.add(b.ROWID); links.push({ ROWID: b.ROWID, purchase_item_id: items[k].ROWID, cost_minor: toMinor(l.cost) }) }
      }
      if (links.length) await c.db.updateMany('stock_batches', links)
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
    assertBranch(c, r.branch_id, 'Purchase not found')
    if (Number(r.status) === E.PurchaseStatus.void) throw new ApiError('This purchase is already voided')
    if (!String(reason ?? '').trim()) throw new ApiError('Enter a reason')
    const items = await c.db.select('purchase_items', { where: { purchase_id: r.ROWID } })
    const prows = await selectIn(c, 'products', 'ROWID', items.map((i) => str(i.product_id)), { business_id: c.businessId })
    const branchId = str(r.branch_id)
    // Still on the shelf? One read of the branch's stock for all the bill's items.
    const stock = items.length ? await c.db.select('branch_stock', { where: { business_id: c.businessId, branch_id: branchId, product_id: { in: [...new Set(items.map((i) => str(i.product_id)))] } } }) : []
    const have = new Map(stock.map((b) => [str(b.product_id), fromMilli(b.qty_milli)]))
    for (const i of items) {
      const left = have.get(str(i.product_id)) ?? 0
      if (left + 1e-9 < fromMilli(i.qty_milli)) throw new ApiError(`${str(i.product_name)}: only ${left} left in stock — the purchase can’t be voided`)
    }
    if (!(await c.db.updateIfVersion('purchases', r.ROWID, Number(r.row_version), { status: E.PurchaseStatus.void, void_reason: String(reason).trim().slice(0, 255), voided_at: c.now.toISOString() }))) {
      throw new ApiError('This purchase was just changed on another device. Please try again.', 409, 'CONFLICT')
    }
    // Stock back out: all lines in one go.
    const prowById = new Map(prows.map((p) => [p.ROWID, p]))
    await moveStockMany(c, items.filter((i) => prowById.has(str(i.product_id))).map((i) => ({
      p: stockProduct(prowById.get(str(i.product_id))!), branchId, qty: -fromMilli(i.qty_milli), reason: 'adjustment' as const,
      opts: { note: `Purchase ${str(r.number)} voided`, refType: 'purchase' as const, refId: r.ROWID },
    })))
    await audit(c, 'purchase', r.ROWID, 'void', `${str(r.number)}: ${reason}`.slice(0, 250), branchId)
    return (await loadPurchases(c, [await c.db.get('purchases', r.ROWID) as Row]))[0]
  }, perm),
})
