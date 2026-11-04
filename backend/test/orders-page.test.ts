import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string }
type O = { id: string; number: string; invoiceNumber: string | null; type: string; status: string; total: number; customerId: string | null; createdAt: string; items: unknown[] }
type Page = { rows: O[]; next: { at: string; id: string } | null; count: number; billed: number }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

test('Orders pages: same bills, order and totals as the full list, for every filter and search', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    const anu = await s.call<P>('customers.save', { name: 'Anuradha', phone: '9811100001' })
    const ravi = await s.call<P>('customers.save', { name: 'Ravi Kumar', phone: '9811100002' })
    // Bills opened before the range starts and settled inside it (like yesterday's table bill): counted once, in the range.
    const old: { id: string; total: number }[] = []
    for (let i = 0; i < 3; i++) old.push((await s.call<{ order: { id: string; total: number } }>('orders.save', draft([line(tea)], { type: 'takeaway', customerId: i ? null : anu.id }))).order)
    await new Promise((r) => setTimeout(r, 1100))
    const rangeStart = new Date().toISOString()
    for (const o of old.slice(0, 2)) await s.call('orders.settle', o.id, [{ method: 'cash', amount: o.total }])
    const types = ['counter', 'takeaway', 'delivery']
    for (let i = 0; i < 23; i++) {
      const cust = i % 5 === 0 ? anu.id : i % 7 === 0 ? ravi.id : null
      if (i % 4 === 3) await s.call('orders.save', draft([line(tea)], { type: 'takeaway', customerId: cust })) // running (open)
      else {
        const o = await s.call<{ id: string }>('orders.checkout', draft([line(tea, 1 + (i % 3))], { type: types[i % 3], customerId: cust }), [{ method: 'cash', amount: 20 * (1 + (i % 3)) }])
        if (i % 6 === 1) await s.call('orders.cancel', o.id, 'test')
      }
    }
    const from = rangeStart, to = new Date(Date.now() + 60_000).toISOString()
    const all = await s.call<O[]>('orders.list', { from, to, status: 'all' })
    assert.equal(all.filter((o) => old.some((x) => x.id === o.id)).length, 2, 'the two settled in the range are in, the open one is not')
    const customerName = (id: string | null) => (id === anu.id ? 'anuradha' : id === ravi.id ? 'ravi kumar' : '')
    // What the Orders screen showed before (full list filtered in the browser).
    const before = (f: { status?: string; type?: string; q?: string }) => all.filter((o) => (!f.status || f.status === 'all' || o.status === f.status) && (!f.type || f.type === 'all' || o.type === f.type)
      && (!f.q || o.number.toLowerCase().includes(f.q) || (o.invoiceNumber ?? '').toLowerCase().includes(f.q) || customerName(o.customerId).includes(f.q)))
    const walk = async (f: { status?: string; type?: string; q?: string }, size: number) => {
      const got: O[] = []; let next: Page['next'] = null; let head: Page | null = null
      do {
        const p: Page = await s.call('orders.page', { from, to, ...f }, next, size)
        head ??= p; got.push(...p.rows); next = p.next
        assert.ok(p.rows.length <= size)
        assert.ok(p.rows.every((o) => Array.isArray(o.items) && o.items.length > 0), 'bills come with their items')
      } while (next)
      return { got, head: head! }
    }
    const cases: { status?: string; type?: string; q?: string }[] = [{}, { status: 'completed' }, { status: 'open' }, { status: 'cancelled' }, { type: 'takeaway' }, { status: 'completed', type: 'delivery' }, { q: 'anu' }, { q: 'ravi' }, { q: all[3].number.slice(-2) }, { q: (all.find((o) => o.invoiceNumber)?.invoiceNumber ?? '').slice(-3).toLowerCase() }, { q: 'nobody-here' }]
    for (const f of cases) {
      const want = before(f)
      for (const size of [5, 50]) {
        const { got, head } = await walk(f, size)
        assert.deepEqual(got.map((o) => o.id), want.map((o) => o.id), `${JSON.stringify(f)} / ${size}: same bills, same order`)
        assert.equal(head.count, want.length, `${JSON.stringify(f)}: count`)
        assert.equal(head.billed, Math.round(want.filter((o) => o.status === 'completed').reduce((a, o) => a + o.total, 0) * 100) / 100, `${JSON.stringify(f)}: billed total`)
      }
    }
  } finally { s.close() }
})

test('stock history: a smaller page on request; the default stays 3,000', async () => {
  const s = await withShop()
  try {
    const p = await s.call<P>('products.save', { name: 'Rice', price: 50, trackStock: true, stock: 100 })
    for (let i = 0; i < 6; i++) await s.call('inventory.adjust', p.id, 'purchase', 1, `in ${i}`)
    const all = await s.call<{ id: string; createdAt: string }[]>('inventory.movements')
    const first = await s.call<{ id: string; createdAt: string }[]>('inventory.movements', null, null, 3)
    assert.deepEqual(first.map((m) => m.id), all.slice(0, 3).map((m) => m.id))
    const rest = await s.call<{ id: string }[]>('inventory.movements', null, { at: first[2].createdAt, id: first[2].id }, 3)
    assert.deepEqual(rest.map((m) => m.id), all.slice(3, 6).map((m) => m.id))
  } finally { s.close() }
})

test('payments carry their bill number; orders.list without a range gives the newest 50 at most', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    for (let i = 0; i < 55; i++) await s.call('orders.checkout', draft([line(tea)]), [{ method: i % 2 ? 'cash' : 'upi', amount: 20 }])
    const open = await s.call<{ order: { id: string; number: string } }>('orders.save', draft([line(tea)], { type: 'takeaway' }))
    const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 60_000).toISOString()
    const bills = await s.call<O[]>('orders.list', { from, to, status: 'all' })
    const pays = (await s.call<{ rows: { orderId: string | null; billNumber?: string | null }[] }>('payments.page', { from, to }, null, 100)).rows
    assert.equal(pays.length, 55)
    for (const p of pays) {
      const o = bills.find((x) => x.id === p.orderId)!
      assert.equal(p.billNumber, o.invoiceNumber ?? o.number, 'same as the Orders screen shows')
    }
    const newest = await s.call<O[]>('orders.list', {})
    assert.equal(newest.length, 50)
    assert.deepEqual(newest.map((o) => o.id), bills.slice(0, 50).map((o) => o.id), 'newest first')
    assert.equal(newest[0].id, open.order.id)
    assert.equal((await s.call<O[]>('orders.list', { status: 'completed', limit: 6 })).length, 6, 'the dashboard still gets 6')
    assert.equal((await s.call<O[]>('orders.list', { limit: 500 })).length, 50, 'never more than 50 without a range')
  } finally { s.close() }
})
