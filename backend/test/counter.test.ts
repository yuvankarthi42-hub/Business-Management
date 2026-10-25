import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string; price: number }
type O = { id: string; total: number; discount: number; items: { id: string; unitPrice: number; listPrice?: number; priceOverride?: number; productId: string }[] }
type Ex = { id: string; category: string; amount: number; method: string; voided: boolean; notes: string; supplierPaymentId?: string }
const line = (p: P, qty = 1, extra = {}) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0, ...extra })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

test('counter rights: discounts and price changes need their permissions — checked on the server', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const saree = await s.call<P>('products.save', { name: 'Saree', price: 1000, mrp: 1200 })
    const roles = await s.call<{ id: string; name: string; permissions: string[] }[]>('roles.list')
    const cashier = roles.find((r) => r.name === 'Cashier')!
    assert.ok(!cashier.permissions.includes('billing.discount') && !cashier.permissions.includes('billing.price'))
    assert.ok(roles.find((r) => r.name === 'Manager')!.permissions.includes('billing.price'), 'new shops: managers may change prices')
    await s.call('users.save', { name: 'Ravi', phone: '9800000501', roleId: cashier.id, password: 'ravi1234' })

    // Owner: price change and line discount work; never above MRP.
    const o1 = await s.call<O>('orders.checkout', draft([line(saree, 2, { priceOverride: 900 })]), [{ method: 'cash', amount: 1800 }])
    assert.equal(o1.total, 1800)
    assert.deepEqual([o1.items[0].unitPrice, o1.items[0].listPrice, o1.items[0].priceOverride], [900, 1000, 900])
    await assert.rejects(s.call('orders.checkout', draft([line(saree, 1, { priceOverride: 1300 })]), [{ method: 'cash', amount: 1300 }]), /more than the MRP/)
    await assert.rejects(s.call('orders.checkout', draft([line(saree, 1, { priceOverride: -5 })]), [{ method: 'cash', amount: 0 }]), /valid price/)
    // A running order with a discount and a changed price, saved by the owner…
    const running = (await s.call<{ order: O }>('orders.save', draft([line(saree, 1, { priceOverride: 950 })], { discount: 50 }))).order
    const ownerToken = s.ownerToken

    // Cashier (no "Give discounts", no "Change item price"): refused when sending them…
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000501', 'ravi1234')).token)
    await assert.rejects(s.call('orders.checkout', draft([line(saree)], { discount: 100 }), [{ method: 'cash', amount: 900 }]), /permission to give a discount/)
    await assert.rejects(s.call('orders.save', draft([line(saree)], { discount: 100 })), /permission to give a discount/)
    await assert.rejects(s.call('orders.checkout', draft([line(saree, 1, { priceOverride: 800 })]), [{ method: 'cash', amount: 800 }]), /permission to change prices/)
    // …but can still bill normally, and pay the owner's running order as it is.
    const plain = await s.call<O>('orders.checkout', draft([line(saree)]), [{ method: 'cash', amount: 1000 }])
    assert.equal(plain.total, 1000)
    const it = running.items[0]
    const paid = await s.call<O>('orders.checkout', draft([{ ...line(saree), id: it.id, priceOverride: 950 }], { id: running.id, discount: 50 }), [{ method: 'cash', amount: 900 }])
    assert.equal(paid.total, 900)
    // Changing the owner's discount on that kind of order is refused too.
    const running2 = await (async () => { s.setToken(ownerToken); const r = (await s.call<{ order: O }>('orders.save', draft([line(saree)], { discount: 20 }))).order; s.setToken((await s.call<{ token: string }>('auth.login', '9800000501', 'ravi1234')).token); return r })()
    await assert.rejects(s.call('orders.checkout', draft([{ ...line(saree), id: running2.items[0].id }], { id: running2.id, discount: 200 }), [{ method: 'cash', amount: 800 }]), /permission to give a discount/)
  } finally { s.close() }
})

test('supplier payments are Purchase expenses; voiding the payment voids the expense', async () => {
  const s = await withShop()
  try {
    const sup = await s.call<{ id: string }>('suppliers.save', { name: 'Arani Weavers' })
    const saree = await s.call<P>('products.save', { name: 'Saree', price: 1000, trackStock: true })
    const base = { supplierId: sup.id, supplierBillNo: 'A-1', date: today(), lines: [{ productId: saree.id, qty: 10, cost: 600, taxRate: 0 }] }
    const expenses = async () => (await s.call<Ex[]>('expenses.list', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString()))
    // On credit: nothing paid → no expense.
    await s.call('purchases.create', { ...base, paid: 0, method: 'cash' })
    assert.equal((await expenses()).length, 0)
    // Paid with the bill.
    await s.call('purchases.create', { ...base, supplierBillNo: 'A-2', paid: 4000, method: 'bank' })
    let ex = await expenses()
    assert.equal(ex.length, 1)
    assert.deepEqual([ex[0].category, ex[0].amount, ex[0].method], ['purchase', 4000, 'bank'])
    assert.match(ex[0].notes, /Arani Weavers/)
    // Paid later.
    const pay = await s.call<{ id: string }>('suppliers.pay', sup.id, { amount: 2500, method: 'upi', reference: 'UTR9' })
    ex = await expenses()
    const mine = ex.find((e) => e.supplierPaymentId === pay.id)!
    assert.equal(mine.amount, 2500)
    // Voided only from the supplier's statement — and then the expense goes too.
    await assert.rejects(s.call('expenses.void', mine.id), /supplier’s statement/)
    await s.call('suppliers.voidPayment', pay.id, 'Wrong amount')
    ex = await expenses()
    assert.equal(ex.find((e) => e.id === mine.id)!.voided, true)
  } finally { s.close() }
})
