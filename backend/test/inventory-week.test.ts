import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string }
type Move = { productId: string; type: string; qty: number; createdAt: string }
type Week = { productId: string; type: string; qty: number }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[]) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos' })

test('Reports → Inventory: last-7-days totals per item and type equal the old calculation from the movements', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const rice = await s.call<P>('products.save', { name: 'Rice', price: 60, trackStock: true, stock: 100, unit: 'kg' })
    const oil = await s.call<P>('products.save', { name: 'Oil', price: 150, trackStock: true, stock: 40 })
    const curd = await s.call<P>('products.save', { name: 'Curd', price: 30, trackStock: true, trackExpiry: true })
    await s.call('inventory.adjust', curd.id, 'purchase', 12, 'stock in', 20, { batchNo: 'B1', expiry: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) })
    await s.call('inventory.adjust', rice.id, 'purchase', 25.5, 'stock in')
    await s.call('inventory.adjust', rice.id, 'wastage', 1.25, 'spilled')
    await s.call('inventory.adjust', oil.id, 'damage', 2, 'leaking')
    await s.call('inventory.adjust', oil.id, 'adjustment', -1, 'count')
    for (let i = 0; i < 4; i++) await s.call('orders.checkout', draft([line(rice, 1.5), line(oil, 2)]), [{ method: 'cash', amount: 1.5 * 60 + 2 * 150 }])
    const sold = await s.call<{ id: string; items: { id: string }[] }>('orders.checkout', draft([line(rice, 2)]), [{ method: 'cash', amount: 120 }])
    await s.call('returns.create', { orderId: sold.id, lines: [{ orderItemId: sold.items[0].id, qty: 1, restock: true }], reason: 'other', settle: 'refund', refundMethod: 'cash' })
    const [batch] = await s.call<{ id: string }[]>('inventory.batches')
    await s.call('inventory.writeOffBatch', batch.id, 'Expired')

    const moves = await s.call<Move[]>('inventory.movements')
    const week = await s.call<Week[]>('inventory.weekSummary')
    const since = new Date(Date.now() - 7 * 864e5).toISOString()
    for (const p of [rice, oil, curd]) {
      // What the Reports tab showed before: filter the movements, add up by type.
      const old = (types: string[]) => Math.abs(moves.filter((m) => m.productId === p.id && m.createdAt >= since && types.includes(m.type)).reduce((a, m) => a + m.qty, 0))
      const now = (types: string[]) => Math.abs(week.filter((w) => w.productId === p.id && types.includes(w.type)).reduce((a, w) => a + w.qty, 0))
      for (const types of [['purchase'], ['sale'], ['wastage', 'damage'], ['return'], ['adjustment'], ['opening']]) {
        assert.equal(now(types), Math.round(old(types) * 1000) / 1000, `${p.id} ${types.join('+')}`)
      }
    }
    assert.ok(week.some((w) => w.productId === curd.id && w.type === 'wastage'), 'an expired batch shows as wastage')
    assert.equal(Math.abs(week.find((w) => w.productId === rice.id && w.type === 'sale')!.qty), 8)
  } finally { s.close() }
})
