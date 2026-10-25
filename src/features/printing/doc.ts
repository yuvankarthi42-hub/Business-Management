// Printer-neutral receipt layout. The same lines are sent as ESC/POS text or drawn as an image
// (for Tamil and other scripts the printer's built-in fonts can't show).
import { isTextile, ORDER_TYPE_LABEL } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { discountParts, lineMrp, lineTotal, mrpSaved, preGstLines, r2, taxableValue, taxBreakup, taxIncluded } from '@/core/pricing'
import { stateLabel } from '@/core/gst'
import { formatPhone } from '@/core/phone'
import { amountInWords } from '@/lib/format'
import type { ReceiptProps } from '../Payment'

export type Align = 'left' | 'center' | 'right'
export type Line =
  | { k: 'text'; s: string; align?: Align; bold?: boolean; big?: boolean; small?: boolean }
  /** First cell takes the remaining width (wraps); the others are right-aligned in `widths` characters. */
  | { k: 'row'; cells: string[]; widths?: number[]; bold?: boolean; big?: boolean }
  | { k: 'hr'; strong?: boolean }
  | { k: 'feed'; n: number }

export type Paper = '58mm' | '80mm'
/** Characters per line in the printer's standard font (Font A). */
export const CHARS: Record<Paper, number> = { '58mm': 32, '80mm': 48 }
/** Printable width in dots at 203 dpi. */
export const DOTS: Record<Paper, number> = { '58mm': 384, '80mm': 576 }

const d2 = (n: number) => n.toFixed(2)
const fmtBillDate = (d: string) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}` }
const fmtBillTime = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()

/** Mirrors <Receipt/> so the paper bill matches the on-screen preview. */
export function receiptDoc({ order: o, business: b, branch, customer, users = [], tableLabel }: ReceiptProps, paper: Paper): Line[] {
  const narrow = paper === '58mm'
  const address = branch?.address || b.address
  const phone = branch?.phone || b.phone
  const who = (id: string) => (id === 'guest' ? 'QR order' : users.find((u) => u.id === id)?.name)
  const cashier = o.billedAt ? who(o.updatedBy) : null
  const waiter = o.type === 'dine_in' ? who(o.createdBy) : o.salespersonId ? who(o.salespersonId) : null
  const gst = b.billing.taxRates.some((r) => /gst/i.test(r.name))
  const taxes = taxBreakup(o.items, o.discount, b.billing, o.tax)
  const qty = o.items.reduce((s, i) => s + i.qty, 0)
  const cols = narrow ? [4, 9] : [5, 9, 10]
  const kv = (l: string, r: string, bold?: boolean): Line => ({ k: 'row', cells: [l, r], widths: [Math.max(r.length, 1)], bold })
  const out: Line[] = []
  const t = (s: string | null | undefined, x: Omit<Extract<Line, { k: 'text' }>, 'k' | 's'> = {}) => { if (s) out.push({ k: 'text', s, ...x }) }

  t(b.name.toUpperCase(), { align: 'center', bold: true, big: true })
  t(b.subType, { align: 'center' })
  if (branch && !branch.isDefault) t(`${branch.name} branch`, { align: 'center', bold: true })
  t(address, { align: 'center' })
  if (phone) t(`Ph: ${formatPhone(phone)}`, { align: 'center' })
  if (b.gstin) t(`GSTIN: ${b.gstin}`, { align: 'center' })
  out.push({ k: 'hr', strong: true })
  t(o.tax > 0 ? 'TAX INVOICE' : 'BILL', { align: 'center', bold: true })
  out.push({ k: 'hr' })
  out.push(kv(`Bill No: ${o.invoiceNumber ?? '-'}`, fmtBillDate(o.billedAt ?? o.createdAt)))
  out.push(kv(`Order: ${o.number}`, fmtBillTime(o.billedAt ?? o.createdAt)))
  t(`${ORDER_TYPE_LABEL[o.type]}${tableLabel ? ` · Table ${tableLabel}` : ''}`.toUpperCase(), { bold: true })
  if (cashier || waiter) out.push(kv(cashier ? `Cashier: ${cashier}` : '', waiter ? `${o.type === 'dine_in' ? 'Waiter' : 'Sales'}: ${waiter}` : ''))
  if (customer) out.push(kv(`${b.terminology.customer.singular}: ${customer.name}`, formatPhone(customer.phone)))
  else if (o.guest?.name) out.push(kv(`Name: ${o.guest.name}`, formatPhone(o.guest.phone)))
  if (o.type === 'delivery' && (o.guest?.address || customer?.address)) t(`Deliver to: ${o.guest?.address || customer?.address}`)
  if (o.customerGstin) t(`Buyer GSTIN: ${o.customerGstin}`, { bold: true })
  if ((o.customerGstin || o.igst) && o.placeOfSupply) t(`Place of supply: ${stateLabel(o.placeOfSupply)}`)
  out.push({ k: 'hr' })
  const incl = taxIncluded(b.billing, o.tax)
  const pre = isTextile(b) && incl ? preGstLines(o) : null
  if (isTextile(b)) {
    // Textile: Item | MRP | Disc. price before GST (or the final amount when GST isn't inside the price).
    const tw = narrow ? [9, 11] : [11, 12]
    out.push({ k: 'row', cells: ['Item', 'MRP', pre ? 'Disc.Price' : 'Final Amt'], widths: tw, bold: true })
    out.push({ k: 'hr' })
    for (const [k, i] of o.items.entries()) {
      out.push({ k: 'row', cells: [itemLabel(i), d2(lineMrp(i)), d2(pre ? pre.lines[k] : lineTotal(i))], widths: tw })
      const sub = [i.qty !== 1 ? `${i.qty} x ${d2(i.mrp ?? i.unitPrice)}` : '', i.hsn ? `HSN ${i.hsn}` : ''].filter(Boolean).join(' · ')
      if (sub) t(`  ${sub}`, { small: true })
    }
  } else {
  out.push({ k: 'row', cells: narrow ? ['Item', 'Qty', 'Amt'] : ['Item', 'Qty', 'Rate', 'Amt'], widths: cols, bold: true })
  out.push({ k: 'hr' })
  for (const i of o.items) {
    out.push({ k: 'row', cells: narrow ? [itemLabel(i), String(i.qty), d2(lineTotal(i))] : [itemLabel(i), String(i.qty), d2(i.unitPrice), d2(lineTotal(i))], widths: cols })
    const sub = [narrow ? `@ ${d2(i.unitPrice)}` : '', i.listPrice !== undefined && !i.mrp ? `was ${d2(i.listPrice)}` : '', i.mrp ? `MRP ${d2(i.mrp)}` : '', i.hsn ? `HSN ${i.hsn}` : '', i.addOns.length ? `+ ${i.addOns.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · ')
    if (sub) t(`  ${sub}`, { small: true })
  }
  }
  out.push({ k: 'hr' })
  t(`Items: ${o.items.length} · Qty: ${qty}`)
  // Prices include GST: Taxable value + CGST + SGST (+ round off) = TOTAL, so the lines add up.
  if (pre) {
    if (o.items.length > 1 || pre.discount > 0) out.push(kv('Total before GST', d2(pre.lines.reduce((a, x) => a + x, 0))))
    const pp = discountParts(o, pre.discount)
    if (pp.manual > 0) out.push(kv('Bill discount', `-${d2(pp.manual)}`))
    if (pp.points > 0) out.push(kv(`Points used (${o.pointsRedeemed})`, `-${d2(pp.points)}`))
  } else if (!incl || o.discount > 0) out.push(kv(incl ? 'Items total' : 'Subtotal', d2(o.subtotal)))
  const parts = discountParts(o)
  if (!pre && parts.manual > 0) out.push(kv('Discount', `-${d2(parts.manual)}`))
  if (!pre && parts.points > 0) out.push(kv(`Points used (${o.pointsRedeemed})`, `-${d2(parts.points)}`))
  if (incl && !pre) out.push(kv('Taxable value', d2(taxableValue(o))))
  for (const x of taxes) {
    if (o.igst) out.push(kv(`IGST @ ${x.rate}%`, d2(x.tax)))
    else if (gst) { out.push(kv(`CGST @ ${x.rate / 2}%`, d2(r2(x.tax / 2)))); out.push(kv(`SGST @ ${x.rate / 2}%`, d2(r2(x.tax - r2(x.tax / 2))))) }
    else out.push(kv(`Tax @ ${x.rate}%`, d2(x.tax)))
  }
  if (b.billing.roundOff) out.push(kv('Round off', d2(o.roundOff)))
  out.push({ k: 'hr', strong: true })
  out.push({ k: 'row', cells: ['TOTAL', `${b.currencySymbol}${d2(o.total)}`], bold: true, big: true })
  t(amountInWords(o.total), { align: 'center', small: true })
  if (incl && !pre) t('(Prices include GST)', { align: 'center', small: true })
  const saved = mrpSaved(o)
  if (saved > 0) { out.push({ k: 'hr' }); t(`You saved ${b.currencySymbol}${d2(saved)} on MRP`, { align: 'center', bold: true }) }
  const pts = [o.pointsRedeemed ? `Points used ${o.pointsRedeemed}` : '', o.pointsEarned ? `Earned ${o.pointsEarned}` : '', o.pointsBalance != null && o.customerId ? `Balance ${o.pointsBalance}` : ''].filter(Boolean)
  if (pts.length) t(pts.join(' · '), { align: 'center' })
  if (o.balance > 0) {
    out.push({ k: 'hr' })
    out.push(kv('Paid', d2(o.paid)))
    out.push(kv('Balance due', `${b.currencySymbol}${d2(o.balance)}`, true))
  }
  if (b.billing.receiptFooter.trim()) { out.push({ k: 'hr' }); t(b.billing.receiptFooter.trim(), { align: 'center' }) }
  return out
}

/** A short page to check alignment, width and the cutter. */
export function testDoc(shop: string, paper: Paper): Line[] {
  return [
    { k: 'text', s: shop.toUpperCase(), align: 'center', bold: true, big: true },
    { k: 'text', s: 'Printer test', align: 'center' },
    { k: 'hr', strong: true },
    { k: 'row', cells: ['Paper', paper], widths: [6] },
    { k: 'row', cells: ['Characters per line', String(CHARS[paper])], widths: [4] },
    { k: 'text', s: '1234567890'.repeat(5).slice(0, CHARS[paper]) },
    { k: 'hr' },
    { k: 'row', cells: ['Item', 'Qty', 'Amt'], widths: [4, 9], bold: true },
    { k: 'row', cells: ['Masala Dosa', '2', '160.00'], widths: [4, 9] },
    { k: 'row', cells: ['பால் 500 ml (Tamil)', '1', '27.00'], widths: [4, 9] },
    { k: 'hr', strong: true },
    { k: 'row', cells: ['TOTAL', '₹187.00'], bold: true, big: true },
    { k: 'text', s: 'If you can read this, printing works.', align: 'center', small: true },
  ]
}

/** True when a line has characters outside plain ASCII (₹ is handled as "Rs."). */
export const needsImage = (doc: Line[]) => doc.some((l) => {
  const s = l.k === 'text' ? l.s : l.k === 'row' ? l.cells.join('') : ''
  return /[^\x20-\x7E₹·–—’‘“”]/.test(s)
})
