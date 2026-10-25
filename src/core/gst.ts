// GST rules shared by the app, the demo API and the backend: GSTIN checks, place of supply (IGST vs
// CGST + SGST), HSN codes, the per-line tax split of a bill, and the monthly GSTR-1 / GSTR-3B summary.
import { lineTotal, r2 } from './pricing'
import type { BillingSettings, Business, Category, OrderItem, Product } from './types'

/** GST state codes (first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
}
export const stateLabel = (code: string | null | undefined) => (code && GST_STATES[code] ? `${code} · ${GST_STATES[code]}` : '')

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** The 15th character of a GSTIN, from the first 14. */
export function gstinCheckChar(first14: string) {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1)
    sum += Math.floor(v / 36) + (v % 36)
  }
  return CHARS[(36 - (sum % 36)) % 36]
}
export const cleanGstin = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/\s+/g, '')
const GSTIN_RE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
/** Empty string = fine (no GSTIN). Otherwise the reason it isn't a valid GSTIN. */
export function gstinError(raw: string | null | undefined): string {
  const g = cleanGstin(raw)
  if (!g) return ''
  if (g.length !== 15) return 'A GSTIN has 15 characters'
  const m = GSTIN_RE.exec(g)
  if (!m) return 'This GSTIN doesn’t look right — check it on the bill'
  if (!GST_STATES[m[1]]) return 'The first two digits of the GSTIN are not a state code'
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return 'This GSTIN has a typing mistake (the last character doesn’t match)'
  return ''
}
export const gstinState = (g: string | null | undefined) => { const x = cleanGstin(g); return x.length >= 2 && GST_STATES[x.slice(0, 2)] ? x.slice(0, 2) : null }

/** The shop's state: from its GSTIN, else the state chosen in Settings. */
export const shopStateOf = (b: Pick<Business, 'gstin' | 'stateCode'>) => gstinState(b.gstin) ?? (b.stateCode && GST_STATES[b.stateCode] ? b.stateCode : null)

/** Place of supply for a customer (their GSTIN's state, else the state saved on them). */
export const customerStateOf = (c: { gstin?: string | null; stateCode?: string | null } | null | undefined) =>
  c ? gstinState(c.gstin) ?? (c.stateCode && GST_STATES[c.stateCode] ? c.stateCode : null) : null

/** IGST when both states are known and differ. */
export const isInterState = (shopState: string | null, otherState: string | null) => !!shopState && !!otherState && shopState !== otherState

/** HSN (goods: 4, 6 or 8 digits) or SAC (services: 6 digits starting 99). Empty is allowed. */
export function hsnError(raw: string | null | undefined) {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  return /^\d{4}(\d{2}(\d{2})?)?$/.test(v) ? '' : 'HSN / SAC code is 4, 6 or 8 digits'
}
export const cleanHsn = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, '').slice(0, 8)
/** The item's own code, else its category's. */
export const hsnOf = (p: Pick<Product, 'hsn' | 'categoryId'>, categories: Pick<Category, 'id' | 'hsn'>[]) =>
  (p.hsn && p.hsn.trim()) || categories.find((c) => c.id === p.categoryId)?.hsn?.trim() || ''

/** GST unit codes (UQC) for the HSN summary. */
const UQC: Record<string, string> = { pc: 'NOS', plate: 'NOS', cup: 'NOS', glass: 'NOS', bowl: 'NOS', half: 'NOS', full: 'NOS', kg: 'KGS', g: 'GMS', ltr: 'LTR', ml: 'MLT', mtr: 'MTR', ft: 'OTH', box: 'BOX', pack: 'PAC', dozen: 'DOZ', bottle: 'BTL', set: 'SET', pair: 'PRS', bag: 'BAG', roll: 'ROL', coil: 'ROL', jar: 'OTH', service: 'OTH', hr: 'OTH' }
export const uqcOf = (unit: string) => UQC[unit] ?? 'OTH'

/** Tax split for a bill line or a total: IGST, or CGST + SGST (SGST gets the odd paisa, like the printed bill). */
export function splitTax(tax: number, igst: boolean) {
  if (igst) return { igst: r2(tax), cgst: 0, sgst: 0 }
  const cgst = r2(tax / 2)
  return { igst: 0, cgst, sgst: r2(tax - cgst) }
}

/**
 * Each line's value before GST and its GST, with the bill discount shared in proportion — the same rule as
 * computeTotals. Rounding is put on the last taxed line so the lines add up exactly to the bill's tax.
 */
export function splitLineTax(items: Pick<OrderItem, 'qty' | 'unitPrice' | 'taxRate'>[], discount: number, billing: Pick<BillingSettings, 'taxEnabled' | 'taxMode'>, orderTax: number) {
  const subtotal = items.reduce((s, i) => s + lineTotal(i), 0)
  const out = items.map((i) => {
    const line = lineTotal(i)
    const disc = subtotal ? (discount * line) / subtotal : 0
    const net = line - disc
    const rate = billing.taxEnabled ? i.taxRate || 0 : 0
    const taxable = billing.taxMode === 'inclusive' ? net / (1 + rate / 100) : net
    return { discount: r2(disc), taxable: r2(taxable), tax: r2((taxable * rate) / 100) }
  })
  const drift = r2(orderTax - out.reduce((s, l) => s + l.tax, 0))
  const last = [...out.keys()].reverse().find((k) => (items[k].taxRate || 0) > 0)
  if (last !== undefined && drift !== 0) {
    out[last].tax = r2(out[last].tax + drift)
    if (billing.taxMode === 'inclusive') out[last].taxable = r2(out[last].taxable - drift)
  }
  return out
}

// ---------- Monthly GST summary (GSTR-1 / GSTR-3B) ----------

export interface GstLine { hsn: string; name: string; unit: string; qty: number; rate: number; taxable: number; tax: number }
export interface GstBill { invoiceNumber: string; date: string; customer: string; gstin: string | null; placeOfSupply: string | null; igst: boolean; total: number; lines: GstLine[] }
export interface GstCreditNote { number: string; date: string; invoiceNumber: string; customer: string; gstin: string | null; placeOfSupply: string | null; igst: boolean; total: number; lines: GstLine[] }
export interface GstPurchase { number: string; supplierBillNo: string; date: string; supplier: string; gstin: string | null; igst: boolean; total: number; lines: { rate: number; taxable: number; tax: number }[] }

type Heads = { taxable: number; igst: number; cgst: number; sgst: number }
const zero = (): Heads => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 })
const add = <H extends Heads>(h: H, taxable: number, tax: number, igst: boolean): H => { const t = splitTax(tax, igst); h.taxable = r2(h.taxable + taxable); h.igst = r2(h.igst + t.igst); h.cgst = r2(h.cgst + t.cgst); h.sgst = r2(h.sgst + t.sgst); return h }
const sub = (a: Heads, b: Heads): Heads => ({ taxable: r2(a.taxable - b.taxable), igst: r2(a.igst - b.igst), cgst: r2(a.cgst - b.cgst), sgst: r2(a.sgst - b.sgst) })
const taxOf = (h: Heads) => r2(h.igst + h.cgst + h.sgst)

/** B2C invoices to another state above this value are listed one by one (GSTR-1 table B2CL). */
export const B2CL_LIMIT = 100000

export function buildGstReport(input: { month: string; shopState: string | null; bills: GstBill[]; creditNotes: GstCreditNote[]; purchases: GstPurchase[] }) {
  const { shopState } = input
  const b2b: { invoiceNumber: string; date: string; customer: string; gstin: string; placeOfSupply: string; invoiceValue: number; rate: number; taxable: number; igst: number; cgst: number; sgst: number }[] = []
  const b2cl: typeof b2b = []
  const b2cs = new Map<string, { placeOfSupply: string; rate: number; type: 'intra' | 'inter' } & Heads>()
  const hsn = new Map<string, { hsn: string; name: string; uqc: string; rate: number; qty: number } & Heads>()
  const outward = zero(), returns = zero(), input_ = zero()
  let missingHsn = 0
  const byRate = (lines: GstLine[]) => { const m = new Map<number, { taxable: number; tax: number }>(); for (const l of lines) { const g = m.get(l.rate) ?? { taxable: 0, tax: 0 }; g.taxable = r2(g.taxable + l.taxable); g.tax = r2(g.tax + l.tax); m.set(l.rate, g) } return [...m.entries()].sort((a, b) => a[0] - b[0]) }
  const toHsn = (l: GstLine, igst: boolean, sign: 1 | -1) => {
    if (!l.hsn) missingHsn++
    const key = `${l.hsn || '—'}|${l.rate}|${uqcOf(l.unit)}`
    const g = hsn.get(key) ?? { hsn: l.hsn || '', name: l.name, uqc: uqcOf(l.unit), rate: l.rate, qty: 0, ...zero() }
    g.qty = r2(g.qty + sign * l.qty)
    add(g, sign * l.taxable, sign * l.tax, igst)
    hsn.set(key, g)
  }

  const invoices = input.bills.map((b) => b.invoiceNumber).filter(Boolean).sort()
  for (const b of input.bills) {
    const pos = b.placeOfSupply ?? shopState ?? ''
    for (const l of b.lines) { add(outward, l.taxable, l.tax, b.igst); toHsn(l, b.igst, 1) }
    if (b.gstin) {
      for (const [rate, g] of byRate(b.lines)) b2b.push({ invoiceNumber: b.invoiceNumber, date: b.date, customer: b.customer, gstin: b.gstin, placeOfSupply: pos, invoiceValue: b.total, rate, taxable: g.taxable, ...splitTax(g.tax, b.igst) })
    } else if (b.igst && b.total > B2CL_LIMIT) {
      for (const [rate, g] of byRate(b.lines)) b2cl.push({ invoiceNumber: b.invoiceNumber, date: b.date, customer: b.customer, gstin: '', placeOfSupply: pos, invoiceValue: b.total, rate, taxable: g.taxable, ...splitTax(g.tax, true) })
    } else {
      for (const [rate, g] of byRate(b.lines)) {
        const key = `${pos}|${rate}`
        const row = b2cs.get(key) ?? { placeOfSupply: pos, rate, type: b.igst ? 'inter' as const : 'intra' as const, ...zero() }
        b2cs.set(key, add(row, g.taxable, g.tax, b.igst))
      }
    }
  }
  const cdn = input.creditNotes.map((n) => {
    const h = zero()
    for (const l of n.lines) { add(h, l.taxable, l.tax, n.igst); add(returns, l.taxable, l.tax, n.igst); toHsn(l, n.igst, -1) }
    return { number: n.number, date: n.date, invoiceNumber: n.invoiceNumber, customer: n.customer, gstin: n.gstin ?? '', placeOfSupply: n.placeOfSupply ?? shopState ?? '', value: n.total, registered: !!n.gstin, ...h }
  })
  // Walk-in returns reduce the walk-in summary (net figures, as the portal expects).
  for (const n of input.creditNotes.filter((x) => !x.gstin)) {
    const pos = n.placeOfSupply ?? shopState ?? ''
    for (const [rate, g] of byRate(n.lines)) {
      const key = `${pos}|${rate}`
      const row = b2cs.get(key) ?? { placeOfSupply: pos, rate, type: n.igst ? 'inter' as const : 'intra' as const, ...zero() }
      b2cs.set(key, add(row, -g.taxable, -g.tax, n.igst))
    }
  }
  const purchases = input.purchases.map((p) => {
    const h = zero()
    for (const l of p.lines) { add(h, l.taxable, l.tax, p.igst); add(input_, l.taxable, l.tax, p.igst) }
    return { number: p.number, supplierBillNo: p.supplierBillNo, date: p.date, supplier: p.supplier, gstin: p.gstin ?? '', value: p.total, ...h }
  })
  const net = sub(outward, returns)
  const payable = { igst: r2(net.igst - input_.igst), cgst: r2(net.cgst - input_.cgst), sgst: r2(net.sgst - input_.sgst) }
  const warnings: string[] = []
  if (missingHsn) warnings.push(`${missingHsn} bill line${missingHsn === 1 ? ' has' : 's have'} no HSN code. Add HSN to the items (or their category) so the HSN summary is complete.`)
  if (!shopState) warnings.push('Your shop’s GST state isn’t set. Add your GSTIN (or state) in Settings → Business Profile.')
  const unregistered = input.purchases.filter((p) => !p.gstin && p.lines.some((l) => l.tax > 0)).length
  if (unregistered) warnings.push(`${unregistered} purchase bill${unregistered === 1 ? ' is' : 's are'} from a supplier without a GSTIN — input tax credit may not be allowed.`)
  return {
    month: input.month, shopState,
    b2b, b2cl,
    b2cs: [...b2cs.values()].filter((r) => r.taxable !== 0 || taxOf(r) !== 0).sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate),
    cdn,
    hsn: [...hsn.values()].map((g) => ({ ...g, total: r2(g.taxable + taxOf(g)) })).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
    docs: { from: invoices[0] ?? '', to: invoices[invoices.length - 1] ?? '', count: invoices.length, creditNotes: input.creditNotes.length },
    purchases,
    summary: {
      outward, returns, net, input: input_,
      outputTax: taxOf(net), inputTax: taxOf(input_),
      payable, payableTotal: r2(Math.max(0, taxOf(net) - taxOf(input_))), carryForward: r2(Math.max(0, taxOf(input_) - taxOf(net))),
    },
    warnings,
  }
}
export type GstReport = ReturnType<typeof buildGstReport>

/** Spreadsheet sheets for the auditor (one per GSTR-1 table + 3B summary). */
export function gstSheets(r: GstReport) {
  const st = (c: string) => stateLabel(c) || c
  return [
    { name: 'B2B', rows: r.b2b.map((x) => ({ 'GSTIN of customer': x.gstin, 'Customer': x.customer, 'Invoice no': x.invoiceNumber, 'Invoice date': x.date, 'Invoice value': x.invoiceValue, 'Place of supply': st(x.placeOfSupply), 'Rate %': x.rate, 'Taxable value': x.taxable, IGST: x.igst, CGST: x.cgst, SGST: x.sgst })) },
    { name: 'B2CL', rows: r.b2cl.map((x) => ({ 'Invoice no': x.invoiceNumber, 'Invoice date': x.date, 'Invoice value': x.invoiceValue, 'Place of supply': st(x.placeOfSupply), 'Rate %': x.rate, 'Taxable value': x.taxable, IGST: x.igst })) },
    { name: 'B2CS', rows: r.b2cs.map((x) => ({ Type: x.type === 'inter' ? 'Inter-state' : 'Intra-state', 'Place of supply': st(x.placeOfSupply), 'Rate %': x.rate, 'Taxable value': x.taxable, IGST: x.igst, CGST: x.cgst, SGST: x.sgst })) },
    { name: 'Credit notes', rows: r.cdn.map((x) => ({ Type: x.registered ? 'B2B (CDNR)' : 'Walk-in — already taken off B2CS', 'Credit note': x.number, Date: x.date, 'Against invoice': x.invoiceNumber, Customer: x.customer, GSTIN: x.gstin, 'Place of supply': st(x.placeOfSupply), Value: x.value, 'Taxable value': x.taxable, IGST: x.igst, CGST: x.cgst, SGST: x.sgst })) },
    { name: 'HSN summary', rows: r.hsn.map((x) => ({ HSN: x.hsn || '(missing)', Description: x.name, UQC: x.uqc, 'Total quantity': x.qty, 'Rate %': x.rate, 'Total value': x.total, 'Taxable value': x.taxable, IGST: x.igst, CGST: x.cgst, SGST: x.sgst })) },
    { name: 'Documents', rows: [{ 'Invoices from': r.docs.from, 'Invoices to': r.docs.to, 'Invoices issued': r.docs.count, 'Credit notes': r.docs.creditNotes }] },
    { name: 'Purchases (ITC)', rows: r.purchases.map((x) => ({ 'Purchase no': x.number, 'Supplier bill no': x.supplierBillNo, Date: x.date, Supplier: x.supplier, GSTIN: x.gstin, Value: x.value, 'Taxable value': x.taxable, IGST: x.igst, CGST: x.cgst, SGST: x.sgst })) },
    { name: 'GSTR-3B summary', rows: [
      { Item: '3.1(a) Outward taxable supplies (after returns)', 'Taxable value': r.summary.net.taxable, IGST: r.summary.net.igst, CGST: r.summary.net.cgst, SGST: r.summary.net.sgst },
      { Item: '4(A) Input tax credit (purchases)', 'Taxable value': r.summary.input.taxable, IGST: r.summary.input.igst, CGST: r.summary.input.cgst, SGST: r.summary.input.sgst },
      { Item: 'Tax to pay (before set-off rules)', 'Taxable value': null, IGST: r.summary.payable.igst, CGST: r.summary.payable.cgst, SGST: r.summary.payable.sgst },
    ] },
  ]
}

/** Month bounds YYYY-MM → [first day, first day of next month] as YYYY-MM-DD. */
export function monthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a month')
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { from: `${month}-01`, to: `${next}-01` }
}

/** GSTIN + state for a customer or supplier: checked, and the state taken from the GSTIN when there is one. */
export function cleanPartyGst(input: { gstin?: string | null; stateCode?: string | null }) {
  const gstin = cleanGstin(input.gstin)
  const err = gstinError(gstin)
  if (err) throw new Error(err)
  const chosen = String(input.stateCode ?? '').trim()
  if (chosen && !GST_STATES[chosen]) throw new Error('Choose a state')
  return { gstin: gstin || null, stateCode: gstinState(gstin) ?? (chosen || null) }
}

/** Returned lines (amounts include GST, after the bill discount) → value before GST and GST, adding up to the credit note's tax. */
export function returnLines(lines: { name: string; unit: string; hsn: string; qty: number; rate: number; amount: number }[], noteTax: number): GstLine[] {
  const out = lines.map((l) => { const taxable = r2(l.amount / (1 + l.rate / 100)); return { hsn: l.hsn, name: l.name, unit: l.unit, qty: l.qty, rate: l.rate, taxable, tax: r2(l.amount - taxable) } })
  const drift = r2(noteTax - out.reduce((a, l) => a + l.tax, 0))
  const last = [...out.keys()].reverse().find((k) => out[k].rate > 0)
  if (last !== undefined && drift !== 0 && Math.abs(drift) < 1) { out[last].tax = r2(out[last].tax + drift); out[last].taxable = r2(out[last].taxable - drift) }
  return out
}
