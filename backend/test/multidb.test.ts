// One database per shop (Turso layout, on real SQLite): isolation, sign-in names across shops, deleting a
// customer, many counters billing at once, the change feed, transactions, secrets and migrations.
// Parts that only exist with one database per shop are skipped in TEST_DB=memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ctx } from '../src/core/context'
import { migrate } from '../src/db/migrate'
import { MIGRATIONS } from '../src/db/migrations.gen'
import { SqlJsDriver, sqlJs } from '../src/db/sql/sqljs'
import { TursoDb } from '../src/db/turso'
import { withShop } from './fixtures'
import { PER_SHOP, TEST_DB } from './helpers'

type P = { id: string; stock: number }
type O = { id: string; status: string; invoiceNumber: string }
const perShop = PER_SHOP
const line = (p: P, qty: number) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[]) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos' })

test('two shops: own data, sign-in names unique across shops, delete removes everything', async () => {
  const s = await withShop()
  try {
    await s.call('products.save', { name: 'Only in shop A', price: 10 })
    s.setToken(s.adminToken)
    // Same username or mobile as shop A's owner: refused, and nothing is left half-made.
    await assert.rejects(s.call('admin.createCustomer', { businessName: 'Shop B', ownerName: 'Ravi', username: 'lakshmi', password: 'shop1234', phone: '9876500001', validity: { months: 1 }, maxBranches: 1 }), /already taken/)
    await assert.rejects(s.call('admin.createCustomer', { businessName: 'Shop B', ownerName: 'Ravi', username: 'ravi01', password: 'shop1234', phone: '9876543210', validity: { months: 1 }, maxBranches: 1 }), /already used/)
    assert.equal((await s.call<unknown[]>('admin.customers')).length, 1)
    const b = await s.call<{ id: string }>('admin.createCustomer', { businessName: 'Shop B', ownerName: 'Ravi', username: 'ravi01', password: 'shop1234', phone: '9876500001', validity: { months: 1 }, maxBranches: 1 })
    const list = await s.call<{ id: string; ownerName: string; username: string; phone: string; branchesUsed: number }[]>('admin.customers')
    const rowB = list.find((x) => x.id === b.id)!
    assert.deepEqual([rowB.ownerName, rowB.username, rowB.phone, rowB.branchesUsed], ['Ravi', 'ravi01', '+919876500001', 1])

    s.setToken(null)
    const loginB = await s.call<{ token: string }>('auth.login', '9876500001', 'shop1234')
    s.setToken(loginB.token)
    assert.equal((await s.call<unknown[]>('products.list')).length, 0) // shop A's product is not here
    // Staff of shop B can't take shop A's owner mobile number.
    const roles = await s.call<{ id: string }[]>('roles.list')
    await assert.rejects(s.call('users.save', { name: 'Kumar', phone: '9876543210', roleId: roles[0].id, password: 'staff123' }), /already used/)
    const staff = await s.call<{ id: string }>('users.save', { name: 'Kumar', phone: '9876500002', roleId: roles[0].id, password: 'staff123' })
    // Changing a mobile number frees the old one (after the save) and the new one signs in.
    await s.call('users.save', { id: staff.id, name: 'Kumar', phone: '9876500003', roleId: roles[0].id })
    s.setToken(null)
    await assert.rejects(s.call('auth.login', '9876500002', 'staff123'), /Wrong mobile number/)
    await s.call('auth.login', '9876500003', 'staff123')

    // The admin edits shop A's owner: the list shows it, the new username signs in, the old one doesn't.
    s.setToken(s.adminToken)
    await s.call('admin.updateCustomer', s.businessId, { username: 'lakshmi2', ownerName: 'Lakshmi R' })
    const rowA = (await s.call<{ id: string; ownerName: string; username: string }[]>('admin.customers')).find((x) => x.id === s.businessId)!
    assert.deepEqual([rowA.ownerName, rowA.username], ['Lakshmi R', 'lakshmi2'])
    s.setToken(null)
    await assert.rejects(s.call('auth.login', 'lakshmi', 'shop1234'), /Wrong/)
    await s.call('auth.login', 'lakshmi2', 'shop1234')

    // Delete shop B: its signed-in token stops working and its names are free again.
    s.setToken(s.adminToken)
    await s.call('admin.deleteCustomer', b.id, 'Shop B')
    s.setToken(loginB.token)
    await assert.rejects(s.call('products.list'), (e: Error & { status: number }) => e.status === 401)
    s.setToken(s.adminToken)
    await s.call('admin.createCustomer', { businessName: 'Shop C', ownerName: 'Ravi', username: 'ravi01', password: 'shop1234', phone: '9876500001', validity: { months: 1 }, maxBranches: 1 })
    if (perShop) {
      const platform = await s.env.dbs.platform()
      assert.equal(await platform.count('shop_databases', { business_id: b.id }), 0)
      assert.equal(await platform.count('login_names', { business_id: b.id }), 0)
    }
  } finally { s.close() }
})

test('20 counters bill at the same moment: every bill saved once, numbers unique, stock exact', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const milk = await s.call<P>('products.save', { name: 'Milk', price: 27, trackStock: true, stock: 100, unit: 'pc' })
    const bread = await s.call<P>('products.save', { name: 'Bread', price: 40, trackStock: true, stock: 100, unit: 'pc' })
    const t0 = Date.now()
    const bills = await Promise.all(Array.from({ length: 20 }, () => s.call<O>('orders.checkout', draft([line(milk, 2), line(bread, 1)]), [{ method: 'cash', amount: 94 }])))
    const ms = Date.now() - t0
    assert.equal(bills.filter((b) => b.status === 'completed').length, 20)
    assert.equal(new Set(bills.map((b) => b.invoiceNumber)).size, 20)
    const list = await s.call<P[]>('products.list')
    assert.equal(list.find((p) => p.id === milk.id)!.stock, 60)
    assert.equal(list.find((p) => p.id === bread.id)!.stock, 80)
    if (TEST_DB === 'sqlite') {
      // How long a bill holds the shop's write lock, in round trips to the database (BEGIN … COMMIT).
      const drv = s.env.prov!.open.get(`local-shop-${s.businessId}`)!
      console.log(`20 bills in ${ms} ms locally; a bill holds the lock for ${drv.stats.lastTxCalls} round trips`)
      assert.ok(drv.stats.lastTxCalls <= 18, `a bill used ${drv.stats.lastTxCalls} round trips inside its transaction`)
    }
  } finally { s.close() }
})

test('change feed: other devices learn what changed, not their own changes', { skip: !perShop }, async () => {
  const s = await withShop()
  try {
    s.setDevice('counter-one-aaaa')
    const first = await s.call<{ supported: boolean; latest: number }>('sync.changes', null)
    assert.equal(first.supported, true)
    await s.call('products.save', { name: 'Tea', price: 10 })
    await s.call('customers.save', { name: 'Raja', phone: '9800011122' })
    await s.call('auth.setLanguage', 'ta') // a personal change: not for the other devices
    const mine = await s.call<{ changes: string[]; latest: number }>('sync.changes', first.latest)
    assert.deepEqual(mine.changes, []) // this device already has its own changes
    assert.ok(mine.latest > first.latest)
    s.setDevice('counter-two-bbbb')
    const other = await s.call<{ changes: string[] }>('sync.changes', first.latest)
    assert.deepEqual(other.changes.sort(), ['customers.save', 'products.save'])
    // A failed write leaves no trace in the feed (it was rolled back with everything else).
    await assert.rejects(s.call('customers.save', { name: '' }))
    assert.equal((await s.call<{ latest: number }>('sync.changes', mine.latest)).latest, mine.latest)
  } finally { s.close() }
})

test('a transaction saves everything or nothing', async () => {
  const s = await withShop()
  try {
    const c = new Ctx(s.env, await s.env.dbs.platform(), null)
    await c.useShop(s.businessId)
    let undone = false
    c.onFail(async () => { undone = true })
    await assert.rejects(c.tx(async () => {
      await c.db.insert('customers', { business_id: s.businessId, name: 'Half saved', phone_key: `${s.businessId}:x1`, is_active: true, marketing_opt_in: false })
      throw new Error('stop here')
    }), /stop here/)
    await c.finish(false)
    assert.equal(undone, true)
    assert.equal(await c.db.count('customers', { name: 'Half saved' }), 0)
  } finally { s.close() }
})

test('secrets are encrypted at rest; migrations add up to the schema file', { skip: !perShop }, async () => {
  const SQL = await sqlJs()
  const drv = new SqlJsDriver(new SQL.Database())
  await migrate(drv, 'shop')
  const db = new TursoDb(drv)
  await db.insert('secrets', { owner_type: 2, business_id: '1', kind: 1, uniq_key: '2:1:1', value: 'EAAB-secret-token', last4: 'oken' })
  const [raw] = await db.sql('SELECT "value" FROM "secrets"')
  assert.match(String(raw.value), /^v1:/)
  assert.ok(!String(raw.value).includes('secret-token'))
  assert.equal((await db.first('secrets', { uniq_key: '2:1:1' }))!.value, 'EAAB-secret-token')
  // Running the migrations again does nothing; every table of the schema file exists.
  assert.deepEqual(await migrate(drv, 'shop'), [])
  const full = MIGRATIONS.shop[0].sql
  const want = [...full.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]).sort()
  const have = (await db.sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r) => String(r.name)).sort()
  assert.deepEqual(have, want)
})
