// Stock (movements, adjustments, batches & expiry) and expenses. Same rules as the app's mock API.
import { r2 } from '@/core/pricing'
import type { Expense, ExpenseCategory, PaymentMethod, Product, StockBatch, StockMovement, StockMovementType } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row, type Where } from '../db/types'
import { loadProducts, canSeeCost, lightProducts, mediaMap, imageOf, withCostFor } from '../domain/catalog'
import { afterKey, nameLike, type Arg } from '../domain/productSql'
import { moveStock, stockOf, stockProduct, writeOffBatch, type BatchInput } from '../domain/stock'
import { audit, bizDay, code, E, fromMilli, fromMinor, isId, nameOf, nameOrNull, own, selectOlder, str, strOrNull, toMilli, toMinor, money, quantity, assertBranch } from '../domain/util'

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

// ---------- Inventory from the server (one database per shop) ----------
// The screen asks only for what it shows — the counts, one page of items, a search — instead of the whole product
// list, in every shop. The Data Store (no SQL) keeps the app's own list (summary says `large: false`).
const STOCK_PAGE = 50
const PICK_PAGE = 50
/** Each product's stock in the current view's branches (thousandths), as `s."st"`. */
function stockJoin(c: Ctx): { sql: string; args: Arg[] } {
  const branches = c.scope().map(Number)
  return {
    sql: `LEFT JOIN (SELECT "product_id", SUM("qty_milli") AS "st" FROM "branch_stock" WHERE "business_id" = ?${branches.length ? ` AND "branch_id" IN (${branches.map(() => '?').join(', ')})` : ''} GROUP BY "product_id") s ON s."product_id" = p."id"`,
    args: [Number(c.businessId), ...branches],
  }
}
/** One page of product ids picked by `where` → light products in that order + the next page's key. */
async function productPage(c: Ctx, where: { sql: string; args: Arg[] }, after: unknown, size: number, withStock: boolean) {
  const st = withStock ? stockJoin(c) : { sql: '', args: [] as Arg[] }
  const k = afterKey(after)
  const rows = await c.db.sql!(
    `SELECT p."id", p."sort_order" FROM "products" p ${st.sql} WHERE p."business_id" = ? AND p."is_active" = 1${where.sql}${k.sql} ORDER BY p."sort_order", p."id" LIMIT ?`,
    [...st.args, Number(c.businessId), ...where.args, ...k.args, size + 1],
  )
  const more = rows.length > size
  const mine = more ? rows.slice(0, size) : rows
  const last = mine[mine.length - 1]
  return { rows: await lightProducts(c, mine.map((r) => Number(r.id))), next: more && last ? `${Number(last.sort_order)}:${Number(last.id)}` : null }
}
const LOW = 'COALESCE(s."st", 0) > 0 AND COALESCE(s."st", 0) <= p."low_stock_milli"'
const OUT = 'COALESCE(s."st", 0) <= 0'

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

/** Stock history rows per answer. */
export const MOVES_PAGE = 3000

define('inventory', {
  /**
   * Reports → Inventory: each item's stock moved in the last 7 days, by type (purchase, sale, wastage…) — added up
   * by the database (every movement counts, however many), instead of sending the movements themselves.
   */
  weekSummary: userRead(async (c) => {
    const since = new Date(c.now.getTime() - 7 * 86_400_000).toISOString()
    const rows = await c.db.aggregate('stock_movements', { where: { ...inScope(c), CREATEDTIME: { gte: since } }, groupBy: ['product_id', 'reason'], fns: { q: ['SUM', 'qty_milli'] } })
    // Several stored reasons can show as one type (expired → wastage): added together.
    const out = new Map<string, { productId: string; type: StockMovementType; qty: number }>()
    for (const r of rows) {
      const productId = str(r.product_id), type = movementType(r.reason as Row['reason']), k = `${productId}|${type}`
      const cur = out.get(k)
      if (cur) cur.qty = fromMilli(toMilli(cur.qty) + Number(r.q ?? 0)); else out.set(k, { productId, type, qty: fromMilli(Number(r.q ?? 0)) })
    }
    return [...out.values()]
  }),

  /**
   * Newest 3,000 (or `limit`); `before` (the last one the screen has) → the next older ones ("Load older").
   * `withProduct` = each with its item's name and picture (Inventory → History has no product list).
   */
  movements: userRead(async (c, productId?: string | null, before?: unknown, limit?: number, withProduct?: boolean) => {
    if (productId && !isId(productId)) return []
    const n = Math.min(MOVES_PAGE, Math.max(1, Math.floor(Number(limit)) || MOVES_PAGE))
    const rows = await selectOlder(c, 'stock_movements', { ...inScope(c), ...(productId ? { product_id: productId } : {}) }, before, n)
    const list = rows.map(movementFrom)
    if (withProduct !== true || !list.length) return list
    const ids = [...new Set(list.map((m) => m.productId))]
    const prows = await c.db.select('products', { where: { business_id: c.businessId, ROWID: { in: ids } } })
    const media = await mediaMap(c, prows.map((r) => str(r.image_media_id)))
    const by = new Map(prows.map((r) => [r.ROWID, { id: r.ROWID, name: str(r.name), emoji: str(r.emoji), unit: str(r.unit) || 'pc', ...imageOf(c, media.get(str(r.image_media_id))) }]))
    return list.map((m) => ({ ...m, product: by.get(m.productId) ?? null }))
  }, { anyPerm: ['inventory.manage'] }),

  /**
   * Inventory's counts, added up by the database (one database per shop) — the screen then pages its list with
   * `stock`. The Data Store: `large: false` (the screen counts its own list).
   */
  summary: userRead(async (c): Promise<{ large: false } | { large: true; tracked: number; low: number; out: number; value: number }> => {
    if (!c.dbs.perShop || !c.db.sqlReads) return { large: false }
    const st = stockJoin(c)
    const biz = Number(c.businessId)
    const [agg] = await c.db.sqlReads([
      {
        sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN ${LOW} THEN 1 ELSE 0 END) AS low, SUM(CASE WHEN ${OUT} THEN 1 ELSE 0 END) AS out,
          SUM(COALESCE(s."st", 0) * COALESCE(p."cost_minor", 0)) AS val
          FROM "products" p ${st.sql} WHERE p."business_id" = ? AND p."track_stock" = 1 AND p."is_active" = 1`,
        args: [...st.args, biz],
      },
    ])
    const a = agg[0] ?? {}
    // stock in thousandths × cost in paise → rupees
    return { large: true, tracked: Number(a.n ?? 0), low: Number(a.low ?? 0), out: Number(a.out ?? 0), value: canSeeCost(c) ? r2(Number(a.val ?? 0) / 100_000) : 0 }
  }, { anyPerm: ['inventory.manage'] }),

  /** The stock list: one page of tracked items (All / Low / Out, name search), in the list's order. */
  stock: userRead(async (c, input?: { filter?: 'all' | 'low' | 'out'; q?: string; after?: string | null }): Promise<{ rows: Product[]; next: string | null }> => {
    if (!c.dbs.perShop || !c.db.sql) throw new ApiError('Not used on this setup')
    const f = input?.filter === 'low' ? ` AND ${LOW}` : input?.filter === 'out' ? ` AND ${OUT}` : ''
    const q = nameLike(input?.q)
    return productPage(c, { sql: ` AND p."track_stock" = 1${f}${q.sql}`, args: q.args }, input?.after, STOCK_PAGE, true)
  }, { anyPerm: ['inventory.manage'] }),

  /** "Track stock for…": goods not tracked yet, a page at a time, with a name search. */
  untracked: userRead(async (c, input?: { q?: string; after?: string | null }): Promise<{ rows: Product[]; next: string | null }> => {
    if (!c.dbs.perShop || !c.db.sql) throw new ApiError('Not used on this setup')
    const q = nameLike(input?.q)
    return productPage(c, { sql: ` AND p."track_stock" = 0 AND p."kind" = ?${q.sql}`, args: [E.ProductKind.goods, ...q.args] }, input?.after, PICK_PAGE, false)
  }, { anyPerm: ['inventory.manage'] }),

  /** The purchase bill's item search: up to 8 active goods by name, barcode or SKU (full products, as the app's own search). */
  findProducts: userRead(async (c, text?: string): Promise<Product[]> => {
    if (!c.dbs.perShop || !c.db.sql) throw new ApiError('Not used on this setup')
    const typed = String(text ?? '').trim().slice(0, 100), s = typed.toLowerCase()
    if (!s) return []
    const q = nameLike(s)
    // A scanned barcode comes as printed (any case).
    const rows = await c.db.sql(
      `SELECT p."id" FROM "products" p WHERE p."business_id" = ? AND p."is_active" = 1 AND p."kind" = ? AND ((1 = 1${q.sql}) OR p."barcode" IN (?, ?) OR LOWER(p."sku") = ?) ORDER BY p."sort_order", p."id" LIMIT 8`,
      [Number(c.businessId), E.ProductKind.goods, ...q.args, s, typed, s],
    )
    if (!rows.length) return []
    return withCostFor(c, await loadProducts(c, { ids: rows.map((r) => String(r.id)) }))
  }, { anyPerm: ['inventory.manage'] }),

  /** Stock in / out by hand. Purchases with a cost are also booked as a 'purchase' expense. */
  adjust: userWrite(async (c, productId: string, type: StockMovementType, qty: number, note: string, cost?: number, batch?: BatchInput) => {
    if (!MOVE_TYPES.includes(type)) throw new ApiError('Choose the type of stock change')
    const n = Number(qty)
    if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new ApiError('Enter a valid quantity')
    // Only an adjustment goes either way; a negative purchase / wastage… was silently turned around before.
    if (n < 0 && type !== 'adjustment') throw new ApiError('Enter a quantity more than 0. To reduce stock, use Wastage, Damage or Adjustment.')
    let p = await own(c, 'products', productId, 'Product not found')
    // Whole numbers unless the item is sold in parts; a stock purchase's cost 0 … ₹1 crore.
    if (n !== 0) quantity(Math.abs(n), str(p.unit) || 'pc', str(p.name))
    if (cost !== undefined && cost !== null && cost !== 0) money(cost, 'Cost')
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
  }, { anyPerm: ['inventory.manage', 'dashboard.view'] }),

  /** Remove what's left of one batch from stock (expired / damaged), recorded as wastage. */
  writeOffBatch: userWrite(async (c, batchId: string, reason = 'Expired') => {
    const bt = await own(c, 'stock_batches', batchId, 'Batch not found')
    if (!c.inScope(str(bt.branch_id)) || Number(bt.qty_left_milli) <= 0) throw new ApiError('Batch not found', 404)
    const why = String(reason || 'Expired').slice(0, 80)
    const qty = await writeOffBatch(c, bt, why)
    await audit(c, 'inventory', str(bt.product_id), 'write_off_batch', `${qty} ${why}`, str(bt.branch_id))
  }, { perm: 'inventory.manage' }),
})

/** A Dashboard item: just what its cards show. */
type AlertItem = { id: string; name: string; emoji: string; imageUrl: string | null; thumbUrl: string | null; unit: string }

define('dashboard', {
  /**
   * The Dashboard's Low stock and Expiring soon cards (one database per shop): the counts and the first 3 of each,
   * added up by the database — instead of the whole product list and every batch. The Data Store: `large: false`
   * (the Dashboard works them out from the product list and batches).
   * Same rules as the Dashboard: low = tracked, active, stock at or below its alert level (out of stock too), in the
   * list's order; expiring = batches with stock left expiring within 7 days (or already), the earliest first.
   */
  alerts: userRead(async (c): Promise<{ large: false } | {
    large: true
    low: { count: number; top: (AlertItem & { stock: number })[] }
    expiring: { count: number; top: { id: string; qty: number; daysLeft: number; product: AlertItem | null }[] }
  }> => {
    if (!c.dbs.perShop || !c.db.sqlReads) return { large: false }
    const biz = Number(c.businessId)
    const st = stockJoin(c)
    const branches = c.scope().map(Number)
    const inB = branches.length ? ` AND b."branch_id" IN (${branches.map(() => '?').join(', ')})` : ''
    const today = bizDay(c)
    const until = new Date(dayMs(today) + 7 * 86_400_000).toISOString().slice(0, 10)
    const LOW_ITEM = `p."track_stock" = 1 AND p."is_active" = 1 AND COALESCE(s."st", 0) <= p."low_stock_milli"`
    const SOON = `b."business_id" = ? AND b."qty_left_milli" > 0 AND b."expiry_date" IS NOT NULL AND b."expiry_date" <> '' AND b."expiry_date" <= ?${inB}`
    const [lowN, lowTop, expN, expTop] = await c.db.sqlReads([
      { sql: `SELECT COUNT(*) AS n FROM "products" p ${st.sql} WHERE p."business_id" = ? AND ${LOW_ITEM}`, args: [...st.args, biz] },
      {
        sql: `SELECT p."id", p."name", p."emoji", p."unit", p."image_media_id", COALESCE(s."st", 0) AS st FROM "products" p ${st.sql}
          WHERE p."business_id" = ? AND ${LOW_ITEM} ORDER BY p."sort_order", p."id" LIMIT 3`,
        args: [...st.args, biz],
      },
      { sql: `SELECT COUNT(*) AS n FROM "stock_batches" b WHERE ${SOON}`, args: [biz, until, ...branches] },
      {
        sql: `SELECT b."id", b."qty_left_milli", b."expiry_date", p."id" AS pid, p."name", p."emoji", p."unit", p."image_media_id"
          FROM "stock_batches" b LEFT JOIN "products" p ON p."id" = b."product_id" AND p."business_id" = b."business_id"
          WHERE ${SOON} ORDER BY b."expiry_date", b."id" LIMIT 3`,
        args: [biz, until, ...branches],
      },
    ])
    // The few photos shown (≤ 6).
    const media = await mediaMap(c, [...lowTop, ...expTop].map((r) => (r.image_media_id == null ? null : String(r.image_media_id))))
    const item = (id: unknown, r: Record<string, unknown>): AlertItem => ({
      id: String(id), name: String(r.name ?? ''), emoji: String(r.emoji ?? ''), unit: String(r.unit || 'pc'),
      ...imageOf(c, r.image_media_id == null ? undefined : media.get(String(r.image_media_id))),
    })
    return {
      large: true,
      low: { count: Number(lowN[0]?.n ?? 0), top: lowTop.map((r) => ({ ...item(r.id, r), stock: Number(r.st ?? 0) / 1000 })) },
      expiring: {
        count: Number(expN[0]?.n ?? 0),
        top: expTop.map((r) => ({
          id: String(r.id), qty: Number(r.qty_left_milli ?? 0) / 1000, daysLeft: Math.round((dayMs(String(r.expiry_date)) - dayMs(today)) / 86_400_000),
          product: r.pid == null ? null : item(r.pid, r),
        })),
      },
    }
  }, { anyPerm: ['inventory.manage', 'dashboard.view'] }),
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
    money(e?.amount, 'Amount', { positive: true }) // a real amount, more than 0 and at most ₹1 crore
    const category = cleanCategory(e.category)
    const data = {
      category_id: await categoryIdFor(c, category), amount_minor: toMinor(r2(Number(e.amount))), method: code(E.PayMethod, cleanMethod(e.method)),
      notes: String(e.notes ?? '').slice(0, 255) || null,
    }
    let row: Row
    if (e.id) {
      const ex = await own(c, 'expenses', e.id, 'Expense not found')
      assertBranch(c, ex.branch_id, 'Expense not found')
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
    assertBranch(c, e.branch_id, 'Expense not found')
    // Added for a supplier payment: the payment is the record — void it there so both stay the same.
    if (Number(e.ref_type) === E.ExpenseRef.supplier_payment) throw new ApiError('This is a supplier payment — void it from the supplier’s statement (Inventory → Suppliers)')
    await c.db.update('expenses', e.ROWID, { is_voided: true })
    await audit(c, 'expense', e.ROWID, 'void', '', str(e.branch_id))
  }, { perm: 'expenses.manage' }),
})
