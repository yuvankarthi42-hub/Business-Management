import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { cleanBillFormat, defaultBillFormat, LAYOUT_COLS, type BillFormat } from '@/core/billFormat'
import { computeTotals } from '@/core/pricing'
import { billDoc, billLineValues, fmtQty, receiptDoc, type Line } from '@/features/printing/doc'
import { rowLines } from '@/features/printing/escpos'
import type { Branch, Business, Order, OrderItem } from '@/core/types'

const item = (id: string, name: string, qty: number, unitPrice: number, x: Partial<OrderItem> = {}): OrderItem =>
  ({ id, productId: id, name, variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice, taxRate: 0, notes: '', kotQty: qty, ...x })

function order(b: Business, items: OrderItem[], paid?: number): Order {
  const t = computeTotals(items, 0, b.billing)
  const now = '2026-11-05T10:30:00.000Z'
  const p = paid ?? t.total
  return { id: 'o1', number: 'ORD-1', type: 'counter', tableId: null, customerId: null, status: 'completed', items, notes: '', ...t, paid: p, balance: Math.max(0, t.total - p),
    paymentStatus: p >= t.total ? 'paid' : 'partial', invoiceNumber: 'INV-160', billedAt: now, cancelledAt: null, cancelReason: null, source: 'pos',
    businessId: b.id, branchId: 'br', createdAt: now, createdBy: 'u', updatedAt: now, updatedBy: 'u' }
}
const text = (doc: Line[], w = 48) => doc.flatMap((l) => l.k === 'text' ? [l.s] : l.k === 'row' ? rowLines(l.cells, l.widths, l.big ? w / 2 : w) : l.k === 'hr' ? ['---'] : [''])

const shopB = (x: Partial<Business> = {}, billing: Partial<Business['billing']> = {}): Business => ({
  id: 'b1', name: 'Udhayam Stores', category: 'retail', subType: 'Supermarket', address: '12 Main Rd, Madurai', phone: '9876543210', email: '', gstin: '33ABCDE1234F1Z5',
  currencySymbol: '₹',
  billing: { invoicePrefix: 'INV-', nextInvoiceNumber: 1, orderPrefix: 'ORD-', nextOrderNumber: 1, nextKotNumber: 1, taxEnabled: false, taxMode: 'inclusive',
    taxRates: [{ id: 'g5', name: 'GST 5%', rate: 5 }], defaultTaxRateId: 'g5', discountEnabled: true, paymentMethods: ['cash'], orderTypes: ['counter'], receiptFooter: 'Thank you!', roundOff: true, ...billing },
  ...x,
} as Business)

test('Rate × Qty − Discount = Amount on every line (Rice: MRP 70, rate 60, sold at 55 × 2)', () => {
  const rice = item('a', 'Ponni Rice', 2, 55, { mrp: 70, listPrice: 60, priceOverride: 55 })
  assert.deepEqual(billLineValues(rice), { rate: 60, discount: 10, amount: 110, mrp: 70, saved: 30 })
  const sugar = item('b', 'Sugar', 1, 45, { mrp: 50 })
  assert.deepEqual(billLineValues(sugar), { rate: 45, discount: 0, amount: 45, mrp: 50, saved: 5 })
  const dal = item('c', 'Toor Dal', 0.5, 140)
  assert.equal(billLineValues(dal).amount, 70)
  for (const i of [rice, sugar, dal]) { const v = billLineValues(i); assert.equal(Math.round((v.rate * i.qty - v.discount) * 100) / 100, v.amount) }
})

test('Quantity decimals', () => {
  assert.equal(fmtQty(2, 'auto'), '2')
  assert.equal(fmtQty(0.5, 'auto'), '0.500')
  assert.equal(fmtQty(2, 2), '2.00')
  assert.equal(fmtQty(1.25, 0), '1.25', 'never hides decimals that are there')
})

test('Bill: columns of the layout, amounts add up to the total, savings and words', () => {
  const b = shopB()
  const f = { ...defaultBillFormat(b), layout: 'mrpDisc' as const }
  const items = [item('a', 'Ponni Rice', 2, 55, { mrp: 70, listPrice: 60, priceOverride: 55 }), item('b', 'Sugar', 1, 45, { mrp: 50 })]
  const o = order(b, items)
  const doc = billDoc({ order: o, business: b }, '80mm', f)
  const lines = text(doc)
  const head = doc.find((l) => l.k === 'row' && l.cells.includes('MRP')) as Extract<Line, { k: 'row' }>
  assert.ok(head, 'header row printed')
  assert.deepEqual(head.cells.slice(1), ['MRP', 'Rate', 'Qty', 'Discount', 'Amount'])
  assert.equal(head.cells.length, LAYOUT_COLS.mrpDisc.length - 1, 'No + Item share the first cell')
  const rice = lines.find((s) => /Ponni Rice/.test(s) && /110\.00/.test(s))
  assert.ok(rice && /70\.00/.test(rice) && /60\.00/.test(rice) && /10\.00/.test(rice), rice)
  assert.ok(lines.some((s) => /TOTAL/.test(s) && /155\.00/.test(s)), 'TOTAL = 110 + 45')
  assert.equal(o.total, 155)
  assert.ok(lines.some((s) => /savings/i.test(s) && /35\.00/.test(s)), 'saved 30 + 5 against MRP')
  assert.ok(lines.some((s) => /One Hundred Fifty/i.test(s)), 'amount in words')
  assert.ok(lines.every((s) => s.length <= 48), 'fits 80 mm')
})

test('Turned-off lines and renamed labels; GSTIN and GST lines always print on a GST bill; balance due always', () => {
  const b = shopB({}, { taxEnabled: true })
  const d = defaultBillFormat(b)
  const f: BillFormat = { ...d, cols: { ...d.cols, amt: 'தொகை' }, top: { ...d.top, gstin: { on: false, label: 'GSTIN' }, cashier: { on: false, label: 'Cashier' } }, bottom: { ...d.bottom, received: { on: false, label: 'Paid' } } }
  const items = [item('a', 'Soap', 3, 42, { taxRate: 5 })]
  const o = order(b, items, 100)
  const lines = text(billDoc({ order: o, business: b }, '80mm', cleanBillFormat(f, b)))
  assert.ok(lines.some((s) => s.includes('33ABCDE1234F1Z5')), 'GSTIN forced')
  assert.ok(lines.some((s) => /CGST/.test(s)) && lines.some((s) => /SGST/.test(s)))
  assert.ok(lines.some((s) => /TAX INVOICE/.test(s)))
  assert.ok(lines.some((s) => s.includes('தொகை')), 'renamed column')
  assert.ok(!lines.some((s) => /Cashier/.test(s)))
  assert.ok(lines.some((s) => /Paid/.test(s)) && lines.some((s) => /Balance due/.test(s)), 'unpaid bill shows received + balance')
})

test('58 mm: many columns → item name on its own line, numbers below, nothing wider than the paper', () => {
  const b = shopB()
  const f = { ...defaultBillFormat(b), layout: 'mrpDisc' as const }
  const o = order(b, [item('a', 'Ponni Rice Premium', 12, 55, { mrp: 70, listPrice: 60, priceOverride: 55 })])
  const lines = text(billDoc({ order: o, business: b }, '58mm', f), 32)
  assert.ok(lines.every((s) => s.length <= 32), lines.find((s) => s.length > 32))
  const at = lines.findIndex((s) => /Ponni Rice Premium/.test(s))
  assert.ok(at >= 0 && !/660\.00/.test(lines[at]) && /660\.00/.test(lines[at + 1]), 'numbers on the next line')
})

test('A branch without a bill format prints exactly the old bill; footer lines come from the branch format', () => {
  const b = shopB()
  const o = order(b, [item('a', 'Tea', 2, 20)])
  const br = { id: 'br', businessId: 'b1', name: 'Main', address: '', isDefault: true }
  const old = receiptDoc({ order: o, business: b, branch: br }, '80mm')
  assert.deepEqual(receiptDoc({ order: o, business: b }, '80mm'), receiptDoc({ order: o, business: b, branch: { ...br, billFormat: undefined } }, '80mm'))
  const f = { ...defaultBillFormat(b, 'Nandri'), footer2: 'Visit again' }
  const lines = text(receiptDoc({ order: o, business: b, branch: { ...br, billFormat: f } }, '80mm'))
  assert.notDeepEqual(lines, text(old))
  assert.ok(lines.includes('Nandri') && lines.includes('Visit again'))
  assert.ok(!lines.includes('Thank you!'), 'the shop-wide receipt footer is for the classic bill only')
})

test('cleanBillFormat: unknown keys dropped, lengths limited, missing from the shop type default', () => {
  const b = shopB()
  const c = cleanBillFormat({ layout: 'bogus', cols: { amt: 'x'.repeat(40) }, top: { email: { on: 'yes' } }, evil: 1, address: 'a\nb\nc\nd\ne\nf' }, b)
  assert.equal(c.layout, defaultBillFormat(b).layout)
  assert.equal(c.cols.amt.length, 16)
  assert.equal(c.cols.rate, 'Rate')
  assert.equal(c.top.email.on, true)
  assert.equal(c.address.split('\n').length, 4)
  assert.ok(!('evil' in c))
})

type Me = { business: Business; branches: Branch[] }
const setup = { name: 'Test Mart', category: 'retail', subType: 'Textiles', modules: { billing: true, products: true }, terminology: {}, orderTypes: ['counter'], categories: [{ name: 'Sarees', emoji: 'x' }], tables: [] }

test('Server: each branch has its own bill format (bill_formats table)', async () => {
  const s = await withShop()
  try {
    const main = () => s.call<Me>('auth.me').then((m) => m.branches.find((b) => b.id === s.mainBranch)!)
    assert.equal((await main()).billFormat, undefined, 'existing shop: old bill until the owner chooses')
    const annex0 = await s.call<{ id: string }>('branches.save', { name: 'Annex' })
    assert.equal((await s.call<Me>('auth.me')).branches.find((b) => b.id === annex0.id)!.billFormat, undefined, 'no format to copy: none')

    // Setup: the main branch gets the shop type's default (with the shop's receipt footer).
    await s.call('business.saveSetup', setup)
    const f0 = (await main()).billFormat!
    assert.equal(f0.layout, 'mrpDisc', 'textile default')

    // A new branch starts with a copy of the main branch's format.
    const annex = await s.call<{ id: string }>('branches.save', { name: 'Town' })
    assert.deepEqual((await s.call<Me>('auth.me')).branches.find((b) => b.id === annex.id)!.billFormat, f0)

    // Change one branch: the other keeps its own. Unknown keys are dropped.
    await s.call('branches.saveBillFormat', annex.id, { ...f0, layout: 'basic', cols: { ...f0.cols, rate: 'விலை' }, footer1: 'Town branch', junk: true })
    const me = await s.call<Me>('auth.me')
    const t = me.branches.find((b) => b.id === annex.id)!.billFormat!
    assert.equal(t.layout, 'basic')
    assert.equal(t.cols.rate, 'விலை')
    assert.equal(t.footer1, 'Town branch')
    assert.ok(!('junk' in t))
    assert.deepEqual(me.branches.find((b) => b.id === s.mainBranch)!.billFormat, f0, 'main branch unchanged')

    // Saving again updates the same row; setup again keeps what was saved.
    await s.call('branches.saveBillFormat', s.mainBranch, { ...f0, title: 'INVOICE' })
    await s.call('business.saveSetup', setup)
    assert.equal((await main()).billFormat!.title, 'INVOICE')
    await assert.rejects(s.call('branches.saveBillFormat', '999999', f0), /Branch not found/)
  } finally { s.close() }
})

test('Server: who may change a branch\'s bill format', async () => {
  const s = await withShop()
  try {
    await s.call('business.saveSetup', setup)
    const town = await s.call<{ id: string }>('branches.save', { name: 'Town' })
    const f = (await s.call<Me>('auth.me')).branches.find((b) => b.id === s.mainBranch)!.billFormat!
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    const editor = await s.call<{ id: string }>('roles.save', { name: 'Bill editor', permissions: ['billing.create', 'bill.format'] })
    await s.call('users.save', { name: 'Ravi', phone: '9876500002', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234', branchId: s.mainBranch, branchIds: [s.mainBranch] })
    await s.call('users.save', { name: 'Meena', phone: '9876500003', roleId: editor.id, password: 'meena123', branchId: s.mainBranch, branchIds: [s.mainBranch] })
    const as = async (phone: string, pw: string) => s.setToken((await s.call<{ token: string }>('auth.login', phone, pw)).token)

    await as('9876500002', 'ravi1234') // cashier: printer yes, bill format no
    await assert.rejects(s.call('branches.saveBillFormat', s.mainBranch, f), /permission/)
    await as('9876500003', 'meena123') // "Change bill format": own branch only
    await s.call('branches.saveBillFormat', s.mainBranch, { ...f, title: 'BILL' })
    await assert.rejects(s.call('branches.saveBillFormat', town.id, f), /Branch not found/)
    s.setToken(s.ownerToken) // owner: every branch
    await s.call('branches.saveBillFormat', town.id, { ...f, title: 'TOWN' })
    const me = await s.call<Me>('auth.me')
    assert.equal(me.branches.find((b) => b.id === s.mainBranch)!.billFormat!.title, 'BILL')
    assert.equal(me.branches.find((b) => b.id === town.id)!.billFormat!.title, 'TOWN')
  } finally { s.close() }
})

test('State line: prints when switched on and the shop\'s state is known (GST or not); never twice the code', () => {
  const o = (b: Business) => order(b, [item('a', 'Tomato', 1, 32)])
  const fmt = (b: Business, on: boolean) => { const d = defaultBillFormat(b); return { ...d, top: { ...d.top, state: { on, label: 'State' } } } }
  const lines = (b: Business, on = true) => text(billDoc({ order: o(b), business: b }, '80mm', fmt(b, on)))
  const gst = shopB({}, { taxEnabled: true })
  assert.ok(lines(gst).includes('State: Tamil Nadu (33)'), 'from the GSTIN')
  assert.ok(!lines(gst, false).some((l) => l.startsWith('State')), 'switched off')
  const noGst = shopB({ gstin: '', stateCode: '33' } as Partial<Business>, { taxEnabled: false })
  assert.ok(lines(noGst).includes('State: Tamil Nadu (33)'), 'no GST, state set in Business Profile')
  const unknown = shopB({ gstin: '', stateCode: undefined } as Partial<Business>, { taxEnabled: true })
  assert.ok(!lines(unknown).some((l) => l.startsWith('State')), 'state not set: nothing to print')
})
