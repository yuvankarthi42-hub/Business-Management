import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { WRITE_MODULE } from '../../src/core/moduleGuards'
import type { ModuleKey } from '../../src/core/types'

type P = { id: string }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })

/** Rows per table, to prove a refused action wrote nothing. */
const TABLES = ['kitchen_tickets', 'dining_tables', 'stock_movements', 'stock_batches', 'purchases', 'suppliers', 'supplier_payments', 'expenses', 'attendance', 'salary_payments', 'staff_advances', 'daily_specials', 'payments'] as const

test('a module that is off: its actions are refused and no database entries are made', async () => {
  const s = await withShop()
  try {
    // Everything on first, to create a running order with a KOT and a product.
    const all = Object.fromEntries(['billing', 'orders', 'products', 'inventory', 'customers', 'payments', 'expenses', 'reports', 'tables', 'kitchen', 'mobileOrders', 'employees', 'specials', 'qrOrdering', 'customerOrders'].map((m) => [m, true]))
    await s.call('business.update', { billing: { taxEnabled: false }, modules: all })
    const tea = await s.call<P & { id: string }>('products.save', { name: 'Tea', price: 20, sendToKitchen: true, trackStock: true, stock: 10 })
    const run = await s.call<{ order: { id: string } }>('orders.save', { type: 'takeaway', tableId: null, customerId: null, items: [line(tea, 2)], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    const [kot] = await s.call<{ id: string }[]>('kitchen.list')
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    const staff = await s.call<{ id: string }>('users.save', { name: 'Ravi', phone: '9800000777', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const today = new Date().toISOString().slice(0, 10)

    // Every listed action, with arguments that would work if its module were on.
    const calls: Record<string, unknown[]> = {
      'kitchen.setStatus': [kot.id, 'preparing'],
      'orders.sendToKitchen': [run.order.id],
      'tables.save': [{ label: 'T9', floor: 'Main', seats: 4 }],
      'tables.remove': ['1'],
      'tables.unmerge': ['1'],
      'orders.transferTable': [run.order.id, '1'],
      'orders.mergeTables': [run.order.id, '1'],
      'inventory.adjust': [tea.id, 'purchase', 5, 'stock in'],
      'inventory.writeOffBatch': ['1', 'expired'],
      'purchases.create': [{ supplierId: '1', supplierBillNo: 'A', date: today, lines: [{ productId: tea.id, qty: 1, cost: 5, taxRate: 0 }], paid: 0, method: 'cash' }],
      'purchases.void': ['1', 'wrong'],
      'suppliers.save': [{ name: 'Arani Weavers' }],
      'suppliers.pay': ['1', { amount: 10, method: 'cash' }],
      'suppliers.voidPayment': ['1', 'wrong'],
      'expenses.save': [{ amount: 100, category: 'rent', method: 'cash', notes: '' }],
      'expenses.void': ['1'],
      'staff.mark': [staff.id, today, 'present'],
      'staff.markAll': [today, 'present'],
      'staff.setPay': [staff.id, { type: 'monthly', amount: 10000 }],
      'staff.giveAdvance': [staff.id, { amount: 500, method: 'cash' }],
      'staff.paySalary': [staff.id, { month: today.slice(0, 7), amount: 100, method: 'cash' }],
      'specials.save': [today, [{ productId: tea.id, specialPrice: 15, tag: '', sort: 0 }]],
      'orders.setFulfilment': [run.order.id, 'packing'],
      'customers.collectDue': ['1', [{ method: 'cash', amount: 10 }]],
    }
    assert.deepEqual(Object.keys(calls).sort(), Object.keys(WRITE_MODULE).sort(), 'every guarded action is tested')

    const count = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await s.db.count(t, { business_id: s.businessId })] as const)))
    const modules = [...new Set(Object.values(WRITE_MODULE))] as ModuleKey[]
    for (const m of modules) {
      await s.call('business.update', { modules: { ...all, [m]: false } })
      const before = await count()
      for (const [action, args] of Object.entries(calls)) {
        if (WRITE_MODULE[action] !== m) continue
        await assert.rejects(s.call(action, ...args), (e: Error & { code?: string }) => e.code === 'MODULE_OFF' && /turned off/.test(e.message), `${action} with ${m} off`)
      }
      assert.deepEqual(await count(), before, `${m} off: nothing written`)
    }

    // Kitchen off: billing still works and makes no KOT.
    await s.call('business.update', { modules: { ...all, kitchen: false } })
    const kots = await s.db.count('kitchen_tickets', { business_id: s.businessId })
    await s.call('orders.save', { type: 'takeaway', tableId: null, customerId: null, items: [line(tea)], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    await s.call('orders.checkout', { type: 'counter', tableId: null, customerId: null, items: [line(tea)], discount: 0, notes: '', source: 'pos' }, [{ method: 'cash', amount: 20 }])
    assert.equal(await s.db.count('kitchen_tickets', { business_id: s.businessId }), kots, 'no KOT rows while Kitchen is off')

    // Turned back on: the same actions work again.
    await s.call('business.update', { modules: all })
    await s.call('expenses.save', { amount: 100, category: 'rent', method: 'cash', notes: '' })
    await s.call('specials.save', today, [{ productId: tea.id, specialPrice: 15, tag: '', sort: 0 }])
    await s.call('kitchen.setStatus', kot.id, 'ready')
  } finally { s.close() }
})
