import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP } from './helpers'

/** Query counts are measured where each shop has its own database (Turso); the single-database store has one handle. */
const counted = (fn: () => void) => { if (PER_SHOP) fn() }
import type { Db } from '../src/db/types'

type P = { id: string }
type O = { id: string; customerId: string | null; total: number; items: { id: string }[] }

/** Counts database calls of the test shop (to prove a read came from the cache). */
function countQueries(env: { dbs: { shop: (id: string) => Promise<Db> } }) {
  const count = { n: 0 }
  const orig = env.dbs.shop.bind(env.dbs)
  env.dbs.shop = async (id: string) => {
    const db = await orig(id)
    return new Proxy(db, { get(t, k, r) { const v = Reflect.get(t, k, r); return typeof v === 'function' && ['select', 'first', 'get', 'count', 'aggregate', 'sql', 'sqlMany'].includes(String(k)) ? (...a: unknown[]) => { count.n++; return (v as (...x: unknown[]) => unknown).apply(t, a) } : v } })
  }
  return count
}
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

test('orders.list: a limit returns only the newest n; a date range lists each order once', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    for (let i = 0; i < 8; i++) await s.call('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 20 }])
    const six = await s.call<O[]>('orders.list', { status: 'completed', limit: 6 })
    assert.equal(six.length, 6)
    const all = await s.call<O[]>('orders.list', { status: 'completed' })
    assert.deepEqual(six.map((o) => o.id), all.slice(0, 6).map((o) => o.id), 'the same newest six as before')
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3600_000).toISOString()
    const ranged = await s.call<O[]>('orders.list', { from, to, status: 'all' })
    assert.equal(ranged.length, 8)
    assert.equal(new Set(ranged.map((o) => o.id)).size, 8, 'no order twice')
    assert.ok(ranged.every((o) => o.items.length === 1))
  } finally { s.close() }
})

test('reports: a finished range comes from the cache until the past changes; today is always fresh; top products', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    const q = countQueries(s.env as never)
    const yFrom = new Date(Date.now() - 3 * 86_400_000).toISOString(), yTo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    await s.call('reports.summary', yFrom, yTo)
    // Any signed-in call reads one row in the shop's database first (the sign-in check).
    const base = 1
    const n0 = q.n
    await s.call('reports.summary', yFrom, yTo)
    counted(() => assert.equal(q.n - n0, base, 'finished range: no report read the second time (only the sign-in check)'))
    // Today's new sale doesn't touch a finished range (still cached) — but it shows in today's report at once.
    const now0 = new Date(); now0.setHours(0, 0, 0, 0)
    const today = () => s.call<{ orderCount?: number; totalSales?: number; sales?: number }>('reports.summary', new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 60_000).toISOString())
    const before = JSON.stringify(await today())
    const o = await s.call<O>('orders.checkout', draft([line(tea, 2)]), [{ method: 'cash', amount: 40 }])
    assert.notEqual(JSON.stringify(await today()), before, 'today is always worked out fresh')
    const n1 = q.n
    await s.call('reports.summary', yFrom, yTo)
    counted(() => assert.equal(q.n - n1, base, 'a new sale today keeps the finished range cached'))
    // A return rewrites the past: the cached copy is dropped.
    await s.call('returns.create', { orderId: o.id, lines: [{ orderItemId: o.items[0].id, qty: 1, restock: true }], reason: 'other', settle: 'refund', refundMethod: 'cash' })
    const n2 = q.n
    await s.call('reports.summary', yFrom, yTo)
    counted(() => assert.ok(q.n - n2 > base, 'after a return the finished range is read again'))
    // Billing screen quick picks: last 7 finished days, cached.
    const top = await s.call<unknown[]>('reports.topProducts', 7, 10)
    assert.ok(Array.isArray(top))
    const n3 = q.n
    await s.call('reports.topProducts', 7, 10)
    counted(() => assert.equal(q.n - n3, base))
  } finally { s.close() }
})

test('customers: totals from the cache between changes; a bill updates them; one customer for a bill drawer', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    const cu = await s.call<{ id: string }>('customers.save', { name: 'Anu', phone: '9811100001' })
    await s.call('orders.checkout', draft([line(tea)], { customerId: cu.id }), [{ method: 'cash', amount: 20 }])
    const q = countQueries(s.env as never)
    type C = { id: string; stats: { orderCount: number; totalPurchases: number } }
    const l1 = await s.call<C[]>('customers.list')
    const n0 = q.n
    const l2 = await s.call<C[]>('customers.list')
    counted(() => assert.ok(q.n - n0 < 4, 'totals not re-added up (only the customer rows are read)'))
    assert.deepEqual(l2.find((x) => x.id === cu.id)!.stats, l1.find((x) => x.id === cu.id)!.stats)
    await s.call('orders.checkout', draft([line(tea, 2)], { customerId: cu.id }), [{ method: 'cash', amount: 40 }])
    const l3 = await s.call<C[]>('customers.list')
    assert.deepEqual([l3.find((x) => x.id === cu.id)!.stats.orderCount, l3.find((x) => x.id === cu.id)!.stats.totalPurchases], [2, 60], 'a new bill shows at once')
    const one = await s.call<C>('customers.one', cu.id)
    assert.deepEqual(one.stats, l3.find((x) => x.id === cu.id)!.stats)
    assert.equal(await s.call('customers.one', '999999'), null)
  } finally { s.close() }
})

test('QR menu: every table of a branch shares one cached copy; kitchen list has no duplicates; track by number', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true, qrOrdering: true, tables: true, products: true }, qr: { orderTypes: ['dine_in', 'takeaway'], autoAccept: false, baseUrl: '' } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20, sendToKitchen: true })
    const t1 = await s.call<{ id: string }>('tables.save', { label: 'T1', floor: 'Main', seats: 4 })
    const t2 = await s.call<{ id: string }>('tables.save', { label: 'T2', floor: 'Main', seats: 4 })
    await s.call('orders.save', draft([line(tea)], { type: 'takeaway' }), { sendToKitchen: true })
    const kots = await s.call<{ id: string }[]>('kitchen.list')
    assert.equal(new Set(kots.map((k) => k.id)).size, kots.length)
    assert.equal(kots.length, 1)
    const owner = s.ownerToken
    s.setToken(null)
    const q = countQueries(s.env as never)
    const m1 = await s.call<{ tables: { id: string }[]; products: unknown[] }>('public.menu', s.businessId, null, t1.id)
    await s.call('public.menu', s.businessId, null, t2.id) // learns T2's branch
    const n0 = q.n
    const m3 = await s.call<{ tables: { id: string }[] }>('public.menu', s.businessId, null, t1.id)
    await s.call('public.menu', s.businessId, null, t2.id)
    counted(() => assert.equal(q.n, n0, 'both tables: no database read'))
    assert.deepEqual(m3, m1)
    // A table change refreshes it.
    s.setToken(owner)
    await s.call('tables.save', { id: t2.id, label: 'T2 window', floor: 'Main', seats: 4 })
    s.setToken(null)
    const m4 = await s.call<{ tables: { label: string }[] }>('public.menu', s.businessId, null, t1.id)
    assert.ok(m4.tables.some((t) => t.label === 'T2 window'))
    // Track my order still finds orders by number.
    const placed = await s.call<{ orderId: string; number: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: tea.id, variantId: null, addOnIds: [], qty: 1, notes: '' }], guest: { name: 'Anu', phone: '9811122233', address: '' }, notes: '' })
    assert.equal((await s.call<{ orderId: string }>('public.track', s.businessId, placed.number.replace(/\D/g, ''))).orderId, placed.orderId)
    await assert.rejects(s.call('public.track', '999999', '1'), /Shop not found/)
  } finally { s.close() }
})

test('app start-up in one call (auth.boot) returns exactly what the separate reads return', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { modules: { billing: true, qrOrdering: true, tables: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const boot = await s.call<{ me: unknown; support: unknown; qrPending: unknown; feed: { supported: boolean } }>('auth.boot')
    assert.deepEqual(boot.me, await s.call('auth.me'))
    assert.deepEqual(boot.support, await s.call('support.mine'))
    assert.deepEqual(boot.qrPending, await s.call('qr.pending'))
    const feed = await s.call<{ supported: boolean; latest?: number }>('sync.changes', null)
    assert.equal(boot.feed.supported, feed.supported)
    // A role without QR rights gets no QR list in it.
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Kumar', phone: '9800000990', roleId: roles.find((r) => r.name === 'Kitchen Staff')!.id, password: 'kumar123' })
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000990', 'kumar123')).token)
    assert.equal((await s.call<{ qrPending: unknown }>('auth.boot')).qrPending, null)
  } finally { s.close() }
})
