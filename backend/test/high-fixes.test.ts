import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { expirePoints } from '../src/domain/points'

type P = { id: string; costPrice?: number }
type O = { id: string; total: number; items: { id: string }[] }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

test('cancelling a bill paid with a credit note gives the credit back', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 30 })
    const o1 = await s.call<O>('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 30 }])
    const cn = await s.call<{ number: string; creditRemaining: number }>('returns.create', { orderId: o1.id, lines: [{ orderItemId: o1.items[0].id, qty: 1, restock: true }], reason: 'other', settle: 'credit_note' })
    assert.equal(cn.creditRemaining, 30)
    const o2 = await s.call<O>('orders.checkout', draft([line(tea)]), [{ method: 'credit_note', amount: 30, reference: cn.number }])
    const left = async () => (await s.call<{ creditRemaining: number }>('returns.creditNote', cn.number)).creditRemaining
    assert.equal(await left(), 0)
    await s.call('orders.cancel', o2.id, 'Wrong bill')
    assert.equal(await left(), 30, 'credit back on the note')
    // …and it can be used again.
    await s.call('orders.checkout', draft([line(tea)]), [{ method: 'credit_note', amount: 30, reference: cn.number }])
    assert.equal(await left(), 0)
  } finally { s.close() }
})

test('staff without the right: no sales report, expenses, payments or cost prices — billing still works', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 30, costPrice: 12 })
    assert.equal((await s.call<P[]>('products.list'))[0].costPrice, 12, 'owner sees cost')
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Ravi', phone: '9800000901', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const owner = s.ownerToken
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000901', 'ravi1234')).token)
    const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date().toISOString()
    for (const [name, args] of [['reports.summary', [from, to]], ['reports.byBranch', [from, to]], ['expenses.list', [from, to]]] as [string, unknown[]][]) {
      await assert.rejects(s.call(name, ...args), /permission/, `${name} needs a right`)
    }
    // A cashier has "payments.view" by default, so the payments list stays open to them.
    await s.call('payments.list', from, to)
    assert.equal((await s.call<P[]>('products.list'))[0].costPrice, 0, 'cashier: no cost price')
    const top = await s.call<{ revenue: number }[]>('reports.topProducts', 7, 10)
    assert.ok(top.every((x) => x.revenue === 0), 'quick picks without sales amounts')
    // Billing still works for the cashier.
    const bill = await s.call<O>('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 30 }])
    assert.equal(bill.total, 30)
    // Customers on the QR menu never see cost or wholesale prices.
    s.setToken(null)
    const menu = await s.call<{ products: { costPrice: number; wholesalePrice: number | null }[] }>('public.menu', s.businessId, null, null)
    assert.ok(menu.products.every((p) => p.costPrice === 0 && p.wholesalePrice === null))
    // The owner still gets the full report, with cost of goods.
    s.setToken(owner)
    const rep = await s.call<{ cogs: number }>('reports.summary', from, new Date(Date.now() + 60_000).toISOString())
    assert.equal(rep.cogs, 12)
  } finally { s.close() }
})

test('points expiry: running twice (or at the same time) takes the points once', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, loyalty: { enabled: true } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 100 })
    const cu = await s.call<{ id: string }>('customers.save', { name: 'Anu', phone: '9811100009' })
    await s.call('orders.checkout', draft([line(tea, 5)], { customerId: cu.id }), [{ method: 'cash', amount: 500 }])
    const bal = async () => (await s.call<{ id: string; pointsBalance?: number }[]>('customers.list')).find((x) => x.id === cu.id)!.pointsBalance ?? 0
    const before = await bal()
    assert.ok(before > 0, 'the bill earned points')
    const [a, b] = await Promise.all([expirePoints(s.db, s.businessId, '2999-01-01'), expirePoints(s.db, s.businessId, '2999-01-01')])
    assert.equal(a + b, before, 'taken once in total')
    assert.equal(await bal(), 0)
    assert.equal(await expirePoints(s.db, s.businessId, '2999-01-01'), 0, 'a third run takes nothing')
  } finally { s.close() }
})
