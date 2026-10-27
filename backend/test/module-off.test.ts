import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { READ_MODULE } from '../../src/core/moduleGuards'

type P = { id: string }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[]) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos' })
const ALL = ['billing', 'orders', 'products', 'inventory', 'customers', 'payments', 'expenses', 'reports', 'tables', 'kitchen', 'mobileOrders', 'employees', 'specials', 'qrOrdering', 'customerOrders']
const all = Object.fromEntries(ALL.map((m) => [m, true]))

test('a module that is off: its reads answer empty (lists) or are refused — and come back when it is on', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { modules: all })
    await s.call('tables.save', { label: 'T1', floor: 'Main', seats: 4 })
    await s.call('expenses.save', { amount: 100, category: 'rent', method: 'cash', notes: '' })
    assert.equal((await s.call<unknown[]>('tables.list')).length, 1)
    const today = new Date().toISOString().slice(0, 10)
    const listArgs: Record<string, unknown[]> = { 'expenses.list': [new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString()], 'payments.list': [new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString()], 'staff.day': [today], 'specials.list': [today] }
    for (const [action, r] of Object.entries(READ_MODULE)) {
      await s.call('business.update', { modules: { ...all, [r.module]: false } })
      if (r.empty) assert.deepEqual(await s.call(action, ...(listArgs[action] ?? [])), [], `${action}: empty while ${r.module} is off`)
      else await assert.rejects(s.call(action, '1'), (e: Error & { code?: string }) => e.code === 'MODULE_OFF', `${action}: refused while ${r.module} is off`)
    }
    // Back on: the real data again.
    await s.call('business.update', { modules: all })
    assert.equal((await s.call<unknown[]>('tables.list')).length, 1)
    assert.equal((await s.call<unknown[]>('expenses.list', ...listArgs['expenses.list'])).length, 1)
  } finally { s.close() }
})

test('Inventory off: bills write no stock; Specials off: no special price; Kitchen off: no KOT read', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: all })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20, trackStock: true, stock: 10 })
    const today = new Date().toISOString().slice(0, 10)
    await s.call('specials.save', today, [{ productId: tea.id, specialPrice: 15, tag: 'Today', sort: 0 }])
    const moves = () => s.db.count('stock_movements', { business_id: s.businessId })
    const stock = async () => (await s.call<{ id: string; stock: number }[]>('products.list')).find((p) => p.id === tea.id)!.stock

    // All on: special price, stock goes down.
    const before = await moves()
    const a = await s.call<{ total: number }>('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 15 }])
    assert.equal(a.total, 15)
    assert.equal(await stock(), 9)
    assert.ok(await moves() > before)

    // Inventory and Specials off: normal price, no stock rows.
    await s.call('business.update', { modules: { ...all, inventory: false, specials: false, kitchen: false } })
    const m0 = await moves()
    const b = await s.call<{ id: string; total: number }>('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 20 }])
    assert.equal(b.total, 20, 'no special price while Specials is off')
    assert.equal(await moves(), m0, 'no stock movement while Inventory is off')
    await s.call('orders.cancel', b.id, 'test')
    assert.equal(await moves(), m0, 'cancel puts nothing back while Inventory is off')
    assert.deepEqual((await s.call<{ kots: unknown[] }>('orders.get', b.id)).kots, [])

    // Back on: works exactly as before.
    await s.call('business.update', { modules: all })
    assert.equal(await stock(), 9)
    const c2 = await s.call<{ total: number }>('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 15 }])
    assert.equal(c2.total, 15)
    assert.equal(await stock(), 8)
  } finally { s.close() }
})

test('QR ordering / Specials off: the public menu and TV board read no catalogue; no tracking work on bills', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: all })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    const today = new Date().toISOString().slice(0, 10)
    await s.call('specials.save', today, [{ productId: tea.id, specialPrice: 15, tag: 'Today', sort: 0 }])
    const owner = s.ownerToken
    const pub = async <T>(name: string, ...args: unknown[]) => { s.setToken(null); try { return await s.call<T>(name, ...args) } finally { s.setToken(owner) } }
    type Menu = { business: { modules: { qrOrdering: boolean } }; products: unknown[]; specials: unknown[] }
    assert.equal((await pub<Menu>('public.menu', s.businessId, null, null)).products.length, 1)
    assert.equal((await pub<{ items: unknown[] }>('public.specials', s.businessId)).items.length, 1)

    await s.call('business.update', { modules: { ...all, qrOrdering: false, specials: false } })
    const off = await pub<Menu>('public.menu', s.businessId, null, null)
    assert.equal(off.business.modules.qrOrdering, false)
    assert.deepEqual([off.products, off.specials], [[], []], 'QR off: no catalogue in the menu')
    assert.deepEqual((await pub<{ items: unknown[] }>('public.specials', s.businessId)).items, [], 'Specials off: empty board')
    await assert.rejects(pub('public.placeOrder', s.businessId, { type: 'takeaway', guest: { name: 'A', phone: '9800000001' }, items: [{ productId: tea.id, qty: 1, addOnIds: [] }] }), /not available/)

    // A bill while QR is off: no tracking stamp in the shared cache.
    const ver = () => s.env.shared.get(`trkv:${s.businessId}`)
    const v0 = await ver()
    await s.call('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 20 }])
    assert.equal(await ver(), v0, 'no tracking work while QR ordering is off')

    // Back on: the menu, board and tracking work as before.
    await s.call('business.update', { modules: all })
    assert.equal((await pub<Menu>('public.menu', s.businessId, null, null)).products.length, 1)
    assert.equal((await pub<{ items: unknown[] }>('public.specials', s.businessId)).items.length, 1)
    await s.call('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 15 }])
    assert.notEqual(await ver(), v0)
  } finally { s.close() }
})
