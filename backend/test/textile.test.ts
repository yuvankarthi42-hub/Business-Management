import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string; name: string; sku: string; barcode: string; price: number; mrp: number | null; stock: number; categoryId: string | null; details?: { design?: string; fabric?: string; colour?: string; size?: string } | null }
type O = { id: string; total: number; salespersonId?: string | null; items: { id: string; unitPrice: number; mrp?: number }[] }
type B = { billing: { mrpDiscounts?: boolean; taxMode: string }; stickers?: { size: string; code: string; footer: string; copies: number } }

const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

test('textile: design in sizes × colours, codes, stock, details, duplicates refused', async () => {
  const s = await withShop()
  try {
    const cat = await s.call<{ id: string }>('categories.save', { name: 'Silk Sarees', emoji: '🥻' })
    const base = { name: 'Kanchi Silk Saree', categoryId: cat.id, design: 'KS-101', fabric: 'Pure silk', mrp: 12000, price: 10800, costPrice: 8000, taxRateId: null, unit: 'pc', lowStockAt: 1 }
    const made = await s.call<P[]>('products.saveDesign', { ...base, rows: [{ colour: 'Maroon', size: '', stock: 3 }, { colour: 'Green', size: '', stock: 2 }, { colour: 'Gold', size: '', stock: 0 }] })
    assert.equal(made.length, 3)
    assert.deepEqual(made.map((p) => p.name), ['Kanchi Silk Saree · Maroon', 'Kanchi Silk Saree · Green', 'Kanchi Silk Saree · Gold'])
    assert.deepEqual(made.map((p) => p.stock), [3, 2, 0])
    assert.ok(made.every((p) => /^20\d{11}$/.test(p.barcode)), 'each item gets its own in-store code')
    assert.equal(new Set(made.map((p) => p.barcode)).size, 3)
    assert.deepEqual(made[0].details, { design: 'KS-101', fabric: 'Pure silk', colour: 'Maroon' })
    assert.equal(made[0].sku, 'KS-101')
    // Same design + colour again → refused; a new colour is fine.
    await assert.rejects(s.call('products.saveDesign', { ...base, rows: [{ colour: 'maroon', size: '', stock: 1 }] }), /already exists/)
    await assert.rejects(s.call('products.saveDesign', { ...base, rows: [{ colour: 'Blue', size: '', stock: 1 }, { colour: 'Blue', size: '', stock: 1 }] }), /listed twice/)
    await assert.rejects(s.call('products.saveDesign', { ...base, price: 13000, rows: [{ colour: 'Blue', size: '', stock: 1 }] }), /above the MRP/)
    await assert.rejects(s.call('products.saveDesign', { ...base, rows: [] }), /at least one/)
    await assert.rejects(s.call('products.saveDesign', { ...base, rows: [{ colour: 'Blue', size: '', stock: 1.5 }] }), /whole pieces/)
    // Nothing half-made by the refused calls.
    assert.equal((await s.call<P[]>('products.list')).length, 3)
    // Details can be edited with the normal form, and are trimmed / limited.
    const ed = await s.call<P>('products.save', { id: made[2].id, name: made[2].name, details: { design: 'KS-101', colour: '  Antique  gold ', size: '', fabric: 'x'.repeat(80) } })
    assert.deepEqual(ed.details, { design: 'KS-101', colour: 'Antique gold', fabric: 'x'.repeat(40) })
  } finally { s.close() }
})

test('textile: category discount, MRP on bill lines, discounts off bills at MRP', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const cat = await s.call<{ id: string }>('categories.save', { name: 'Cotton Sarees', emoji: '🌸' })
    const other = await s.call<{ id: string }>('categories.save', { name: 'Blouse', emoji: '👗' })
    const a = await s.call<P>('products.save', { name: 'Cotton Saree A', categoryId: cat.id, mrp: 1499, price: 1499, trackStock: false })
    const b = await s.call<P>('products.save', { name: 'Cotton Saree B', categoryId: cat.id, mrp: 999, price: 999 })
    const noMrp = await s.call<P>('products.save', { name: 'Loose fall', categoryId: cat.id, price: 50 })
    const blouse = await s.call<P>('products.save', { name: 'Blouse piece', categoryId: other.id, mrp: 300, price: 300 })

    const r = await s.call<{ updated: number; ids: string[]; noMrp: number }>('products.setDiscount', { categoryId: cat.id, pct: 20, round: 10 })
    assert.equal(r.updated, 2)
    assert.equal(r.noMrp, 1)
    assert.deepEqual(r.ids.sort(), [a.id, b.id].sort())
    const list = await s.call<P[]>('products.list')
    const price = (id: string) => list.find((p) => p.id === id)!.price
    assert.equal(price(a.id), 1200) // 1499 × 0.8 = 1199.2 → nearest ₹10
    assert.equal(price(b.id), 800)
    assert.equal(price(noMrp.id), 50)
    assert.equal(price(blouse.id), 300) // other category untouched
    await assert.rejects(s.call('products.setDiscount', { categoryId: cat.id, pct: 95, round: 1 }), /between 0 and 90/)

    // Discounts on: billed at the offer price, the line keeps the MRP ("You saved").
    const o1 = await s.call<O>('orders.checkout', draft([line({ ...a, price: 0 }, 2)]), [{ method: 'cash', amount: 2400 }])
    assert.equal(o1.total, 2400)
    assert.equal(o1.items[0].unitPrice, 1200)
    assert.equal(o1.items[0].mrp, 1499)
    const row = (await s.db.select('order_items', { where: { order_id: o1.id } }))[0]
    assert.equal(row.mrp_minor, 149900)

    // Discounts off: same item now bills at MRP, prices are kept for later.
    const biz = await s.call<B>('business.update', { billing: { mrpDiscounts: false } })
    assert.equal(biz.billing.mrpDiscounts, false)
    const o2 = await s.call<O>('orders.checkout', draft([line(a, 1)]), [{ method: 'cash', amount: 1499 }])
    assert.equal(o2.total, 1499)
    assert.equal(o2.items[0].mrp, undefined)
    assert.equal((await s.call<P[]>('products.list')).find((p) => p.id === a.id)!.price, 1200)
    await s.call('business.update', { billing: { mrpDiscounts: true } })

    // 0% → back to MRP.
    await s.call('products.setDiscount', { categoryId: null, productIds: [a.id], pct: 0, round: 1 })
    assert.equal((await s.call<P[]>('products.list')).find((p) => p.id === a.id)!.price, 1499)
  } finally { s.close() }
})

test('textile: sticker settings are checked and saved; textile sign-up defaults', async () => {
  const s = await withShop()
  try {
    const b = await s.call<B>('business.update', { stickers: { size: '50x38', code: 'qr', footer: '  No exchange   after 7 days ', copies: 2 } })
    assert.equal(b.stickers!.size, '50x38')
    assert.equal(b.stickers!.footer, 'No exchange after 7 days')
    assert.equal(b.stickers!.copies, 2)
    await assert.rejects(s.call('business.update', { stickers: { size: '99x99' } }), /sticker size/)
    await assert.rejects(s.call('business.update', { stickers: { copies: 0 } }), /between 1 and 50/)
    const again = await s.call<B>('business.update', { stickers: { code: 'barcode' } })
    assert.equal(again.stickers!.code, 'barcode')
    assert.equal(again.stickers!.copies, 2, 'a partial change keeps the rest')

    await s.call('business.saveSetup', { name: 'Sri Silks', category: 'retail', subType: 'Silk & Sarees', modules: { billing: true, products: true }, terminology: {}, orderTypes: ['counter'], categories: [{ name: 'Silk Sarees', emoji: '🥻' }], tables: [] })
    const me = await s.call<{ business: B & { subType: string; billing: { defaultTaxRateId: string; taxRates: { id: string; rate: number }[] } } }>('auth.me')
    assert.equal(me.business.billing.taxMode, 'inclusive')
    assert.equal(me.business.billing.taxRates.find((t) => t.id === me.business.billing.defaultTaxRateId)!.rate, 5)
  } finally { s.close() }
})

test('textile: salesperson on the bill gets the commission', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const priya = await s.call<{ id: string }>('users.save', { name: 'Priya', phone: '9800000077', roleId: '', canLogin: false, pay: { type: 'monthly', amount: 12000, commissionPct: 1 } })
    await s.call('staff.setPay', priya.id, { type: 'monthly', amount: 12000, commissionPct: 1 })
    const saree = await s.call<P>('products.save', { name: 'Saree', mrp: 5000, price: 5000 })
    const o = await s.call<O>('orders.checkout', draft([line(saree, 2)], { salespersonId: priya.id }), [{ method: 'cash', amount: 10000 }])
    assert.equal(o.salespersonId, priya.id)
    await s.call<O>('orders.checkout', draft([line(saree, 1)]), [{ method: 'cash', amount: 5000 }]) // the owner's own sale
    await assert.rejects(s.call('orders.checkout', draft([line(saree, 1)], { salespersonId: '999999' }), [{ method: 'cash', amount: 5000 }]), /salesperson/)
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).slice(0, 7)
    const rows = await s.call<{ userId: string; bills: number; sales: number; commission: number }[]>('staff.month', month)
    const p = rows.find((r) => r.userId === priya.id)!
    assert.deepEqual([p.bills, p.sales, p.commission], [1, 10000, 100])
    const owner = rows.find((r) => r.userId !== priya.id)!
    assert.equal(owner.bills, 1)
    assert.equal(owner.sales, 5000)
  } finally { s.close() }
})
