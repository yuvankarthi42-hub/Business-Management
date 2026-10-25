// Stock (movements, adjustments, batches & expiry) and expenses. Same rules as the app's mock API.
import { r2 } from '@/core/pricing'
import type { Expense, ExpenseCategory, PaymentMethod, StockBatch, StockMovement, StockMovementType } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row, type Where } from '../db/types'
import { loadProducts, canSeeCost } from '../domain/catalog'
import { moveStock, stockOf, stockProduct, writeOffBatch, type BatchInput } from '../domain/stock'
import { audit, bizDay, code, E, fromMilli, fromMinor, isId, nameOf, nameOrNull, own, str, strOrNull, toMilli, toMinor } from '../domain/util'

const inScope = (c: Ctx): Where => ({ business_id: c.businessId, branch_id: { in: c.scope() } })
const isoArg = (v: unknown, what = 'Choose a date range') => { const d = new Date(String(v)); if (v == null || Number.isNaN(d.getTime())) throw new ApiError(what); return d.toISOString() }

// ---------- stock ----------
const MOVE_TYPES: StockMovementType[] = ['opening', 'purchase', 'sale', 'damage', 'wastage', 'adjustment', 'return']

/** The table has a few reasons the app doesn't show on their own (expired, transfers) — shown as the nearest app type. */
function movementType(reason: Row['reason']): StockMovementType {
  const n = nameOf(E.StockReason, reason)
  if (n === 'expired') return 'wastage'
  if (n === 'transfer_in' || n === 'transfer_out') return 'adjustment'
  return n
}
export function movementFrom(r: Row): StockMovement {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), productId: str(r.product_id), type: movementType(r.reason),
    qty: fromMilli(r.qty_milli), balanceAfter: fromMilli(r.balance_milli), refId: strOrNull(r.ref_id), note: str(r.note),
    createdAt: r.CREATEDTIME, createdBy: str(r.created_by), updatedAt: r.MODIFIEDTIME, updatedBy: str(r.created_by),
  }
}
export function batchFrom(r: Row): StockBatch {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), productId: str(r.product_id), batchNo: str(r.batch_no), expiry: str(r.expiry_date),
    qty: fromMilli(r.qty_left_milli), receivedQty: fromMilli(r.qty_in_milli), createdAt: r.CREATEDTIME, createdBy: '', updatedAt: r.MODIFIEDTIME, updatedBy: '',
  }
}
const dayMs = (k: string) => Date.parse(`${k}T00:00:00Z`)

// ---------- expense categories ----------
const KEYS = Object.keys(E.ExpenseKey) as ExpenseCategory[]
const label = (k: string) => k.charAt(0).toUpperCase() + k.slice(1)

/** The business's row for one of the app's fixed expense heads; created the first time it's used. */
export async function categoryIdFor(c: Ctx, key: ExpenseCategory): Promise<string> {
  const sys = code(E.ExpenseKey, key)
  const hit = await c.db.first('expense_categories', { business_id: c.businessId, system_key: sys })
  if (hit) return hit.ROWID
  const uniq = `${c.businessId}:${key}`
  try {
    return (await c.db.insert('expense_categories', { business_id: c.businessId, name: label(key), system_key: sys, is_active: true, uniq_key: uniq })).ROWID
  } catch (e) {
    // Another request created it at the same moment (or a custom head already has that name).
    if (!(e instanceof DuplicateError)) throw e
    const again = await c.db.first('expense_categories', { uniq_key: uniq })
    if (!again) throw e
    if (again.system_key == null) await c.db.update('expense_categories', again.ROWID, { system_key: sys })
    return again.ROWID
  }
}
/** category ROWID → the app's category name. Custom heads (no system key) show as 'other'. */
export async function categoryNames(c: Ctx) {
  const rows = await c.db.select('expense_categories', { where: { business_id: c.businessId } })
  const m = new Map(rows.map((r) => [r.ROWID, (nameOrNull(E.ExpenseKey, r.system_key) ?? 'other') as ExpenseCategory]))
  return (id: Row['category_id']) => m.get(str(id)) ?? 'other'
}
export function expenseFrom(r: Row, cat: (id: Row['category_id']) => ExpenseCategory): Expense {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), date: str(r.expense_date), category: cat(r.category_id),
    amount: fromMinor(r.amount_minor), method: nameOf(E.PayMethod, r.method) as PaymentMethod, notes: str(r.notes), voided: !!r.is_voided,
    ...(Number(r.ref_type) === E.ExpenseRef.supplier_payment ? { supplierPaymentId: str(r.ref_id) } : {}),
    createdAt: r.CREATEDTIME, createdBy: str(r.created_by), updatedAt: r.MODIFIEDTIME, updatedBy: str(r.created_by),
  }
}
const cleanMethod = (m: unknown): PaymentMethod => {
  const v = (m ?? 'cash') as PaymentMethod
  if (!['cash', 'upi', 'card', 'bank'].includes(v)) throw new ApiError('Choose how it was paid')
  return v
}
const cleanCategory = (k: unknown): ExpenseCategory => {
  if (!KEYS.includes(k as ExpenseCategory)) throw new ApiError('Choose a category')
  return k as ExpenseCategory
}

define('inventory', {
  movements: userRead(async (c, productId?: string) => {
    if (productId && !isId(productId)) return []
    const rows = await c.db.select('stock_movements', { where: { ...inScope(c), ...(productId ? { product_id: productId } : {}) }, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: 3000 })
    return rows.map(movementFrom)
  }),

  /** Stock in / out by hand. Purchases with a cost are also booked as a 'purchase' expense. */
  adjust: userWrite(async (c, productId: string, type: StockMovementType, qty: number, note: string, cost?: number, batch?: BatchInput) => {
    if (!MOVE_TYPES.includes(type)) throw new ApiError('Choose the type of stock change')
    const n = Number(qty)
    if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new ApiError('Enter a valid quantity')
    let p = await own(c, 'products', productId, 'Product not found')
    // Adding stock to an item switches stock tracking on (like the app).
    if (!p.track_stock) p = await c.db.update('products', p.ROWID, { track_stock: true })
    const signed = type === 'purchase' || type === 'opening' || type === 'return' ? Math.abs(n) : type === 'adjustment' ? n : -Math.abs(n)
    const branchId = c.writeBranch()
    if (toMilli(await stockOf(c, p.ROWID, branchId)) + toMilli(signed) < 0) throw new ApiError('Stock cannot go below zero')
    if (p.track_batches && signed > 0 && (type === 'purchase' || type === 'opening') && !batch?.expiry) throw new ApiError('Enter the expiry date for this batch')
    if (batch?.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(batch.expiry)) throw new ApiError('Expiry date is not valid')
    const text = String(note ?? '').slice(0, 200)
    await moveStock(c, stockProduct(p), branchId, signed, type, { note: text, batch: signed > 0 ? batch : undefined })
    if (type === 'purchase' && cost && Number(cost) > 0) {
      await c.db.insert('expenses', {
        business_id: c.businessId, branch_id: branchId, category_id: await categoryIdFor(c, 'purchase'), expense_date: c.now.toISOString(),
        amount_minor: toMinor(r2(Number(cost))), method: E.PayMethod.cash, notes: `Stock purchase — ${str(p.name)} × ${n}`.slice(0, 255), is_voided: false, created_by: c.actorId,
      })
    }
    await audit(c, 'inventory', p.ROWID, type, `${signed} ${text}`, branchId)
  }, { perm: 'inventory.manage' }),

  /** Batches in the current view with days to expiry (negative = already expired). */
  batches: userRead(async (c) => {
    const rows = await c.db.select('stock_batches', { where: { ...inScope(c), qty_left_milli: { gt: 0 } } })
    if (!rows.length) return []
    const products = await loadProducts(c, { ids: [...new Set(rows.map((r) => str(r.product_id)))], withExpiry: false })
    const today = bizDay(c)
    return rows.map((r) => {
      const b = batchFrom(r)
      const p = products.find((x) => x.id === b.productId)
      return {
        ...b, product: p ? { id: p.id, name: p.name, unit: p.unit, emoji: p.emoji, imageUrl: p.imageUrl ?? null, costPrice: canSeeCost(c) ? p.costPrice : 0, barcode: p.barcode } : null,
        daysLeft: b.expiry ? Math.round((dayMs(b.expiry) - dayMs(today)) / 86400000) : null,
      }
    }).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'))
  }),

  /** Remove what's left of one batch from stock (expired / damaged), recorded as wastage. */
  writeOffBatch: userWrite(async (c, batchId: string, reason = 'Expired') => {
    const bt = await own(c, 'stock_batches', batchId, 'Batch not found')
    if (!c.inScope(str(bt.branch_id)) || Number(bt.qty_left_milli) <= 0) throw new ApiError('Batch not found', 404)
    const why = String(reason || 'Expired').slice(0, 80)
    const qty = await writeOffBatch(c, bt, why)
    await audit(c, 'inventory', str(bt.product_id), 'write_off_batch', `${qty} ${why}`, str(bt.branch_id))
  }, { perm: 'inventory.manage' }),
})

define('expenses', {
  list: userRead(async (c, from: string, to: string) => {
    const [rows, cat] = await Promise.all([
      c.db.select('expenses', { where: { ...inScope(c), expense_date: { gte: isoArg(from), lte: isoArg(to) } }, orderBy: [['expense_date', 'DESC']], limit: 5000 }),
      categoryNames(c),
    ])
    return rows.map((r) => expenseFrom(r, cat))
  }, { perm: 'expenses.manage' }),

  save: userWrite(async (c, e: Partial<Expense> & { amount: number; category: ExpenseCategory }) => {
    if (!(Number(e?.amount) > 0)) throw new ApiError('Enter a valid amount')
    const category = cleanCategory(e.category)
    const data = {
      category_id: await categoryIdFor(c, category), amount_minor: toMinor(r2(Number(e.amount))), method: code(E.PayMethod, cleanMethod(e.method)),
      notes: String(e.notes ?? '').slice(0, 255) || null,
    }
    let row: Row
    if (e.id) {
      const ex = await own(c, 'expenses', e.id, 'Expense not found')
      if (!c.inScope(str(ex.branch_id))) throw new ApiError('Expense not found', 404)
      row = await c.db.update('expenses', ex.ROWID, { ...data, ...(e.date ? { expense_date: isoArg(e.date, 'Choose a date') } : {}) })
      await audit(c, 'expense', row.ROWID, 'update', String(e.amount), str(row.branch_id))
    } else {
      const branchId = c.writeBranch({ requested: e.branchId })
      row = await c.db.insert('expenses', {
        business_id: c.businessId, branch_id: branchId, expense_date: e.date ? isoArg(e.date, 'Choose a date') : c.now.toISOString(), ...data, is_voided: false, created_by: c.actorId,
      })
      await audit(c, 'expense', row.ROWID, 'create', String(r2(Number(e.amount))), branchId)
    }
    return expenseFrom(row, () => category)
  }, { perm: 'expenses.manage' }),

  /** Voided, never deleted (kept for audit). */
  void: userWrite(async (c, id: string) => {
    if (!isId(id)) return
    const e = await c.db.first('expenses', { ROWID: id, business_id: c.businessId })
    if (!e) return
    // Added for a supplier payment: the payment is the record — void it there so both stay the same.
    if (Number(e.ref_type) === E.ExpenseRef.supplier_payment) throw new ApiError('This is a supplier payment — void it from the supplier’s statement (Inventory → Suppliers)')
    await c.db.update('expenses', e.ROWID, { is_voided: true })
    await audit(c, 'expense', e.ROWID, 'void', '', str(e.branch_id))
  }, { perm: 'expenses.manage' }),
})
