// Stock changes: branch_stock (current qty), stock_batches (expiry, first-expiry-first-out) and
// stock_movements (the history). Same rules as the app's mock.
import type { StockMovementType } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { Row } from '../db/types'
import { DuplicateError } from '../db/types'
import { code, E, fromMilli, moduleOn, str, toMilli } from './util'

export interface BatchInput { batchNo?: string; expiry?: string }
export interface StockProduct { id: string; trackStock: boolean; trackBatches: boolean }
export const stockProduct = (p: Row): StockProduct => ({ id: p.ROWID, trackStock: !!p.track_stock, trackBatches: !!p.track_batches })

type Reason = StockMovementType | 'expired' | 'transfer_in' | 'transfer_out'
const refTypes = { order: E.StockRef.order, purchase: E.StockRef.purchase, return: E.StockRef.return, transfer: E.StockRef.transfer } as const

/** Current stock of one product in one branch (0 when never stocked). */
export async function stockOf(c: Ctx, productId: string, branchId: string) {
  const r = await c.db.first('branch_stock', { uniq_key: `${branchId}:${productId}` })
  return r ? fromMilli(r.qty_milli) : 0
}

/** Adds (or takes) qty to the branch's stock row; safe when two counters sell the same item at once. */
async function bumpBranchStock(c: Ctx, productId: string, branchId: string, deltaMilli: number): Promise<number> {
  const uniq = `${branchId}:${productId}`
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await c.db.first('branch_stock', { uniq_key: uniq })
    if (!row) {
      try { const r = await c.db.insert('branch_stock', { business_id: c.businessId, branch_id: branchId, product_id: productId, qty_milli: deltaMilli, uniq_key: uniq }); return Number(r.qty_milli) }
      catch (e) { if (e instanceof DuplicateError) continue; throw e }
    }
    const next = Number(row.qty_milli) + deltaMilli
    if (await c.db.updateIfVersion('branch_stock', row.ROWID, Number(row.row_version), { qty_milli: next })) return next
  }
  throw new ApiError('Busy — please try again', 409, 'CONFLICT')
}

const cleanBatchNo = (s: string | undefined) => String(s ?? '').replace(/['"\\]/g, '').trim().slice(0, 40)

/** Keeps batch quantities in step with a stock change (products that track expiry). Returns the batches used. */
async function moveBatches(c: Ctx, p: StockProduct, branchId: string, qtyMilli: number, batch: BatchInput | undefined): Promise<{ batchId: string; qtyMilli: number }[]> {
  if (!p.trackBatches || qtyMilli === 0) return []
  const all = await c.db.select('stock_batches', { where: { product_id: p.id, branch_id: branchId } })
  if (qtyMilli > 0) {
    const no = cleanBatchNo(batch?.batchNo)
    const expiry = batch?.expiry && /^\d{4}-\d{2}-\d{2}$/.test(batch.expiry) ? batch.expiry : null
    let target = batch ? all.find((x) => str(x.batch_no) === no && (x.expiry_date ?? null) === expiry) : undefined
    // Returns without batch info go back to the newest batch.
    if (!target && !batch) target = [...all].sort((a, b) => b.CREATEDTIME.localeCompare(a.CREATEDTIME))[0]
    if (target) {
      await c.db.update('stock_batches', target.ROWID, { qty_left_milli: Number(target.qty_left_milli) + qtyMilli, qty_in_milli: Number(target.qty_in_milli) + (batch ? qtyMilli : 0) })
      return [{ batchId: target.ROWID, qtyMilli }]
    }
    const r = await c.db.insert('stock_batches', { business_id: c.businessId, branch_id: branchId, product_id: p.id, batch_no: no || null, expiry_date: expiry, qty_in_milli: qtyMilli, qty_left_milli: qtyMilli })
    return [{ batchId: r.ROWID, qtyMilli }]
  }
  // Sale: first-expiry-first-out (unknown expiry last).
  let left = -qtyMilli
  const used: { batchId: string; qtyMilli: number }[] = []
  const fefo = all.filter((x) => Number(x.qty_left_milli) > 0).sort((a, b) => str(a.expiry_date || '9999').localeCompare(str(b.expiry_date || '9999')))
  for (const bt of fefo) {
    if (left <= 0) break
    const take = Math.min(Number(bt.qty_left_milli), left)
    await c.db.update('stock_batches', bt.ROWID, { qty_left_milli: Number(bt.qty_left_milli) - take })
    used.push({ batchId: bt.ROWID, qtyMilli: take })
    left -= take
  }
  return used
}

/**
 * One stock change: batches → branch stock → movement row. `qty` is signed (+ in, − out), in the
 * product's unit. Products that don't track stock are ignored (like the app), and so is everything while the
 * Inventory module is off (stock isn't shown or used then — no stock rows are written).
 */
export async function moveStock(c: Ctx, p: StockProduct, branchId: string, qty: number, reason: Reason, opts: { note?: string; refType?: keyof typeof refTypes; refId?: string | null; batch?: BatchInput } = {}) {
  if (!p.trackStock || qty === 0 || !moduleOn(c, 'inventory')) return { balance: null as number | null, batches: [] as { batchId: string; qtyMilli: number }[] }
  const milli = toMilli(qty)
  const batches = await moveBatches(c, p, branchId, milli, opts.batch)
  const balanceMilli = await bumpBranchStock(c, p.id, branchId, milli)
  await c.db.insert('stock_movements', {
    business_id: c.businessId, branch_id: branchId, product_id: p.id, batch_id: batches[0]?.batchId ?? null,
    reason: code(E.StockReason, reason), qty_milli: milli, balance_milli: balanceMilli,
    ref_type: opts.refType ? refTypes[opts.refType] : null, ref_id: opts.refId ?? null, note: (opts.note ?? '').slice(0, 255), created_by: c.actorId,
  })
  const balance = fromMilli(balanceMilli)
  c.addStock(p.id, branchId, balance)
  return { balance, batches }
}

/** Takes what's left of one exact batch out of stock (expired / damaged). */
export async function writeOffBatch(c: Ctx, batch: Row, reason: string) {
  const qty = Number(batch.qty_left_milli)
  if (qty <= 0) throw new ApiError('Batch not found', 404)
  await c.db.update('stock_batches', batch.ROWID, { qty_left_milli: 0 })
  const balanceMilli = await bumpBranchStock(c, str(batch.product_id), str(batch.branch_id), -qty)
  await c.db.insert('stock_movements', {
    business_id: c.businessId, branch_id: str(batch.branch_id), product_id: str(batch.product_id), batch_id: batch.ROWID,
    reason: E.StockReason.wastage, qty_milli: -qty, balance_milli: balanceMilli, ref_type: null, ref_id: batch.ROWID, // like the app: the movement points at the batch
    note: `${reason} — batch ${str(batch.batch_no) || '—'} (exp ${str(batch.expiry_date) || '—'})`.slice(0, 255), created_by: c.actorId,
  })
  c.addStock(str(batch.product_id), str(batch.branch_id), fromMilli(balanceMilli))
  return fromMilli(qty)
}

export interface StockMove { p: StockProduct; branchId: string; qty: number; reason: Reason; opts?: Parameters<typeof moveStock>[5] }

const UPSERT_STOCK = `INSERT INTO "branch_stock" ("business_id", "branch_id", "product_id", "qty_milli", "uniq_key") VALUES (?, ?, ?, ?, ?)
ON CONFLICT ("uniq_key") DO UPDATE SET "qty_milli" = "qty_milli" + excluded."qty_milli", "row_version" = "row_version" + 1, "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
RETURNING "qty_milli"`

/**
 * Many stock changes (one bill): same result as moveStock() for each, in order. On SQL databases the branch
 * stock of every plain item changes in one round trip and the history rows go in one insert — this is what
 * keeps a bill's write lock short. Batch-tracked items (expiry) still go one by one (first-expiry-first-out).
 */
export async function moveStockMany(c: Ctx, moves: StockMove[]) {
  const out: { balance: number | null; batches: { batchId: string; qtyMilli: number }[] }[] = moves.map(() => ({ balance: null, batches: [] }))
  if (!moduleOn(c, 'inventory')) return out
  const fast = c.db.sqlMany ? moves.map((m, i) => ({ m, i })).filter(({ m }) => m.p.trackStock && !m.p.trackBatches && m.qty !== 0) : []
  const fastIdx = new Set(fast.map((x) => x.i))
  for (const [i, m] of moves.entries()) if (!fastIdx.has(i)) out[i] = await moveStock(c, m.p, m.branchId, m.qty, m.reason, m.opts)
  if (!fast.length) return out
  const results = await c.db.sqlMany!(fast.map(({ m }) => ({ sql: UPSERT_STOCK, args: [Number(c.businessId), Number(m.branchId), Number(m.p.id), toMilli(m.qty), `${m.branchId}:${m.p.id}`] })))
  const balances = results.map((r) => Number(r[0]?.qty_milli ?? 0))
  await c.db.insertMany('stock_movements', fast.map(({ m }, k) => ({
    business_id: c.businessId, branch_id: m.branchId, product_id: m.p.id, batch_id: null,
    reason: code(E.StockReason, m.reason), qty_milli: toMilli(m.qty), balance_milli: balances[k],
    ref_type: m.opts?.refType ? refTypes[m.opts.refType] : null, ref_id: m.opts?.refId ?? null, note: (m.opts?.note ?? '').slice(0, 255), created_by: c.actorId,
  })))
  fast.forEach(({ m, i }, k) => { const balance = fromMilli(balances[k]); out[i] = { balance, batches: [] }; c.addStock(m.p.id, m.branchId, balance) })
  return out
}
