// Purchase bills and supplier balances, shared by the demo API and the backend so both accept the same input.
import { cleanHsn, hsnError } from './gst'
import { r2 } from './pricing'
import type { PaymentMethod, Purchase, PurchaseLine, SupplierLedgerRow, SupplierPayment } from './types'

export type SupplierPayMethod = Exclude<PaymentMethod, 'credit' | 'credit_note'>
export const SUPPLIER_PAY_METHODS: SupplierPayMethod[] = ['cash', 'upi', 'card', 'bank']

export interface PurchaseInput {
  supplierId: string
  supplierBillNo: string
  date: string // YYYY-MM-DD
  lines: { productId: string; qty: number; cost: number; taxRate: number; hsn?: string; batchNo?: string; expiry?: string }[]
  /** Paid now (0 = all on credit). */
  paid: number
  method: SupplierPayMethod
  reference?: string
  note?: string
  /** Round the bill total to the nearest rupee (most supplier bills are). Default true. */
  roundOff?: boolean
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const validDay = (d: string) => DAY.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime())

/**
 * Checks a purchase bill and works out each line (value before GST, GST) and the totals.
 * `products` gives the name / unit / batch rule of each item; `today` stops dates in the future.
 */
export function planPurchase(input: PurchaseInput, products: Map<string, { name: string; unit: string; trackExpiry: boolean; hsn: string }>, today: string) {
  if (!input?.supplierId) throw new Error('Choose the supplier')
  const date = String(input.date ?? '')
  if (!validDay(date)) throw new Error('Enter the bill date')
  if (date > today) throw new Error('The bill date can’t be in the future')
  const lines = Array.isArray(input.lines) ? input.lines : []
  if (!lines.length) throw new Error('Add at least one item')
  if (lines.length > 300) throw new Error('Up to 300 items on one purchase bill')
  const seen = new Set<string>()
  const out: PurchaseLine[] = lines.map((l, i) => {
    const p = products.get(String(l.productId))
    if (!p) throw new Error(`Row ${i + 1}: item not found`)
    const qty = Number(l.qty), cost = Number(l.cost), rate = Number(l.taxRate ?? 0)
    if (!(qty > 0 && qty <= 1e7)) throw new Error(`${p.name}: enter the quantity`)
    if (!(cost >= 0 && cost <= 1e8)) throw new Error(`${p.name}: enter the cost price`)
    if (!(rate >= 0 && rate <= 100)) throw new Error(`${p.name}: GST must be between 0 and 100%`)
    const hsn = cleanHsn(l.hsn ?? p.hsn)
    if (hsnError(hsn)) throw new Error(`${p.name}: ${hsnError(hsn)}`)
    const expiry = String(l.expiry ?? '').trim()
    if (p.trackExpiry && !expiry) throw new Error(`${p.name}: enter the expiry date of this batch`)
    if (expiry && !validDay(expiry)) throw new Error(`${p.name}: expiry date is not valid`)
    const key = `${l.productId}|${String(l.batchNo ?? '').trim()}|${expiry}`
    if (seen.has(key)) throw new Error(`${p.name} is on the bill twice — add the quantities together`)
    seen.add(key)
    const taxable = r2(qty * cost)
    return {
      productId: String(l.productId), name: p.name, unit: p.unit, hsn, qty: Math.round(qty * 1000) / 1000, cost: r2(cost), taxRate: rate,
      taxable, tax: r2((taxable * rate) / 100), ...(l.batchNo ? { batchNo: String(l.batchNo).replace(/['"\\]/g, '').trim().slice(0, 40) } : {}), ...(expiry ? { expiry } : {}),
    }
  })
  const taxable = r2(out.reduce((a, l) => a + l.taxable, 0))
  const tax = r2(out.reduce((a, l) => a + l.tax, 0))
  const raw = r2(taxable + tax)
  const total = input.roundOff === false ? raw : Math.round(raw)
  const paid = r2(Number(input.paid ?? 0))
  if (!(paid >= 0)) throw new Error('Enter the amount paid')
  if (paid > total + 0.001) throw new Error('Paid now can’t be more than the bill total')
  if (paid > 0 && !SUPPLIER_PAY_METHODS.includes(input.method)) throw new Error('Choose how it was paid')
  return { date, lines: out, taxable, tax, roundOff: r2(total - raw), total, paid, balance: r2(total - paid), supplierBillNo: String(input.supplierBillNo ?? '').trim().slice(0, 40), note: String(input.note ?? '').trim().slice(0, 255) }
}

/** A supplier's statement: opening balance, purchase bills (+) and payments (−), oldest first. */
export function supplierLedger(opening: number, purchases: Pick<Purchase, 'id' | 'number' | 'supplierBillNo' | 'date' | 'total' | 'status' | 'createdAt'>[], payments: Pick<SupplierPayment, 'id' | 'date' | 'amount' | 'method' | 'reference' | 'voided' | 'createdAt'>[]): { rows: SupplierLedgerRow[]; balance: number } {
  type E = { date: string; at: string; row: Omit<SupplierLedgerRow, 'balance'> }
  const events: E[] = []
  for (const p of purchases) {
    events.push({ date: p.date, at: p.createdAt, row: { date: p.date, kind: 'purchase', ref: `${p.number}${p.supplierBillNo ? ` · bill ${p.supplierBillNo}` : ''}`, debit: p.total, credit: 0, id: p.id } })
    if (p.status === 'void') events.push({ date: p.date, at: `${p.createdAt}~`, row: { date: p.date, kind: 'void', ref: `${p.number} voided`, debit: 0, credit: p.total, id: p.id } })
  }
  for (const x of payments.filter((y) => !y.voided)) events.push({ date: x.date, at: x.createdAt, row: { date: x.date, kind: 'payment', ref: `Paid (${x.method})${x.reference ? ` · ${x.reference}` : ''}`, debit: 0, credit: x.amount, id: x.id } })
  events.sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at))
  let balance = r2(opening)
  const rows: SupplierLedgerRow[] = opening ? [{ date: '', kind: 'opening', ref: 'Opening balance', debit: opening > 0 ? opening : 0, credit: opening < 0 ? -opening : 0, balance, id: null }] : []
  for (const e of events) { balance = r2(balance + e.row.debit - e.row.credit); rows.push({ ...e.row, balance }) }
  return { rows, balance }
}
