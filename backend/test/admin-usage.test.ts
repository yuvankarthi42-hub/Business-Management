import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP } from './helpers'

type Usage = { rows: { id: string; bills7: number; bills30: number; sales30: number; lastBillAt: string | null }[]; months: unknown[]; summary: Record<string, number>; usageAt: string }
const line = (p: { id: string }, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[]) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos' })
const sameExceptTime = (a: Usage, b: Usage) => { const { usageAt: _a, ...x } = a; const { usageAt: _b, ...y } = b; void _a; void _b; return assert.deepEqual(x, y) }

test('admin.usage: bill counts from the daily copy (one database per shop), new shops read live, same numbers', async () => {
  const s = await withShop()
  process.env.CRON_KEY = 'test-cron-key-123-0123456789abcdef'
  const shared = (s.env as unknown as { shared: { get(k: string): Promise<string | null> } }).shared
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 15 })
    const bill = () => s.call('orders.checkout', draft([line(tea, 2)]), [{ method: 'cash', amount: 30 }])
    for (let i = 0; i < 3; i++) await bill()
    const owner = s.ownerToken
    const asAdmin = () => { s.setToken(s.adminToken) }
    const usage = async () => { asAdmin(); const u = await s.call<Usage>('admin.usage'); s.setToken(owner); return u }

    // No copy yet: read live (and, on Turso, kept as the copy).
    const first = await usage()
    const mine = () => first.rows.find((r) => r.id === s.businessId)!
    assert.deepEqual([mine().bills7, mine().bills30, mine().sales30], [3, 3, 90])
    assert.ok(mine().lastBillAt)
    assert.equal(!!(await shared.get('admin:usage')), PER_SHOP, 'Turso: a copy is kept')

    // The daily job counts every shop again: the same numbers as the live read.
    await s.call('system.runDailyJobs', 'test-cron-key-123-0123456789abcdef')
    const daily = await usage()
    sameExceptTime(daily, first)

    // A bill after the daily count: Turso shows the daily copy (updated next run); one database reads live.
    await bill()
    const after = await usage()
    assert.equal(after.rows.find((r) => r.id === s.businessId)!.bills7, PER_SHOP ? 3 : 4)
    if (PER_SHOP) assert.equal(after.usageAt, daily.usageAt, 'the copy’s time')

    // A shop created after the copy: read live, so it is never missing.
    asAdmin()
    const shop2 = await s.call<{ id: string }>('admin.createCustomer', { businessName: 'New Shop', ownerName: 'Ravi', username: 'ravi2', password: 'shop5678', phone: '9876500000', validity: { months: 12 }, maxBranches: 1 })
    s.setToken(null); s.useShop(shop2.id)
    s.setToken((await s.call<{ token: string }>('auth.login', 'ravi2', 'shop5678')).token)
    await s.call('business.update', { billing: { taxEnabled: false } })
    const cake = await s.call<{ id: string }>('products.save', { name: 'Cake', price: 100 })
    await s.call('orders.checkout', draft([line(cake)]), [{ method: 'cash', amount: 100 }])
    s.useShop(s.businessId)
    const withNew = await usage()
    const r2 = withNew.rows.find((r) => r.id === shop2.id)!
    assert.deepEqual([r2.bills7, r2.bills30, r2.sales30], [1, 1, 100])
    assert.equal(withNew.summary.customers, 2)

    // The next day's run (today's round is finished — moved back a day): the copy has both shops and today's bills.
    const platform = await s.env.dbs.platform()
    const row = (await platform.first('platform_settings', { setting_key: 'dailyJobs' }))!
    const st = JSON.parse(String(row.value_json))
    st.round.finishedOn = '2000-01-01'
    await platform.update('platform_settings', row.ROWID, { value_json: JSON.stringify(st) })
    await s.call('system.runDailyJobs', 'test-cron-key-123-0123456789abcdef')
    const next = await usage()
    assert.deepEqual(next.rows.map((r) => [r.id, r.bills7]).sort(), [[s.businessId, 4], [shop2.id, 1]].sort())
  } finally { delete process.env.CRON_KEY; s.close() }
})
