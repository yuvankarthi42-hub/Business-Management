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
