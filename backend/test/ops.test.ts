import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/modules/ops'
import '../src/modules/reports'
import { withShop } from './fixtures'

type P = { id: string; stock: number }
type Move = { productId: string; type: string; qty: number; balanceAfter: number }
type Batch = { id: string; productId: string; batchNo: string; expiry: string; qty: number; daysLeft: number | null; product: { name: string } | null }
type Exp = { id: string; category: string; amount: number; method: string; voided: boolean }
type Summary = {
  sales: number; orderCount: number; avgOrder: number; paymentsReceived: number; expenses: number; salary: number; net: number; outstanding: number; cogs: number; cancelled: number
  salesByMethod: Record<string, number>; paymentsByMethod: Record<string, number>; expensesByCategory: Record<string, number>; byType: Record<string, { count: number; amount: number }>
  topProducts: { productId: string; name: string; qty: number; revenue: number }[]; series: { key: string; sales: number; orders: number }[]
}

const hour = 3600e3
const range = (back = hour) => [new Date(Date.now() - back).toISOString(), new Date(Date.now() + hour).toISOString()] as const

test('inventory, expenses, reports and audit', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const milk = await s.call<P>('products.save', { name: 'Milk', price: 27, costPrice: 20, trackStock: true, unit: 'pc', lowStockAt: 2 })

    // Purchase with a cost → stock in + a 'purchase' expense.
    await s.call('inventory.adjust', milk.id, 'purchase', 10, 'Supplier', 500)
    await s.call('inventory.adjust', milk.id, 'wastage', 2, 'Spilt')
    await assert.rejects(s.call('inventory.adjust', milk.id, 'adjustment', -20, 'Count'), /below zero/)
    const moves = await s.call<Move[]>('inventory.movements', milk.id)
    assert.deepEqual(moves.map((m) => [m.type, m.qty, m.balanceAfter]), [['wastage', -2, 8], ['purchase', 10, 10]])
    assert.equal((await s.call<P[]>('products.list')).find((p) => p.id === milk.id)!.stock, 8)

    // Batch items need an expiry; batches list with days left; write-off takes that exact batch.
    const curd = await s.call<P>('products.save', { name: 'Curd', price: 30, trackStock: true, trackExpiry: true })
    await assert.rejects(s.call('inventory.adjust', curd.id, 'purchase', 5, 'In'), /expiry/)
    await s.call('inventory.adjust', curd.id, 'purchase', 5, 'In', undefined, { batchNo: 'B1', expiry: '2020-01-01' })
    await s.call('inventory.adjust', curd.id, 'purchase', 3, 'In', undefined, { batchNo: 'B2', expiry: '2099-12-31' })
    const batches = await s.call<Batch[]>('inventory.batches')
    assert.deepEqual(batches.map((b) => [b.batchNo, b.qty]), [['B1', 5], ['B2', 3]])
    assert.ok(batches[0].daysLeft! < 0 && batches[1].daysLeft! > 0)
    assert.equal(batches[0].product?.name, 'Curd')
    await s.call('inventory.writeOffBatch', batches[0].id, 'Expired')
    assert.deepEqual((await s.call<Batch[]>('inventory.batches')).map((b) => b.batchNo), ['B2'])
    assert.equal((await s.call<P[]>('products.list')).find((p) => p.id === curd.id)!.stock, 3)
    assert.equal((await s.call<Move[]>('inventory.movements', curd.id))[0].qty, -5)

    // Expenses: save, list, void.
    const rent = await s.call<Exp>('expenses.save', { amount: 1000, category: 'rent', method: 'bank', notes: 'Oct' })
    assert.equal(rent.category, 'rent')
    await s.call('expenses.save', { amount: 2000, category: 'salary', method: 'cash' })
    await s.call('expenses.save', { amount: 150, category: 'transport' })
    await assert.rejects(s.call('expenses.save', { amount: 0, category: 'rent' }), /valid amount/)
    await s.call('expenses.void', rent.id)
    const exps = await s.call<Exp[]>('expenses.list', ...range())
    assert.equal(exps.length, 4)
    assert.ok(exps.find((e) => e.id === rent.id)!.voided)
    assert.ok(exps.some((e) => e.category === 'purchase' && e.amount === 500))

    // Two bills: one cash, one partly on credit.
    const line = (qty: number) => ({ id: `t${Math.random()}`, productId: milk.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
    const draft = (qty: number, extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items: [line(qty)], discount: 0, notes: '', source: 'pos', ...extra })
    await s.call('orders.checkout', draft(2), [{ method: 'cash', amount: 54 }])
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Raja', phone: '9800011122' })
    await s.call('orders.checkout', draft(1, { customerId: cust.id }), [{ method: 'upi', amount: 10 }])

    const sum = await s.call<Summary>('reports.summary', ...range())
    assert.equal(sum.sales, 81)
    assert.equal(sum.orderCount, 2)
    assert.equal(sum.avgOrder, 40.5)
    assert.equal(sum.paymentsByMethod.cash, 54)
    assert.equal(sum.paymentsByMethod.upi, 10)
    assert.equal(sum.paymentsReceived, 64)
    assert.equal(sum.salesByMethod.credit, 17)
    assert.equal(sum.outstanding, 17)
    assert.deepEqual(sum.topProducts.map((p) => [p.name, p.qty, p.revenue]), [['Milk', 3, 81]])
    assert.deepEqual(sum.expensesByCategory, { purchase: 500, transport: 150 })
    assert.equal(sum.expenses, 650)
    assert.equal(sum.salary, 2000)
    assert.equal(sum.net, 81 - 650 - 2000)
    assert.equal(sum.cogs, 60)
    assert.deepEqual(sum.byType, { counter: { count: 2, amount: 81 } })
    assert.equal(sum.series.length, 16) // hourly 8 AM – 11 PM
    assert.equal(sum.series.reduce((a, r) => a + r.sales, 0), 81)

    const week = await s.call<Summary>('reports.summary', ...range(6 * 24 * hour))
    assert.ok(week.series.length >= 7 && week.series[0].key.length > 2)
    assert.equal(week.series.reduce((a, r) => a + r.orders, 0), 2)

    // Receivables: the customer with a balance.
    const rec = await s.call<{ customer: { id: string; name: string }; outstanding: number; orderCount: number; totalPurchases: number }[]>('reports.receivables')
    assert.deepEqual(rec.map((r) => [r.customer.name, r.outstanding, r.orderCount, r.totalPurchases]), [['Raja', 17, 1, 27]])

    // Branch overview: one row per branch in view.
    const annex = await s.call<{ id: string }>('branches.save', { name: 'Annex' })
    s.setBranch('all')
    const rows = await s.call<{ branch: { id: string }; summary: Summary; running: number; lowStock: { name: string; stock: number }[] }[]>('reports.byBranch', ...range())
    assert.equal(rows.length, 2)
    const main = rows.find((r) => r.branch.id === s.mainBranch)!, other = rows.find((r) => r.branch.id === annex.id)!
    assert.equal(main.summary.sales, 81)
    assert.equal(other.summary.sales, 0)
    assert.equal(other.summary.expenses, 0)
    assert.ok(other.lowStock.some((x) => x.name === 'Milk' && x.stock === 0))
    assert.ok(!main.lowStock.some((x) => x.name === 'Milk')) // 5 left > 2
    // "All branches" is read-only for stock changes.
    await assert.rejects(s.call('inventory.adjust', milk.id, 'purchase', 1, 'x'), /Choose a branch/)
    s.setBranch(null)

    // Audit log, newest first, with names.
    const logs = await s.call<{ entity: string; action: string; userName: string; entityId: string; detail: string }[]>('audit.list', 100)
    assert.ok(logs.length > 5)
    const v = logs.find((l) => l.entity === 'expense' && l.action === 'void')!
    assert.equal(v.entityId, rent.id)
    assert.equal(v.userName, 'Lakshmi')
    assert.ok(logs.some((l) => l.entity === 'inventory' && l.detail.startsWith('purchase:')))
  } finally { s.close() }
})
