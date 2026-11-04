import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { idBefore } from '../../src/core/paging'

type Pay = { id: string; createdAt: string; method: string; amount: number; voided: boolean; billNumber?: string | null }
type Page = { rows: Pay[]; next: { at: string; id: string } | null; count: number; totals: Record<string, number> }
const line = (p: { id: string }, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const newest = (a: Pay, b: Pay) => b.createdAt.localeCompare(a.createdAt) || (idBefore(a.id, b.id) ? 1 : idBefore(b.id, a.id) ? -1 : 0)
const r2 = (n: number) => Math.round(n * 100) / 100

test('payments.page: every payment once (newest first), totals per method for the whole range, method filter, module off', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 15 })
    const cake = await s.call<{ id: string }>('products.save', { name: 'Cake', price: 120 })
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Anu', phone: '9811100001' })
    const annex = await s.call<{ id: string }>('branches.save', { name: 'Annex' })
    const methods = ['cash', 'upi', 'card', 'bank']
    for (let i = 0; i < 23; i++) await s.call('orders.checkout', draft([line(tea, 1 + (i % 3))]), [{ method: methods[i % 4], amount: 15 * (1 + (i % 3)) }])
    // Split payment: two payments on one bill, saved together.
    await s.call('orders.checkout', draft([line(cake)]), [{ method: 'cash', amount: 50 }, { method: 'upi', amount: 70 }])
    // Part paid, then a due collected later.
    await s.call('orders.checkout', draft([line(cake, 2)], { customerId: cust.id }), [{ method: 'cash', amount: 100 }])
    await s.call('customers.collectDue', cust.id, 90, 'upi')
    // A cancelled bill: its payment is voided (listed, but not in the totals).
    const gone = await s.call<{ id: string }>('orders.checkout', draft([line(cake)]), [{ method: 'card', amount: 120 }])
    await s.call('orders.cancel', gone.id, 'mistake')
    s.setBranch(annex.id)
    for (let i = 0; i < 6; i++) await s.call('orders.checkout', draft([line(tea)]), [{ method: methods[(i + 1) % 4], amount: 15 }])
    s.setBranch(null)

    const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 5000).toISOString()
    for (const branch of ['all', null, annex.id]) {
      s.setBranch(branch)
      const label = branch === 'all' ? 'all branches' : branch ? 'Annex' : 'Main'
      const walk = async (method: string) => {
        const got: Pay[] = []
        let before: Page['next'] = null, pages = 0, page: Page
        do { page = await s.call<Page>('payments.page', { from, to, method }, before, 7); got.push(...page.rows); before = page.next; pages++ } while (before && pages < 50)
        return { got, page }
      }
      // Every method, page by page: each payment once, newest first — the reference for the filters below.
      const list = (await walk('all')).got
      assert.equal(new Set(list.map((p) => p.id)).size, list.length, `${label}: no payment twice`)
      assert.deepEqual(list, [...list].sort(newest), `${label}: newest first`)
      assert.equal(list.length, branch === 'all' ? 34 : branch ? 6 : 28, `${label}: every payment of the range`)
      const totals: Record<string, number> = {}
      for (const p of list) if (!p.voided) totals[p.method] = r2((totals[p.method] ?? 0) + p.amount)
      for (const method of ['all', ...methods]) {
        const want = list.filter((p) => method === 'all' || p.method === method)
        const { got, page } = await walk(method)
        assert.deepEqual(got, want, `${label} · ${method}: pages joined = that method's payments`)
        assert.equal(page.count, want.length, `${label} · ${method}: count`)
        assert.deepEqual(page.totals, totals, `${label} · ${method}: totals are for every method`)
      }
      if (branch === 'all') {
        assert.equal(list.length, 23 + 2 + 1 + 1 + 1 + 6)
        assert.ok(list.some((p) => p.voided) && list.every((p) => p.billNumber !== undefined))
      }
    }
    s.setBranch(null)
    // Payments module off: an empty page, without reading anything.
    await s.call('business.update', { modules: { payments: false } })
    assert.deepEqual(await s.call('payments.page', { from, to }, null), { rows: [], next: null, count: 0, totals: {} })
  } finally { s.close() }
})
