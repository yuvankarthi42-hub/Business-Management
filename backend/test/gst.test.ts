import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanPartyGst, gstinCheckChar, gstinError, hsnError, splitLineTax, buildGstReport } from '../../src/core/gst'
import { withShop } from './fixtures'

/** A valid GSTIN for a state (PAN-like middle part, check character computed). */
const gstin = (state: string, pan = 'AABCS1234D') => { const first = `${state}${pan}1Z`; return first + gstinCheckChar(first) }
const month = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).slice(0, 7)

type P = { id: string; hsn?: string | null }
type O = { id: string; total: number; tax: number; igst?: boolean; customerGstin?: string | null; placeOfSupply?: string | null; invoiceNumber: string; items: { id: string; hsn?: string; qty: number }[] }
type Biz = { billing: { taxRates: { id: string; rate: number }[] } }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

test('gst core: GSTIN check digit, state, HSN, line split adds up', () => {
  const g = gstin('33')
  assert.equal(gstinError(g), '')
  assert.equal(gstinError(g.toLowerCase()), '', 'case does not matter')
  assert.match(gstinError(g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A')), /typing mistake/)
  assert.match(gstinError('33AABCS1234D1Z'), /15 characters/)
  assert.match(gstinError('99AABCS1234D1ZX'), /state code|doesn’t look right/)
  assert.equal(gstinError(''), '')
  assert.deepEqual(cleanPartyGst({ gstin: gstin('29') }), { gstin: gstin('29'), stateCode: '29' })
  assert.deepEqual(cleanPartyGst({ stateCode: '32' }), { gstin: null, stateCode: '32' }, 'other-state buyer without a GSTIN')
  assert.throws(() => cleanPartyGst({ gstin: 'XYZ' }))
  assert.equal(hsnError('5007'), ''); assert.equal(hsnError('996331'), ''); assert.equal(hsnError('10063010'), '')
  assert.match(hsnError('50'), /4, 6 or 8/); assert.match(hsnError('5007a'), /4, 6 or 8/)
  // Inclusive bill with a discount: lines add up to the bill's tax and value before tax.
  const items = [{ qty: 2, unitPrice: 1050, taxRate: 5 }, { qty: 1, unitPrice: 118, taxRate: 18 }, { qty: 3, unitPrice: 20, taxRate: 0 }]
  const split = splitLineTax(items, 100, { taxEnabled: true, taxMode: 'inclusive' }, 113.7)
  assert.equal(Math.round(split.reduce((a, l) => a + l.tax, 0) * 100) / 100, 113.7)
  assert.equal(Math.round(split.reduce((a, l) => a + l.taxable + l.tax, 0) * 100) / 100, 2100 + 118 + 60 - 100)
})

test('gst core: report tables — B2B, B2CS by place of supply and rate, credit notes, HSN summary, 3B', () => {
  const r = buildGstReport({
    month: '2026-10', shopState: '33',
    bills: [
      { invoiceNumber: 'INV-1', date: '2026-10-02', customer: 'Kumar Traders', gstin: gstin('33'), placeOfSupply: '33', igst: false, total: 1050, lines: [{ hsn: '5007', name: 'Saree', unit: 'pc', qty: 1, rate: 5, taxable: 1000, tax: 50 }] },
      { invoiceNumber: 'INV-2', date: '2026-10-03', customer: 'Bangalore Silks', gstin: gstin('29'), placeOfSupply: '29', igst: true, total: 2100, lines: [{ hsn: '5007', name: 'Saree', unit: 'pc', qty: 2, rate: 5, taxable: 2000, tax: 100 }] },
      { invoiceNumber: 'INV-3', date: '2026-10-04', customer: '', gstin: null, placeOfSupply: null, igst: false, total: 1180, lines: [{ hsn: '', name: 'Bag', unit: 'pc', qty: 1, rate: 18, taxable: 1000, tax: 180 }] },
    ],
    creditNotes: [{ number: 'CN-1', date: '2026-10-05', invoiceNumber: 'INV-3', customer: '', gstin: null, placeOfSupply: null, igst: false, total: 590, lines: [{ hsn: '', name: 'Bag', unit: 'pc', qty: 0.5, rate: 18, taxable: 500, tax: 90 }] }],
    purchases: [{ number: 'PUR-1', supplierBillNo: 'S-9', date: '2026-10-01', supplier: 'Weavers', gstin: gstin('33', 'AAATW1234Q'), igst: false, total: 1050, lines: [{ rate: 5, taxable: 1000, tax: 50 }] }],
  })
  assert.equal(r.b2b.length, 2)
  assert.deepEqual([r.b2b[1].igst, r.b2b[1].cgst], [100, 0], 'other state → IGST')
  assert.deepEqual([r.b2b[0].cgst, r.b2b[0].sgst], [25, 25])
  assert.equal(r.b2cs.length, 1)
  assert.deepEqual([r.b2cs[0].rate, r.b2cs[0].taxable, r.b2cs[0].cgst], [18, 500, 45], 'walk-in sale less its return')
  assert.equal(r.hsn.find((h) => h.hsn === '5007')!.qty, 3)
  assert.equal(r.hsn.find((h) => h.hsn === '')!.taxable, 500)
  assert.equal(r.summary.outputTax, 330 - 90)
  assert.equal(r.summary.inputTax, 50)
  assert.equal(r.summary.payableTotal, 190)
  assert.ok(r.warnings.some((w) => /no HSN/.test(w)))
  assert.deepEqual([r.docs.from, r.docs.to, r.docs.count], ['INV-1', 'INV-3', 3])
})

test('gst: HSN (item / category), B2B tax invoice, IGST for other state, lines stored, monthly report', async () => {
  const s = await withShop()
  try {
    await assert.rejects(s.call('business.update', { gstin: '33AABCS1234D1ZZ' }), /typing mistake|doesn’t look right/)
    const biz = await s.call<Biz>('business.update', { gstin: gstin('33'), billing: { taxEnabled: true, taxMode: 'exclusive', roundOff: false } })
    const r5 = biz.billing.taxRates.find((t) => t.rate === 5)!.id
    const cat = await s.call<{ id: string; hsn: string | null }>('categories.save', { name: 'Silk Sarees', emoji: '🥻', hsn: '5007' })
    assert.equal(cat.hsn, '5007')
    await assert.rejects(s.call('categories.save', { name: 'Bad', emoji: 'x', hsn: '12' }), /4, 6 or 8/)
    await assert.rejects(s.call('products.save', { name: 'Bad HSN', price: 10, hsn: 'abc' }), /4, 6 or 8/)
    const saree = await s.call<P>('products.save', { name: 'Silk Saree', price: 1000, categoryId: cat.id, taxRateId: r5 })
    const blouse = await s.call<P>('products.save', { name: 'Blouse', price: 200, taxRateId: r5, hsn: '6206' })
    assert.equal(saree.hsn, null, 'no own code — the category gives it at billing')

    await assert.rejects(s.call('customers.save', { name: 'Typo Traders', phone: '9800000201', gstin: '29AABCS1234D1ZQ' }), /GSTIN/)
    const local = await s.call<{ id: string; stateCode: string }>('customers.save', { name: 'Kumar Traders', phone: '9800000202', gstin: gstin('33', 'AAFCK1234L') })
    const other = await s.call<{ id: string; stateCode: string }>('customers.save', { name: 'Bangalore Silks', phone: '9800000203', gstin: gstin('29', 'AAFCB1234L') })
    assert.equal(other.stateCode, '29')

    // Other state: IGST, B2B snapshot, HSN on lines (category default for the saree, own code for the blouse).
    const o1 = await s.call<O>('orders.checkout', draft([line(saree, 2), line(blouse)], { customerId: other.id }), [{ method: 'bank', amount: 2310 }])
    assert.equal(o1.total, 2310)
    assert.equal(o1.igst, true)
    assert.equal(o1.customerGstin, gstin('29', 'AAFCB1234L'))
    assert.equal(o1.placeOfSupply, '29')
    assert.deepEqual(o1.items.map((i) => i.hsn), ['5007', '6206'])
    const rows = await s.db.select('order_items', { where: { order_id: o1.id } })
    assert.deepEqual(rows.map((r) => [r.taxable_minor, r.tax_minor]).sort(), [[20000, 1000], [200000, 10000]])
    const stored = (await s.db.get('orders', o1.id))!
    assert.equal(JSON.parse(String(stored.tax_breakup_json))[0].igst, true)

    // Same state: CGST + SGST.
    const o2 = await s.call<O>('orders.checkout', draft([line(saree)], { customerId: local.id }), [{ method: 'cash', amount: 1050 }])
    assert.equal(o2.igst ?? false, false)
    assert.equal(o2.customerGstin, gstin('33', 'AAFCK1234L'))
    // Walk-in.
    const o3 = await s.call<O>('orders.checkout', draft([line(blouse, 3)]), [{ method: 'cash', amount: 630 }])
    assert.equal(o3.customerGstin ?? null, null)
    // Return one blouse from the walk-in bill → credit note in the report.
    await s.call('returns.create', { orderId: o3.id, lines: [{ orderItemId: o3.items[0].id, qty: 1, restock: true }], reason: 'not_needed', settle: 'refund', refundMethod: 'cash' })

    type R = ReturnType<typeof buildGstReport>
    const rep = await s.call<R>('reports.gst', month())
    assert.equal(rep.shopState, '33')
    assert.equal(rep.b2b.length, 2, 'one row per bill and rate')
    const igstRows = rep.b2b.filter((x) => x.invoiceNumber === o1.invoiceNumber)
    assert.equal(igstRows.reduce((a, x) => a + x.igst, 0), 110)
    assert.equal(rep.b2cs.length, 1)
    assert.deepEqual([rep.b2cs[0].taxable, rep.b2cs[0].cgst, rep.b2cs[0].sgst], [400, 10, 10], 'walk-in: 3 blouses less 1 returned')
    assert.equal(rep.cdn.length, 1)
    assert.equal(rep.hsn.find((h) => h.hsn === '6206')!.qty, 1 + 3 - 1)
    assert.equal(rep.summary.outputTax, 110 + 50 + 20)
    assert.deepEqual(rep.warnings.filter((w) => /HSN/.test(w)), [])
    await assert.rejects(s.call('reports.gst', '2026-13'), /Choose a month/)
  } finally { s.close() }
})
