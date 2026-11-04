import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP } from './helpers'

type P = { id: string; name: string; stock: number; costPrice: number }
type Page = { rows: P[]; next: number | null }

/** All pages of products.page, joined — what the app's remote client does. */
async function walk(call: <T>(name: string, ...args: unknown[]) => Promise<T>) {
  const all: P[] = []
  let after: number | null = 0, pages = 0
  while (after !== null) { const p: Page = await call<Page>('products.page', after); all.push(...p.rows); after = p.next; pages++ }
  return { all, pages }
}

test('products.page: every item exactly once, in list order, for every branch view and for staff; products.list is removed', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { wholesale: { enabled: true, label: 'Wholesale' } } })
    const annex = await s.call<{ id: string }>('branches.save', { name: 'Annex' })
    // 650 products: 3 pages on Turso (300 + 300 + 50), with variants, add-ons, wholesale prices and stock.
    const rows = Array.from({ length: 650 }, (_, i) => ({
      row: i + 2, name: `Item ${String(i).padStart(3, '0')}`, price: 10 + (i % 90), costPrice: 5 + (i % 40), categoryName: i % 2 ? 'Snacks' : 'Drinks',
      ...(i % 9 === 0 ? { wholesalePrice: 8 + (i % 30) } : {}), ...(i % 11 === 0 ? { variants: [{ name: 'Small', price: 10 }, { name: 'Large', price: 18 }] } : {}),
      ...(i % 13 === 0 ? { addOns: [{ name: 'Extra', price: 5 }] } : {}), trackStock: i % 3 !== 0, stock: i % 3 ? 20 + (i % 7) : 0,
    }))
    await s.call('products.importMany', rows, { onExisting: 'skip', fileName: 'items.csv' })

    let mainList: P[] = []
    for (const branch of ['all', null, annex.id]) {
      s.setBranch(branch)
      const { all, pages } = await walk(s.call)
      const label = branch === 'all' ? 'all branches' : branch ? 'Annex' : 'Main'
      assert.equal(new Set(all.map((p) => p.id)).size, 650, `every item exactly once · ${label}`)
      assert.deepEqual(all.map((p) => p.name), rows.map((r) => r.name), `in the list's order · ${label}`)
      assert.equal(pages, PER_SHOP ? 3 : 1, 'Turso: pages of 300; Data Store: one page, as before')
      if (branch === null) mainList = all
    }
    s.setBranch(null)
    assert.ok(mainList.some((p) => p.costPrice > 0), 'the owner sees cost prices')
    // The old full-list call is gone from the server (the app reads products.page).
    await assert.rejects(s.call('products.list'), (e: Error & { status?: number }) => e.status === 404 && /Unknown action/.test(e.message))

    // A cashier (no cost rights): the pages hide the cost the same way the list does.
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Ravi', phone: '9800000901', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const owner = await s.call<{ token: string }>('auth.login', '9800000901', 'ravi1234')
    s.setToken(owner.token)
    const cashierList = (await walk(s.call)).all
    assert.deepEqual(cashierList.map((p) => p.id), mainList.map((p) => p.id))
    assert.ok(cashierList.every((p) => p.costPrice === 0), 'cost hidden for staff without that right')
    s.setToken(s.ownerToken)

    // A bad page start is read as 0, never an error.
    assert.deepEqual((await s.call<Page>('products.page', 'x')).rows.length, PER_SHOP ? 300 : 650)
    assert.deepEqual((await s.call<Page>('products.page', 10_000)).rows, PER_SHOP ? [] : mainList)
  } finally { s.close() }
})
