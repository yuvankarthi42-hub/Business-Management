import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { afterCursor, idBefore, pageWindow } from '../../src/core/paging'

type P = { id: string }
type Move = { id: string; createdAt: string }
type Log = { id: string; at: string }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[]) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos' })

test('page window: 50 a page, last page shorter, past the end → last page', () => {
  assert.deepEqual(pageWindow(0, 0), { page: 0, pages: 1, from: 0, to: 0 })
  assert.deepEqual(pageWindow(120, 0), { page: 0, pages: 3, from: 0, to: 50 })
  assert.deepEqual(pageWindow(120, 2), { page: 2, pages: 3, from: 100, to: 120 })
  assert.deepEqual(pageWindow(120, 9), { page: 2, pages: 3, from: 100, to: 120 }, 'a filter shrank the list')
  assert.deepEqual(pageWindow(120, -1), { page: 0, pages: 3, from: 0, to: 50 })
  // Ids longer than a JavaScript number (Catalyst) still compare right; same time → by id.
  assert.ok(idBefore('9', '10') && idBefore('3000000000000000001', '3000000000000000002') && !idBefore('10', '9'))
  const rows = [{ id: '5', t: 'b' }, { id: '4', t: 'b' }, { id: '3', t: 'a' }]
  assert.deepEqual(afterCursor(rows, (r) => r.t, { at: 'b', id: '5' }).map((r) => r.id), ['4', '3'])
})

test('"Load older": audit log and stock history continue exactly after the last row — none missed or repeated', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    for (let i = 0; i < 7; i++) await s.call('expenses.save', { amount: 10 + i, category: 'rent', method: 'cash', notes: `e${i}` })
    const all = await s.call<Log[]>('audit.list', 500)
    assert.ok(all.length >= 7)
    // Two at a time, each part after the last row of the one before.
    const seen: Log[] = []
    let part = await s.call<Log[]>('audit.list', 2)
    while (part.length) { seen.push(...part); const last = part[part.length - 1]; part = await s.call<Log[]>('audit.list', 2, { at: last.at, id: last.id }) }
    assert.deepEqual(seen.map((l) => l.id), all.map((l) => l.id), 'same rows, same order')
    assert.deepEqual(await s.call('audit.list', 100), all.slice(0, 100), 'without a cursor: as before')

    // Stock history: one bill moves three products (rows saved in the same instant).
    const prods = await Promise.all(['A', 'B', 'C'].map((n) => s.call<P>('products.save', { name: n, price: 10, trackStock: true, stock: 5 })))
    await s.call('orders.checkout', draft(prods.map((p) => line(p))), [{ method: 'cash', amount: 30 }])
    const moves = await s.call<Move[]>('inventory.movements')
    assert.ok(moves.length >= 6)
    for (let k = 0; k < moves.length; k++) {
      const older = await s.call<Move[]>('inventory.movements', null, { at: moves[k].createdAt, id: moves[k].id })
      assert.deepEqual(older.map((m) => m.id), moves.slice(k + 1).map((m) => m.id), `after row ${k}`)
    }
    // A bad cursor is ignored (first part, as before).
    assert.deepEqual(await s.call<Move[]>('inventory.movements', null, { at: 'x', id: 'y' }), moves)
  } finally { s.close() }
})
