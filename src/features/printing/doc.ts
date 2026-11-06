// Printer-neutral receipt layout. The same lines are sent as ESC/POS text or drawn as an image
// (for Tamil and other scripts the printer's built-in fonts can't show).
import { isTextile, ORDER_TYPE_LABEL } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { discountParts, lineMrp, lineTotal, mrpSaved, preGstLines, r2, taxableValue, taxBreakup, taxIncluded } from '@/core/pricing'
import { GST_STATES, stateLabel } from '@/core/gst'
import { formatPhone } from '@/core/phone'
import { amountInWords } from '@/lib/format'
import { LAYOUT_COLS, type BillCol, type BillFormat } from '@/core/billFormat'
import type { Branch, Business, Customer, Order, OrderItem } from '@/core/types'

export type Align = 'left' | 'center' | 'right'
/** Which part of a formatted bill a line is (Settings → Bill design highlights it; printing ignores it). */
export type BillSection = 'shop' | 'bill' | 'items' | 'totals'
export type Line = (
  | { k: 'text'; s: string; align?: Align; bold?: boolean; big?: boolean; small?: boolean }
  /** First cell takes the remaining width (wraps); the others are right-aligned in `widths` characters. */
  | { k: 'row'; cells: string[]; widths?: number[]; bold?: boolean; big?: boolean }
  | { k: 'hr'; strong?: boolean }
  | { k: 'feed'; n: number }
) & { sec?: BillSection }

/** What a bill is printed from (the bill screen, the printer, Settings preview). */
export interface ReceiptProps {
  order: Order
  business: Business
  /** Branch that made the bill — its address / phone are printed when set. */
  branch?: Branch | null
  customer?: Customer | null
  /** Staff list used to print cashier / waiter names. */
  users?: { id: string; name: string }[]
  tableLabel?: string | null
}

export type Paper = '58mm' | '80mm'
/** Characters per line in the printer's standard font (Font A). */
export const CHARS: Record<Paper, number> = { '58mm': 32, '80mm': 48 }
/** Printable width in dots at 203 dpi. */
export const DOTS: Record<Paper, number> = { '58mm': 384, '80mm': 576 }

const d2 = (n: number) => n.toFixed(2)
/** Column names shortened when 58 mm paper has no room for them. */
const SHORT: Record<string, string> = { Discount: 'Disc', Amount: 'Amt', Quantity: 'Qty', Price: 'Rate' }
const fmtBillDate = (d: string) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}` }
const fmtBillTime = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()

/**
 * The bill's lines. A bill from a branch with a bill format (Settings → Printer and bill) gets that layout (billDoc);
 * otherwise the bill exactly as it always printed — which <Receipt/> mirrors on screen.
 */
export function receiptDoc(props: ReceiptProps, paper: Paper): Line[] {
  const f = props.branch?.billFormat
  return f ? billDoc(props, paper, f) : classicDoc(props, paper)
}

function classicDoc({ order: o, business: b, branch, customer, users = [], tableLabel }: ReceiptProps, paper: Paper): Line[] {
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

/** One item's numbers on a formatted bill: Rate × Qty − Discount = Amount, exactly as charged. */
export function billLineValues(i: Pick<OrderItem, 'qty' | 'unitPrice' | 'listPrice' | 'mrp' | 'addOns'>) {
  const amount = lineTotal(i)
  // Rate: the item's selling price before a discount given at the counter (a price raised at the counter is the rate).
  const rate = i.listPrice !== undefined && i.listPrice > i.unitPrice ? i.listPrice : i.unitPrice
  const discount = Math.max(0, r2(r2(rate * i.qty) - amount))
  const mrp = i.mrp ? r2(i.mrp + i.addOns.reduce((a, x) => a + x.price, 0)) : rate
  // Saved against the higher of MRP and rate (what the customer would otherwise pay).
  const saved = Math.max(0, r2(r2(Math.max(mrp, rate) * i.qty) - amount))
  return { rate, discount, amount, mrp, saved }
}

/** Quantity as the format wants it; loose quantities always keep the decimals they have (up to 3). */
export function fmtQty(q: number, dec: BillFormat['qtyDecimals']) {
  const s = String(Math.round(q * 1000) / 1000)
  const need = s.includes('.') ? s.split('.')[1].length : 0 // decimals the quantity really has (0–3)
  const d = dec === 'auto' ? (need ? 3 : 0) : Math.max(dec, need)
  return q.toFixed(d)
}

const slash = (d: string) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}` }

/** The bill in the shop's own format (Settings → Printer and bill). Money lines are the same as the classic bill's. */
export function billDoc({ order: o, business: b, branch, customer, users = [], tableLabel }: ReceiptProps, paper: Paper, f: BillFormat): Line[] {
  const W = CHARS[paper]
  const T = f.top, B = f.bottom
  const out: Line[] = []
  const t = (s: string | null | undefined, x: Omit<Extract<Line, { k: 'text' }>, 'k' | 's'> = {}) => { if (s) out.push({ k: 'text', s, ...x }) }
  const kv = (l: string, r: string, bold?: boolean): Line => ({ k: 'row', cells: [l, r], widths: [Math.max(r.length, 1)], bold })
  const lab = (label: string, value: string) => (label ? `${label}: ${value}` : value)
  const who = (id: string) => (id === 'guest' ? 'QR order' : users.find((u) => u.id === id)?.name)
  const gst = b.billing.taxRates.some((r) => /gst/i.test(r.name))
  const gstBill = b.billing.taxEnabled && gst
  const name = f.name1.trim() || b.name
  const cur = b.currencySymbol
  let from = 0
  const mark = (sec: BillSection) => { for (let i = from; i < out.length; i++) out[i].sec = sec; from = out.length }

  // ---- top ----
  t(name, { align: 'center', bold: true, big: true })
  if (T.name2.on) t(f.name2, { align: 'center', bold: true })
  if (branch && !branch.isDefault) t(`${branch.name} branch`, { align: 'center' })
  if (T.address.on) for (const a of (f.address.trim() || branch?.address || b.address || '').split('\n')) t(a.trim(), { align: 'center' })
  const phone = branch?.phone || b.phone
  if (T.phone.on && (phone || f.phone2)) t(lab(T.phone.label, [phone ? formatPhone(phone) : '', f.phone2].filter(Boolean).join(', ')), { align: 'center' })
  // GSTIN always prints when the shop bills with GST (a tax invoice must show it).
  if (b.gstin && (T.gstin.on || gstBill)) t(lab(T.gstin.label || 'GSTIN', b.gstin), { align: 'center' })
  if (T.email.on && b.email) t(lab(T.email.label, b.email), { align: 'center' })
  mark('shop')
  out.push({ k: 'hr', strong: true })
  // A bill with GST is always headed TAX INVOICE; the shop's own title goes under it.
  if (o.tax > 0) t('TAX INVOICE', { align: 'center', bold: true })
  if (T.title.on) t(f.title.trim() || (o.tax > 0 ? '' : 'BILL'), { align: 'center', bold: true })
  out.push({ k: 'hr' })
  const when = o.billedAt ?? o.createdAt
  // Left and right on one line; one under the other when both don't fit (58 mm).
  const pair = (l: string, r: string) => { if (l && r && l.length + r.length + 1 > W) { t(l); out.push(kv('', r)) } else if (l || r) out.push(kv(l, r)) }
  pair(T.billNo.on ? lab(T.billNo.label, o.invoiceNumber ?? '-') : '', T.date.on ? lab(T.date.label, slash(when)) : '')
  pair(T.orderNo.on ? lab(T.orderNo.label, o.number) : '', T.time.on ? lab(T.time.label, fmtBillTime(when)) : '')
  const cashier = o.billedAt ? who(o.updatedBy) : null
  const waiter = o.type === 'dine_in' ? who(o.createdBy) : o.salespersonId ? who(o.salespersonId) : null
  pair(T.cashier.on && cashier ? lab(T.cashier.label, cashier) : '', T.waiter.on && waiter ? lab(T.waiter.label, waiter) : '')
  if (tableLabel && o.type === 'dine_in') t(`Table: ${tableLabel}`)
  if (T.customer.on) {
    if (customer) out.push(kv(lab(T.customer.label, customer.name), formatPhone(customer.phone)))
    else if (o.guest?.name) out.push(kv(lab(T.customer.label, o.guest.name), formatPhone(o.guest.phone)))
    else if (f.cashSales) t(lab(T.customer.label, f.cashSales))
  }
  if (o.type === 'delivery' && (o.guest?.address || customer?.address)) t(`Deliver to: ${o.guest?.address || customer?.address}`)
  if (o.customerGstin) t(`Buyer GSTIN: ${o.customerGstin}`, { bold: true })
  const pos = o.placeOfSupply || b.stateCode || (b.gstin ? b.gstin.slice(0, 2) : '')
  if ((o.customerGstin || o.igst) && o.placeOfSupply) t(`Place of supply: ${stateLabel(o.placeOfSupply)}`)
  // The shop's state (from Business Profile, else its GSTIN), whenever the owner switches it on.
  else if (T.state.on && pos && GST_STATES[pos]) t(`State: ${GST_STATES[pos]} (${pos})`)
  out.push({ k: 'hr' })

  mark('bill')
  // ---- items ----
  const cols = LAYOUT_COLS[f.layout].filter((c) => c !== 'no' && c !== 'item') as Exclude<BillCol, 'no' | 'item'>[]
  const showNo = LAYOUT_COLS[f.layout].includes('no')
  const lines = o.items.map((i) => ({ i, v: billLineValues(i) }))
  const cell = (c: (typeof cols)[number], x: (typeof lines)[number]) =>
    c === 'qty' ? fmtQty(x.i.qty, f.qtyDecimals) : d2(c === 'mrp' ? x.v.mrp : c === 'rate' ? x.v.rate : c === 'disc' ? x.v.discount : x.v.amount)
  // Column widths from what they hold (rowLines puts one space between columns).
  const widths = cols.map((c) => Math.max(f.cols[c].length, ...lines.map((x) => cell(c, x).length), 4))
  const noW = showNo ? Math.max(f.cols.no.length, String(lines.length).length + 1) + 1 : 0
  // Too many columns for the paper (58 mm): the item name on its own line, the numbers under it.
  const twoLines = W - widths.reduce((a, x) => a + x + 1, 0) - noW < 8
  const head = (showNo ? f.cols.no.padEnd(noW) : '') + f.cols.item
  // Two-line mode: the numbers are one right-aligned line; a column name longer than its numbers is shortened
  // when the line would not fit the paper.
  const numW = cols.map((c) => Math.max(...lines.map((x) => cell(c, x).length), 3))
  const fit = widths.reduce((a, x) => a + x + 1, -1) <= W ? widths : numW
  const nums = (cs: string[]) => cs.map((c, k) => (c.length > fit[k] ? SHORT[c] ?? c : c).slice(0, fit[k]).padStart(fit[k])).join(' ').padStart(W)
  if (twoLines) { t(head, { bold: true }); t(nums(cols.map((c) => f.cols[c])), { bold: true }) }
  else out.push({ k: 'row', cells: [head, ...cols.map((c) => f.cols[c])], widths, bold: true })
  out.push({ k: 'hr' })
  lines.forEach((x, n) => {
    const nm = (showNo ? `${n + 1}.`.padEnd(noW) : '') + itemLabel(x.i)
    if (twoLines) { t(nm); t(nums(cols.map((c) => cell(c, x)))) }
    else out.push({ k: 'row', cells: [nm, ...cols.map((c) => cell(c, x))], widths })
    const sub = [x.i.hsn ? `HSN ${x.i.hsn}` : '', x.i.addOns.length ? `+ ${x.i.addOns.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · ')
    if (sub) t(`  ${sub}`, { small: true })
  })
  out.push({ k: 'hr' })

  mark('items')
  // ---- totals (the same money lines as the classic bill, so totals never differ) ----
  const qty = o.items.reduce((s, i) => s + i.qty, 0)
  const incl = taxIncluded(b.billing, o.tax)
  const taxes = taxBreakup(o.items, o.discount, b.billing, o.tax)
  if (B.totalQty.on) {
    const q = fmtQty(r2(qty * 1000) / 1000, f.qtyDecimals)
    out.push({ k: 'row', cells: [B.totalQty.label || 'Total', q, d2(o.subtotal)], widths: [q.length, Math.max(d2(o.subtotal).length, widths[widths.length - 1] ?? 8)], bold: true })
  } else if (!incl || o.discount > 0) out.push(kv(incl ? 'Items total' : 'Subtotal', d2(o.subtotal)))
  const parts = discountParts(o)
  if (parts.manual > 0) out.push(kv('Bill discount', `-${d2(parts.manual)}`))
  if (parts.points > 0) out.push(kv(`Points used (${o.pointsRedeemed})`, `-${d2(parts.points)}`))
  if (incl) out.push(kv('Taxable value', d2(taxableValue(o))))
  for (const x of taxes) {
    if (o.igst) out.push(kv(`IGST @ ${x.rate}%`, d2(x.tax)))
    else if (gst) { out.push(kv(`CGST @ ${x.rate / 2}%`, d2(r2(x.tax / 2)))); out.push(kv(`SGST @ ${x.rate / 2}%`, d2(r2(x.tax - r2(x.tax / 2))))) }
    else out.push(kv(`Tax @ ${x.rate}%`, d2(x.tax)))
  }
  // Round off is part of the total: printed whenever it isn't zero (only its name can change).
  if (b.billing.roundOff && o.roundOff !== 0) out.push(kv(B.roundOff.label || 'Round off', d2(o.roundOff)))
  out.push({ k: 'hr', strong: true })
  if (B.orderType.on) t(`${ORDER_TYPE_LABEL[o.type]}`.toUpperCase(), { bold: true })
  out.push({ k: 'row', cells: [B.total.label || 'TOTAL', `${cur}${d2(o.total)}`], bold: true, big: B.total.on })
  if (B.words.on) t(amountInWords(o.total), { align: 'center', small: true })
  if (incl) t('(Prices include GST)', { align: 'center', small: true })
  const saved = r2(lines.reduce((a, x) => a + x.v.saved, 0) + Math.max(0, o.discount))
  if (B.savings.on && saved > 0) out.push(kv(B.savings.label || 'You saved', `${cur}${d2(saved)}`, true))
  const pts = [o.pointsRedeemed ? `Points used ${o.pointsRedeemed}` : '', o.pointsEarned ? `Earned ${o.pointsEarned}` : '', o.pointsBalance != null && o.customerId ? `Balance ${o.pointsBalance}` : ''].filter(Boolean)
  if (pts.length) t(pts.join(' · '), { align: 'center' })
  // A bill not fully paid always shows what was paid and what is still due.
  if (B.received.on || o.balance > 0) { out.push({ k: 'hr' }); out.push(kv(B.received.label || 'Received', d2(o.paid))) }
  if (o.balance > 0) out.push(kv('Balance due', `${cur}${d2(o.balance)}`, true))
  if (B.signature.on) { out.push({ k: 'feed', n: 1 }); t(`${B.signature.label || 'For'} ${name}`.trim(), { align: 'right' }) }
  const foot = [f.footer1.trim(), f.footer2.trim()].filter(Boolean)
  if (foot.length) { out.push({ k: 'hr' }); for (const s of foot) t(s, { align: 'center' }) }
  mark('totals')
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
