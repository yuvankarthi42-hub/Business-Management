// Pure pricing/tax calculations. Kept framework-free so the same logic can move to the backend.
import type { BillingSettings, OrderItem } from './types'

/** Round to 2 decimals without floating drift. */
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface Totals {
  subtotal: number
  discount: number
  tax: number
  roundOff: number
  total: number
}

export const lineTotal = (i: Pick<OrderItem, 'qty' | 'unitPrice'>) => r2(i.qty * i.unitPrice)
/** Line at printed MRP (the line total when the item has no MRP above its price). Textile bills: "MRP" column. */
export const lineMrp = (i: Pick<OrderItem, 'qty' | 'unitPrice' | 'mrp' | 'addOns'>) => (i.mrp ? r2((i.mrp + i.addOns.reduce((a, x) => a + x.price, 0)) * i.qty) : lineTotal(i))

/** Saved against the printed MRP on these lines (add-ons don't count), plus the bill discount. */
export function savedOnBill(items: Pick<OrderItem, 'qty' | 'unitPrice' | 'mrp' | 'addOns'>[], discount = 0) {
  const lines = items.reduce((s, i) => {
    const base = i.unitPrice - i.addOns.reduce((a, x) => a + x.price, 0)
    return s + (i.mrp && i.mrp > base ? (i.mrp - base) * i.qty : 0)
  }, 0)
  return r2(lines + Math.max(0, discount || 0))
}

/** "You saved" on a receipt: only when some line has an MRP above its price. */
export const mrpSaved = (o: { items: Pick<OrderItem, 'qty' | 'unitPrice' | 'mrp' | 'addOns'>[]; discount: number }) => (o.items.some((i) => i.mrp) ? savedOnBill(o.items, o.discount) : 0)

/**
 * Discount is distributed proportionally across lines before tax.
 * Inclusive mode: prices contain tax, so tax is extracted; total = subtotal - discount.
 * Exclusive mode: tax is added on top of the discounted line value.
 */
export function computeTotals(items: OrderItem[], discount: number, billing: BillingSettings): Totals {
  const subtotal = r2(items.reduce((s, i) => s + lineTotal(i), 0))
  const disc = Math.min(Math.max(0, r2(discount || 0)), subtotal)
  let tax = 0
  if (billing.taxEnabled && subtotal > 0) {
    for (const i of items) {
      const line = lineTotal(i)
      const net = line - (disc * line) / subtotal
      tax += billing.taxMode === 'inclusive' ? net - net / (1 + i.taxRate / 100) : (net * i.taxRate) / 100
    }
  }
  tax = r2(tax)
  const raw = billing.taxMode === 'inclusive' || !billing.taxEnabled ? subtotal - disc : subtotal - disc + tax
  const total = billing.roundOff ? Math.round(raw) : r2(raw)
  return { subtotal, discount: disc, tax, roundOff: r2(total - raw), total }
}

/** Prices include tax: the value before GST, so Taxable value + GST + round off = Total on the bill. */
export const taxableValue = (t: Pick<Totals, 'subtotal' | 'discount' | 'tax'>) => r2(t.subtotal - t.discount - t.tax)
/** True when the bill should show "Taxable value + GST = Total" (tax is inside the prices). */
export const taxIncluded = (billing: Pick<BillingSettings, 'taxEnabled' | 'taxMode'>, tax: number) => billing.taxEnabled && billing.taxMode === 'inclusive' && tax > 0

/**
 * Textile bills with GST inside the price: each line's price before GST, and the bill discount before GST,
 * so that  Σ lines − discount + GST + round off = TOTAL  exactly (paise left over by rounding go on the last line).
 */
export function preGstLines(o: { items: Pick<OrderItem, 'qty' | 'unitPrice' | 'taxRate'>[]; subtotal: number; discount: number; tax: number }) {
  const lines = o.items.map((i) => r2(lineTotal(i) / (1 + (i.taxRate || 0) / 100)))
  const target = taxableValue(o) // value before GST, after the bill discount
  if (!(o.discount > 0) && lines.length) {
    lines[lines.length - 1] = r2(lines[lines.length - 1] + r2(target - lines.reduce((a, x) => a + x, 0)))
    return { lines, discount: 0 }
  }
  return { lines, discount: r2(lines.reduce((a, x) => a + x, 0) - target) }
}

export interface TaxLine { rate: number; taxable: number; tax: number }

/**
 * Tax grouped by rate (same proportional-discount rules as computeTotals), adjusted so the
 * lines add up exactly to the order's stored tax. Used for the CGST / SGST split on bills.
 */
export function taxBreakup(items: OrderItem[], discount: number, billing: BillingSettings, orderTax: number): TaxLine[] {
  if (!billing.taxEnabled || orderTax <= 0) return []
  const subtotal = items.reduce((s, i) => s + lineTotal(i), 0)
  const groups = new Map<number, TaxLine>()
  for (const i of items) {
    if (!i.taxRate) continue
    const line = lineTotal(i)
    const net = subtotal ? line - (discount * line) / subtotal : line
    const base = billing.taxMode === 'inclusive' ? net / (1 + i.taxRate / 100) : net
    const g = groups.get(i.taxRate) ?? { rate: i.taxRate, taxable: 0, tax: 0 }
    g.taxable += base
    g.tax += (base * i.taxRate) / 100
    groups.set(i.taxRate, g)
  }
  const lines = [...groups.values()].sort((a, b) => a.rate - b.rate).map((g) => ({ rate: g.rate, taxable: r2(g.taxable), tax: r2(g.tax) }))
  const drift = r2(orderTax - lines.reduce((s, l) => s + l.tax, 0))
  if (lines.length && drift !== 0) lines[lines.length - 1].tax = r2(lines[lines.length - 1].tax + drift)
  return lines
}

/** Bill discount split into the cashier's discount and loyalty points used (both already inside `discount`). */
export function discountParts(o: { discount: number; pointsValue?: number }, preGstDiscount?: number) {
  const pts = Math.min(o.pointsValue ?? 0, o.discount)
  if (preGstDiscount === undefined) return { manual: r2(o.discount - pts), points: r2(pts) }
  const p = o.discount > 0 ? r2((preGstDiscount * pts) / o.discount) : 0
  return { manual: r2(preGstDiscount - p), points: p }
}
