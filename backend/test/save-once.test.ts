import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string }
type O = { id: string; number: string; invoiceNumber: string | null; status: string; total: number }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const today = () => [new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 3600_000).toISOString()]

test('a bill sent again with the same id (double tap / lost answer) is saved once: one bill, one payment, stock taken once', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const milk = await s.call<P & { stock: number }>('products.save', { name: 'Milk', price: 27, trackStock: true, stock: 10 })
    const d = draft([line(milk, 2)])
    s.setRequestId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')
    const [a, b] = await Promise.all([
      s.call<O>('orders.checkout', d, [{ method: 'cash', amount: 54 }]),
      s.call<O>('orders.checkout', d, [{ method: 'cash', amount: 54 }]).catch((e: Error) => e),
    ])
    const c = await s.call<O>('orders.checkout', d, [{ method: 'cash', amount: 54 }]) // the retry after a lost answer
    s.setRequestId(null)
    assert.equal(c.id, a.id, 'the retry returns the same bill')
    if (!(b instanceof Error)) assert.equal(b.id, a.id)
    const bills = await s.call<O[]>('orders.list', { from: today()[0], to: today()[1], status: 'completed' })
    assert.equal(bills.length, 1, 'one bill')
    const pays = await s.call<unknown[]>('payments.list', ...today())
    assert.equal(pays.length, 1, 'one payment')
    assert.equal((await s.call<{ id: string; stock: number }[]>('products.list')).find((p) => p.id === milk.id)!.stock, 8, 'stock taken once')
    // The next bill (new id) is a new bill.
    s.setRequestId('ffffffffffffffffffffffffffffffff')
    await s.call<O>('orders.checkout', d, [{ method: 'cash', amount: 54 }])
    s.setRequestId(null)
    assert.equal((await s.call<O[]>('orders.list', { from: today()[0], to: today()[1], status: 'completed' })).length, 2)
  } finally { s.close() }
})

test('paying a running order again with the same id returns the bill (no "not running" error, no second payment)', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20, sendToKitchen: true })
    // KOT saved twice with the same id → one running order, one kitchen ticket.
    s.setRequestId('0123456789abcdef0123456789abcdef')
    const h1 = await s.call<{ order: O }>('orders.save', draft([line(tea, 2)], { type: 'takeaway' }), { sendToKitchen: true })
    const h2 = await s.call<{ order: O }>('orders.save', draft([line(tea, 2)], { type: 'takeaway' }), { sendToKitchen: true })
    s.setRequestId(null)
    assert.equal(h2.order.id, h1.order.id)
    assert.equal((await s.call<unknown[]>('orders.running')).length, 1)
    assert.equal((await s.call<unknown[]>('kitchen.list')).length, 1)
    // Collect twice with the same id.
    s.setRequestId('0123456789abcdef0123456789abcdefs')
    const p1 = await s.call<O>('orders.settle', h1.order.id, [{ method: 'upi', amount: 40 }])
    const p2 = await s.call<O>('orders.settle', h1.order.id, [{ method: 'upi', amount: 40 }])
    s.setRequestId(null)
    assert.equal(p2.invoiceNumber, p1.invoiceNumber)
    assert.equal((await s.call<unknown[]>('payments.list', ...today())).length, 1)
    // A different request on a paid order is still refused.
    await assert.rejects(s.call('orders.settle', h1.order.id, [{ method: 'upi', amount: 40 }]), /not running/)
  } finally { s.close() }
})
