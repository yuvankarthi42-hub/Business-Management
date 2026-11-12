// The lighter reads added after the 10 Nov audit: the Dashboard in one call, only the customers a screen shows,
// "large shop?" before the first product page, and the printer settings of a branch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP } from './helpers'

type P = { id: string }
type C = { id: string; name: string; phone: string; stats: { outstanding: number } }
type S = { sales: number; orderCount: number; paymentsReceived: number; expenses: number; salary: number; topProducts: unknown[]; series: unknown[] }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

test('reports.dashboard = the three summaries it replaces (this range, the compared totals, yesterday’s chart)', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 15 })
    for (let i = 0; i < 3; i++) await s.call('orders.checkout', draft([line(tea, 2)]), [{ method: 'cash', amount: 30 }])
    await s.call('expenses.save', { category: 'rent', amount: 100, method: 'cash' })
    const now = Date.now(), day = 864e5
    const cur = [new Date(now - 3600e3).toISOString(), new Date(now + 3600e3).toISOString()] as const
    const prev = { from: new Date(now - day - 3600e3).toISOString(), to: new Date(now - day).toISOString() }
    const yest = { from: new Date(now - 2 * day).toISOString(), to: new Date(now - day).toISOString() }
    const d = await s.call<{ current: S; previous: Record<string, number>; yesterdaySeries: unknown[] | null }>('reports.dashboard', ...cur, prev, { top: 5, yesterday: yest })
    const a = await s.call<S>('reports.summary', ...cur, { top: 5 })
    const b = await s.call<S>('reports.summary', prev.from, prev.to)
    const y = await s.call<S>('reports.summary', yest.from, yest.to)
    assert.deepEqual(d.current, a)
    assert.equal(a.sales, 90); assert.equal(a.orderCount, 3); assert.equal(a.expenses, 100)
    assert.deepEqual(d.previous, { sales: b.sales, orderCount: b.orderCount, paymentsReceived: b.paymentsReceived, expenses: b.expenses, salary: b.salary })
    assert.deepEqual(d.yesterdaySeries, y.series)
    assert.equal((await s.call<{ yesterdaySeries: unknown }>('reports.dashboard', ...cur, prev, { top: 5 })).yesterdaySeries, null)
    await assert.rejects(s.call('reports.dashboard', ...cur), /Check the request|date range/)
  } finally { s.close() }
})

test('customers.byIds / customers.search give exactly the customers.list rows asked for', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const ravi = await s.call<C>('customers.save', { name: 'Ravi Kumar', phone: '9876543210' })
    const priya = await s.call<C>('customers.save', { name: 'Priya', phone: '9123456780' })
    await s.call<C>('customers.save', { name: 'Ravindran', phone: '' })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 15 })
    await s.call('orders.checkout', draft([line(tea, 2)], { customerId: ravi.id }), [{ method: 'cash', amount: 10 }])
    const all = await s.call<C[]>('customers.list')
    const row = (id: string) => all.find((x) => x.id === id)
    const byName = (xs: C[]) => [...xs].sort((x, y) => x.name.localeCompare(y.name))
    assert.deepEqual(byName(await s.call<C[]>('customers.byIds', [ravi.id, priya.id, 'zzz'])), byName([row(ravi.id)!, row(priya.id)!]))
    assert.equal(row(ravi.id)!.stats.outstanding, 20, 'with their totals (Due), as the list has them')
    const names = async (q: string) => (await s.call<C[]>('customers.search', q)).map((x) => x.name).sort()
    assert.deepEqual(await names('ravi'), ['Ravi Kumar', 'Ravindran'])
    assert.deepEqual(await names('RAVI'), ['Ravi Kumar', 'Ravindran'])
    assert.deepEqual(await names('98765'), ['Ravi Kumar'])
    assert.deepEqual(await names('91234 567'), ['Priya'], 'phone digits, typed with a space')
    assert.deepEqual(await names(''), all.map((x) => x.name).sort())
    assert.deepEqual(await names('%'), [], '% is a character, not a wildcard')
    assert.deepEqual((await s.call<C[]>('customers.search', 'Priya'))[0], row(priya.id))
    assert.deepEqual(await s.call('customers.byIds', []), [])
    await assert.rejects(s.call('customers.byIds', 'x'), /Check the request/)
  } finally { s.close() }
})

test('products.page checkLarge: a large shop is told at once (no page built); smaller shops get the same first page', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  try {
    const add = async (from: number, n: number) => {
      for (let i = 0; i < n; i += 500) {
        const rows = Array.from({ length: Math.min(500, n - i) }, (_, k) => ({ row: from + i + k + 2, name: `P ${String(from + i + k).padStart(5, '0')}`, price: 10 }))
        await s.call('products.importMany', rows, { onExisting: 'skip', fileName: 'x.csv' })
      }
    }
    type Page = { rows: P[]; next: number | null; total?: number; large?: boolean }
    const same = async (label: string) => { const plain = await s.call<Page>('products.page', 0); assert.deepEqual(await s.call<Page>('products.page', 0, { checkLarge: true }), plain, label); return plain }
    await add(0, 50); await same('50 products')
    await add(50, 1950); assert.equal((await same('2,000 products')).total, 2000)
    await add(2000, 1)
    assert.deepEqual(await s.call<Page>('products.page', 0, { checkLarge: true }), { rows: [], next: null, large: true })
    const old = await s.call<Page>('products.page', 0)
    assert.equal(old.total, 2001); assert.equal(old.rows.length, 300, 'without the option (an older app): as before')
    await assert.rejects(s.call('products.page', 0, 'x'), /Check the request/)
  } finally { s.close() }
})

test('branches.savePrinter keeps only known settings; branches.addDemo is refused outside the demo', async () => {
  const s = await withShop()
  try {
    const me = await s.call<{ branch: { id: string } }>('auth.me')
    const saved = await s.call<{ transport: string; paper: string | null; copies: number; baudRate: number; autoPrint: boolean }>('branches.savePrinter', me.branch.id, { transport: 'serial', paper: '58mm', copies: 9, baudRate: 1234, autoPrint: true, junk: 'x' } as never)
    assert.equal(saved.transport, 'serial'); assert.equal(saved.paper, '58mm'); assert.equal(saved.copies, 3, 'at most 3 copies'); assert.equal(saved.baudRate, 9600, 'unknown speed: kept as it was'); assert.equal(saved.autoPrint, true)
    assert.equal((saved as Record<string, unknown>).junk, undefined)
    await assert.rejects(s.call('branches.savePrinter', '999999', { transport: 'usb' }), /Branch not found/)
    await assert.rejects(s.call('branches.addDemo'), /only available in the demo app/)
  } finally { s.close() }
})
