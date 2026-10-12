// Returns, refunds and exchanges (sale_returns, sale_return_items). Each return is a credit note (CN-1001).
// Same rules and return shapes as the app's mock API.
import { r2 } from '@/core/pricing'
import type { PaymentMethod, ReturnReason, SaleReturn } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row } from '../db/types'
import { clientUuid, loadOrder, selectIn } from '../domain/orders'
import { moveStock, stockProduct } from '../domain/stock'
import { audit, code, E, fromMilli, fromMinor, nameOf, nameOrNull, nextNumber, str, strOrNull, toMilli, toMinor } from '../domain/util'

export interface ReturnInput {
  orderId: string
  lines: { orderItemId: string; qty: number; restock: boolean }[]
  reason: ReturnReason
  note?: string
  settle: 'refund' | 'credit_note'
  refundMethod?: PaymentMethod
}

export function returnFrom(r: Row, items: Row[]): SaleReturn {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), number: str(r.number), orderId: str(r.order_id), invoiceNumber: str(r.invoice_number),
    customerId: strOrNull(r.customer_id),
    lines: items.filter((i) => i.return_id === r.ROWID).map((i) => ({
      orderItemId: str(i.order_item_id), productId: str(i.product_id), name: str(i.product_name), qty: fromMilli(i.qty_milli), unit: str(i.unit),
      unitPrice: fromMinor(i.unit_price_minor), amount: fromMinor(i.amount_minor), restock: i.restock !== false,
    })),
    total: fromMinor(r.total_minor), tax: fromMinor(r.tax_minor), reason: nameOf(E.ReturnReason, r.reason) as ReturnReason, note: str(r.note),
    dueAdjusted: fromMinor(r.due_adjusted_minor), refunded: fromMinor(r.refunded_minor), refundMethod: nameOrNull(E.PayMethod, r.refund_method) as PaymentMethod | null,
    creditIssued: fromMinor(r.credit_issued_minor), creditRemaining: fromMinor(r.credit_remaining_minor),
    createdAt: r.CREATEDTIME, createdBy: str(r.created_by), updatedAt: r.MODIFIEDTIME, updatedBy: str(r.created_by),
  }
}

/** Return rows with their lines. */
export async function withLines(c: Ctx, rows: Row[]): Promise<SaleReturn[]> {
  if (!rows.length) return []
  const items = await selectIn(c, 'sale_return_items', 'return_id', rows.map((r) => r.ROWID))
  return rows.map((r) => returnFrom(r, items))
}

/** Returns already made against a bill (oldest first) and their lines. */
async function returnsOf(c: Ctx, orderId: string) {
  const rows = await c.db.select('sale_returns', { where: { business_id: c.businessId, order_id: orderId }, orderBy: [['CREATEDTIME', 'ASC']] })
  const items = rows.length ? await selectIn(c, 'sale_return_items', 'return_id', rows.map((r) => r.ROWID)) : []
  // Quantity already returned per bill line, in thousandths (no float drift).
  const milli = (itemId: string) => items.filter((i) => i.order_item_id === itemId).reduce((a, i) => a + Number(i.qty_milli), 0)
  return { rows, items, milli }
}

const billOf = async (c: Ctx, orderId: string, msg: string) => {
  try { return await loadOrder(c, orderId) } catch (e) { if (e instanceof ApiError && e.status === 404) throw new ApiError(msg); throw e }
}

define('returns', {
  /** What can still be returned from a bill (quantity already returned is taken off). */
  forOrder: userRead(async (c, orderId: string) => {
    const { order: o } = await billOf(c, orderId, 'Bill not found')
    const done = await returnsOf(c, o.id)
    return {
      returns: done.rows.map((r) => returnFrom(r, done.items)),
      items: o.items.map((i) => { const returned = fromMilli(done.milli(i.id)); return { ...i, returned, returnable: r2(i.qty - returned) } }),
      ratio: o.subtotal > 0 ? o.total / o.subtotal : 0,
    }
  }),

  list: userRead(async (c, limit = 200) => {
    const rows = await c.db.select('sale_returns', { where: { business_id: c.businessId, branch_id: { in: c.scope() } }, orderBy: [['CREATEDTIME', 'DESC']], limit: Math.min(Math.max(1, Number(limit) || 200), 1000) })
    return withLines(c, rows)
  }),

  creditNote: userRead(async (c, number: string) => {
    // ZCQL values can't hold quotes — keep only what a credit note number can contain.
    const no = String(number ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
    const r = no ? await c.db.first('sale_returns', { number_key: `${c.businessId}:${no}` }) : null
    if (!r) throw new ApiError(`Credit note ${String(number ?? '').trim()} not found`)
    return (await withLines(c, [r]))[0]
  }),

  create: userWrite(async (c, input: ReturnInput) => {
    const reason = code(E.ReturnReason, input?.reason)
    const settleCode = code(E.ReturnSettle, input?.settle)
    // Same request sent twice (retry after a network drop): return the credit note already made.
    const uuid = clientUuid(c, ':r')
    const again = await c.db.first('sale_returns', { client_uuid: uuid })
    if (again) { if (str(again.business_id) !== c.businessId) throw new ApiError('Duplicate request', 409); return (await withLines(c, [again]))[0] }

    const { row, order: o } = await billOf(c, input.orderId, 'Only completed bills can be returned')
    if (o.status !== 'completed' || !o.invoiceNumber) throw new ApiError('Only completed bills can be returned')
    const done = await returnsOf(c, o.id)
    const ratio = o.subtotal > 0 ? o.total / o.subtotal : 0
    const lines: { it: typeof o.items[number]; qtyMilli: number; qty: number; amount: number; restock: boolean }[] = []
    for (const l of input.lines ?? []) {
      const qtyMilli = toMilli(Number(l.qty) || 0)
      if (!(qtyMilli > 0)) continue
      const it = o.items.find((x) => x.id === l.orderItemId)
      if (!it) throw new ApiError('That item isn’t on this bill')
      const left = toMilli(it.qty) - done.milli(it.id) - lines.filter((x) => x.it.id === it.id).reduce((a, x) => a + x.qtyMilli, 0)
      if (qtyMilli > left) throw new ApiError(`Only ${fromMilli(left)} of ${it.name} can be returned`)
      const qty = fromMilli(qtyMilli)
      lines.push({ it, qtyMilli, qty, amount: r2(it.unitPrice * qty * ratio), restock: !!l.restock })
    }
    if (!lines.length) throw new ApiError('Choose at least one item to return')

    // Whole rupees when the shop rounds its bills (but never more than what's left of the bill).
    const exact = lines.reduce((a, l) => a + l.amount, 0)
    const returnedBefore = fromMinor(done.rows.reduce((a, r) => a + Number(r.total_minor), 0))
    const total = r2(Math.max(0, Math.min(c.business.billing.roundOff ? Math.round(exact) : exact, o.total - returnedBefore)))
    const gross = lines.reduce((a, l) => a + l.it.unitPrice * l.qty, 0)
    const tax = o.subtotal > 0 ? r2(o.tax * gross / o.subtotal) : 0
    // A pending due on this bill is reduced first — nobody gets money back for something not paid for.
    const dueAdjusted = r2(Math.max(0, Math.min(total, o.balance)))
    const rest = r2(total - dueAdjusted)
    let refunded = 0, creditIssued = 0, method: PaymentMethod | null = null
    if (rest > 0 && input.settle === 'refund') {
      method = input.refundMethod && !['credit', 'credit_note'].includes(input.refundMethod) ? input.refundMethod : 'cash'
      code(E.PayMethod, method)
      refunded = rest
    } else if (rest > 0) creditIssued = rest

    // Claim the bill first: two counters returning from the same bill at once can't both pass the checks above.
    const before = { balance_minor: row.balance_minor, returned_minor: row.returned_minor }
    const claimed = await c.db.updateIfVersion('orders', row.ROWID, Number(row.row_version), {
      balance_minor: toMinor(r2(o.balance - dueAdjusted)), returned_minor: Number(row.returned_minor ?? 0) + (toMinor(total) ?? 0), updated_by: c.actorId,
    })
    if (!claimed) throw new ApiError('This bill was just changed on another device. Please check it and try again.', 409, 'CONFLICT')

    const branchId = c.writeBranch({ fallback: true })
    let ret: Row
    try {
      const num = await nextNumber(c.db, c.businessId, null, 'credit_note', { prefix: c.business.billing.creditNotePrefix || 'CN-', start: 1001 })
      ret = await c.db.insert('sale_returns', {
        business_id: c.businessId, branch_id: branchId, order_id: o.id, customer_id: o.customerId, client_uuid: uuid,
        number: num.text, number_key: `${c.businessId}:${num.text.toUpperCase()}`, invoice_number: o.invoiceNumber, reason, settle: settleCode,
        note: String(input.note ?? '').trim().slice(0, 255) || null, total_minor: toMinor(total), tax_minor: toMinor(tax), due_adjusted_minor: toMinor(dueAdjusted),
        refunded_minor: toMinor(refunded), refund_method: method ? code(E.PayMethod, method) : null, credit_issued_minor: toMinor(creditIssued), credit_remaining_minor: toMinor(creditIssued),
        created_by: c.actorId,
      })
      await c.db.insertMany('sale_return_items', lines.map((l) => ({
        business_id: c.businessId, return_id: ret.ROWID, order_item_id: l.it.id, product_id: l.it.productId,
        product_name: (l.it.variantName ? `${l.it.name} (${l.it.variantName})` : l.it.name).slice(0, 150), unit: (l.it.unit || 'pc').slice(0, 10),
        qty_milli: l.qtyMilli, unit_price_minor: toMinor(l.it.unitPrice), amount_minor: toMinor(l.amount), restock: l.restock,
      })))
      if (refunded > 0) {
        await c.db.insert('payments', {
          business_id: c.businessId, branch_id: branchId, order_id: o.id, customer_id: o.customerId, return_id: ret.ROWID, client_uuid: clientUuid(c, ':rp'),
          kind: E.PaymentKind.refund, method: code(E.PayMethod, method), amount_minor: toMinor(refunded), reference: null, is_voided: false, created_by: c.actorId,
        })
      }
    } catch (e) {
      // Put the bill back so the return can be tried again.
      await c.db.update('orders', row.ROWID, before)
      if (e instanceof DuplicateError) { const r = await c.db.first('sale_returns', { client_uuid: uuid }); if (r) return (await withLines(c, [r]))[0] }
      throw e
    }

    const restock = lines.filter((l) => l.restock)
    if (restock.length) {
      const prows = await selectIn(c, 'products', 'ROWID', restock.map((l) => l.it.productId), { business_id: c.businessId })
      for (const l of restock) {
        const p = prows.find((x) => x.ROWID === l.it.productId)
        if (p) await moveStock(c, stockProduct(p), branchId, l.qty, 'return', { refType: 'return', refId: ret.ROWID, note: `Returned — ${str(ret.number)} (${o.invoiceNumber})` })
      }
    }
    await audit(c, 'order', o.id, 'return', `${str(ret.number)} · ${c.business.currencySymbol}${total} · ${lines.length} item(s)`, str(row.branch_id))
    return (await withLines(c, [ret]))[0]
  }, { perm: 'orders.cancel' }),
})
