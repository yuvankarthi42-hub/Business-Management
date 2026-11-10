// F-1: returns on a bill mixing GST rates refund each item its own billed value (its rate, its share of the bill
// discount), and the credit notes' GST matches what was billed — GSTR-1 / 3B and the summary agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string }
type O = { id: string; total: number; tax: number; items: { id: string; name: string }[] }
type CN = { total: number; tax: number; lines: { amount: number }[] }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], discount = 0) => ({ type: 'counter', tableId: null, customerId: null, items, discount, notes: '', source: 'pos' })
const month = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date())

async function shop(taxMode: 'exclusive' | 'inclusive') {
  const s = await withShop()
  const biz = await s.call<{ billing: { taxRates: { id: string; rate: number }[] } }>('business.update', { billing: { taxEnabled: true, taxMode, roundOff: false } })
  const rate = (r: number) => biz.billing.taxRates.find((t) => t.rate === r)!.id
  const charger = await s.call<P>('products.save', { name: 'Charger', price: 100, taxRateId: rate(18) })
  const rice = await s.call<P>('products.save', { name: 'Rice', price: 50, taxRateId: rate(5) })
  return { s, charger, rice }
}
const ret = (s: Awaited<ReturnType<typeof withShop>>, o: O, name: string, qty: number) =>
  s.call<CN>('returns.create', { orderId: o.id, lines: [{ orderItemId: o.items.find((i) => i.name === name)!.id, qty, restock: true }], reason: 'not_needed', settle: 'refund', refundMethod: 'cash' })

test('F-1: mixed GST rates (exclusive) — each item refunds its own amount and GST; the parts add up to the bill', async () => {
  const { s, charger, rice } = await shop('exclusive')
  try {
    const o = await s.call<O>('orders.checkout', draft([line(charger, 2), line(rice, 1)]), [{ method: 'cash', amount: 288.5 }])
    assert.deepEqual([o.total, o.tax], [288.5, 38.5])
    // The return screen's preview uses the same per-item value.
    const fo = await s.call<{ items: { name: string; refundEach: number }[] }>('returns.forOrder', o.id)
    assert.deepEqual(fo.items.map((i) => [i.name, i.refundEach]), [['Charger', 118], ['Rice', 52.5]])
    const a = await ret(s, o, 'Charger', 1)
    assert.deepEqual([a.total, a.tax], [118, 18], 'Charger @18%: 100 + 18')
    const b = await ret(s, o, 'Rice', 1)
    assert.deepEqual([b.total, b.tax], [52.5, 2.5], 'Rice @5%: 50 + 2.50')
    const c = await ret(s, o, 'Charger', 1)
    assert.deepEqual([c.total, c.tax], [118, 18])
    assert.equal(a.total + b.total + c.total, o.total, 'the whole bill back, to the paisa')
    // GST report: the bill and its credit notes cancel out exactly.
    const rep = await s.call<{ summary: { outputTax: number; returns: { cgst: number; sgst: number; igst: number } }; b2cs: unknown[] }>('reports.gst', month())
    assert.equal(rep.summary.outputTax, 0)
    assert.equal(Math.round((rep.summary.returns.cgst + rep.summary.returns.sgst + rep.summary.returns.igst) * 100), 3850, 'credit notes’ GST = the bill’s GST')
    assert.equal(rep.b2cs.length, 0)
  } finally { s.close() }
})

test('F-1: inclusive GST with a bill discount — refunds follow each line’s discounted value; single-rate bills unchanged', async () => {
  const { s, charger, rice } = await shop('inclusive')
  try {
    // ₹250 of goods, ₹25 off: each line gets 10% off.
    const o = await s.call<O>('orders.checkout', draft([line(charger, 2), line(rice, 1)], 25), [{ method: 'cash', amount: 225 }])
    assert.equal(o.total, 225)
    const a = await ret(s, o, 'Charger', 1)
    assert.equal(a.total, 90, 'Charger ₹100 less 10%')
    assert.equal(a.tax, 13.73, '18% inside ₹90')
    const b = await ret(s, o, 'Rice', 1)
    assert.equal(b.total, 45)
    assert.equal(b.tax, 2.14, '5% inside ₹45')
    // A one-rate bill: the same amounts as before the change.
    const o2 = await s.call<O>('orders.checkout', draft([line(rice, 3)]), [{ method: 'cash', amount: 150 }])
    const c = await ret(s, o2, 'Rice', 2)
    assert.equal(c.total, 100)
    assert.equal(c.tax, 4.76)
  } finally { s.close() }
})
