// Low fixes, step 2: L12 (credit note ownership), L13 (wholesale prices and salesperson), L14 (input limits).
// Each rule is also tried straight against the API (what a changed browser could send).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type S = Awaited<ReturnType<typeof withShop>>
type O = { id: string; total: number; items: { id: string }[]; status: string }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const line = (productId: string, qty: number, extra: Record<string, unknown> = {}) => ({ id: `tmp_${Math.random()}`, productId, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', ...extra })
const draft = (items: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const code = (e: unknown) => (e as { code?: string }).code

async function shop() {
  const s = await withShop()
  await s.call('business.update', { billing: { taxEnabled: false, wholesale: { enabled: true, label: 'Wholesale' } } })
  const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 100, wholesalePrice: 80 })
  const rice = await s.call<{ id: string }>('products.save', { name: 'Rice', price: 60, unit: 'kg' })
  const cloth = await s.call<{ id: string }>('products.save', { name: 'Cloth', price: 200, unit: 'mtr' })
  const roles = await s.call<{ id: string; name: string }[]>('roles.list')
  const role = (n: string) => roles.find((r) => r.name === n)!.id
  const cashier = await s.call<{ id: string }>('users.save', { name: 'Ravi', phone: '9876500041', roleId: role('Cashier'), password: 'Ravi#Pass2026', branchId: s.mainBranch })
  const manager = await s.call<{ id: string }>('users.save', { name: 'Mani', phone: '9876500042', roleId: role('Manager'), password: 'Mani#Pass2026', branchId: s.mainBranch })
  const seller = await s.call<{ id: string }>('users.save', { name: 'Kavi', phone: '9876500043', roleId: '', canLogin: false })
  const anu = await s.call<{ id: string }>('customers.save', { name: 'Anu', phone: '9811100044' })
  const bala = await s.call<{ id: string }>('customers.save', { name: 'Bala', phone: '9811100045' })
  const asCashier = async () => { s.setToken(null); s.setToken((await s.call<{ token: string }>('auth.login', '9876500041', 'Ravi#Pass2026')).token) }
  const asOwner = () => s.setToken(s.ownerToken)
  return { s, tea, rice, cloth, cashier, manager, seller, anu, bala, asCashier, asOwner }
}
const bill = (s: S, productId: string, extra: Record<string, unknown> = {}, pays = [{ method: 'cash', amount: 100 }]) => s.call<O>('orders.checkout', draft([line(productId, 1)], extra), pays)
const creditNote = async (s: S, o: O) => (await s.call<{ number: string }>('returns.create', { orderId: o.id, lines: [{ orderItemId: o.items[0].id, qty: 1, restock: true }], reason: 'other', settle: 'credit_note' })).number

test('L12: a credit note pays only its own customer’s bill', async () => {
  const { s, tea, anu, bala } = await shop()
  try {
    const cn = await creditNote(s, await bill(s, tea.id, { customerId: anu.id }))
    // Bala's bill (or no customer) with Anu's note: refused by the server, nothing billed.
    await assert.rejects(bill(s, tea.id, { customerId: bala.id }, [{ method: 'credit_note', amount: 100, reference: cn }] as never), (e) => code(e) === 'FORBIDDEN')
    await assert.rejects(bill(s, tea.id, {}, [{ method: 'credit_note', amount: 100, reference: cn, confirmed: true }] as never), (e) => code(e) === 'FORBIDDEN', 'confirming doesn’t help: it has an owner')
    // Anu's own bill: fine.
    const ok = await bill(s, tea.id, { customerId: anu.id }, [{ method: 'credit_note', amount: 100, reference: cn }] as never)
    assert.equal(ok.status, 'completed')
  } finally { s.close() }
})

test('L12: a credit note with no customer needs the staff to confirm the slip', async () => {
  const { s, tea, bala } = await shop()
  try {
    const cn = await creditNote(s, await bill(s, tea.id))
    await assert.rejects(bill(s, tea.id, { customerId: bala.id }, [{ method: 'credit_note', amount: 100, reference: cn }] as never), (e) => code(e) === 'CONFIRM_CREDIT_NOTE')
    await assert.rejects(bill(s, tea.id, {}, [{ method: 'credit_note', amount: 100, reference: cn, confirmed: 'yes' }] as never), (e) => code(e) === 'CONFIRM_CREDIT_NOTE', 'only true counts')
    const ok = await bill(s, tea.id, {}, [{ method: 'credit_note', amount: 100, reference: cn, confirmed: true }] as never)
    assert.equal(ok.status, 'completed')
  } finally { s.close() }
})

test('L13: wholesale prices need “Change item price” or a wholesale customer; cashiers can’t make one', async () => {
  const { s, tea, anu, asCashier, asOwner } = await shop()
  try {
    await asCashier()
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1, { priceTier: 'wholesale' })])), (e) => code(e) === 'FORBIDDEN')
    await assert.rejects(s.call('customers.save', { id: anu.id, name: 'Anu', phone: '9811100044', priceTier: 'wholesale' }), (e) => code(e) === 'FORBIDDEN')
    // The owner puts Anu on the wholesale list: then the cashier's bills for Anu get wholesale prices.
    asOwner()
    await s.call('customers.save', { id: anu.id, name: 'Anu', phone: '9811100044', priceTier: 'wholesale' })
    await asCashier()
    const r = await s.call<{ order: O & { total: number } }>('orders.save', draft([line(tea.id, 1, { priceTier: 'wholesale' })], { customerId: anu.id }))
    assert.equal(r.order.total, 80)
    // The cashier may take Anu off the list, and save an unchanged customer.
    await s.call('customers.save', { id: anu.id, name: 'Anu', phone: '9811100044', priceTier: 'retail' })
    // The owner (billing.price) can bill wholesale for anyone.
    asOwner()
    assert.equal((await s.call<{ order: O }>('orders.save', draft([line(tea.id, 1, { priceTier: 'wholesale' })]))).order.total, 80)
  } finally { s.close() }
})

test('L13: salesperson — yourself or a counter salesperson; another app user needs permission', async () => {
  const { s, tea, cashier, manager, seller, asCashier, asOwner } = await shop()
  try {
    await asCashier()
    await s.call('orders.save', draft([line(tea.id, 1)], { salespersonId: cashier.id }))
    await s.call('orders.save', draft([line(tea.id, 1)], { salespersonId: seller.id })) // counter salesperson (no login)
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1)], { salespersonId: manager.id })), (e) => code(e) === 'FORBIDDEN')
    await assert.rejects(s.call('orders.checkout', draft([line(tea.id, 1)], { salespersonId: manager.id }), [{ method: 'cash', amount: 100 }]), (e) => code(e) === 'FORBIDDEN', 'the checkout path too')
    asOwner()
    const r = await s.call<{ order: O }>('orders.save', draft([line(tea.id, 1)], { salespersonId: manager.id }))
    // A running order the owner gave to the manager: the cashier can save it again unchanged.
    await asCashier()
    await s.call('orders.save', draft([line(tea.id, 2)], { id: r.order.id, salespersonId: manager.id }))
  } finally { s.close() }
})

test('L14: bill lines — 500 at most, add-ons as a list, whole pieces, decimals for kg / mtr', async () => {
  const { s, tea, rice, cloth } = await shop()
  try {
    await assert.rejects(s.call('orders.save', draft(Array.from({ length: 501 }, () => line(tea.id, 1)))), /at most 500 items/)
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1, { addOns: 'x' })])), /add-ons/)
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1.5)])), /whole numbers only/i)
    await assert.rejects(s.call('orders.save', draft([line(tea.id, -1)])), /quantity/)
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 'lots' as never)])), /quantity/)
    await s.call('orders.save', draft([line(rice.id, 1.25), line(cloth.id, 2.5)])) // sold in parts: fine
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1)], { discount: -5 })), /negative/)
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1)], { discount: 'abc' })), /Discount/)
  } finally { s.close() }
})

test('L14: payments and money amounts — real numbers, 0 … ₹1 crore, never negative', async () => {
  const { s, tea, anu } = await shop()
  try {
    for (const amount of [-5, 'abc', 1e8, null, { x: 1 }]) await assert.rejects(bill(s, tea.id, {}, [{ method: 'cash', amount }] as never), /Payment/, String(amount))
    await assert.rejects(s.call('expenses.save', { amount: 1e8, category: 'other', date: today() }), /too large/)
    await assert.rejects(s.call('expenses.save', { amount: -1, category: 'other', date: today() }), /negative/)
    const sup = await s.call<{ id: string }>('suppliers.save', { name: 'Arani' })
    await assert.rejects(s.call('suppliers.pay', sup.id, { amount: 1e9, method: 'cash' }), /too large/)
    await assert.rejects(s.call('products.save', { name: 'Bad', price: -1 }), /negative/)
    await assert.rejects(s.call('products.save', { name: 'Bad', price: 1e8 }), /too large/)
    await assert.rejects(s.call('products.save', { name: 'Bad', price: 10, variants: [{ id: 'v1', name: 'L', price: -2 }] }), /Size price/)
    await assert.rejects(s.call('products.save', { name: 'Bad', price: 10, addOns: [{ id: 'a1', name: 'Cheese', price: 1e9 }] }), /Add-on price/)
    await assert.rejects(s.call('customers.collectDue', anu.id, 1e8, 'cash'), /too large/)
    const staff = await s.call<{ id: string }>('users.save', { name: 'Help', phone: '9811100046', roleId: '', canLogin: false })
    await assert.rejects(s.call('staff.setPay', staff.id, { type: 'monthly', amount: -100, commissionPct: 0 }), /negative/)
    await assert.rejects(s.call('staff.giveAdvance', staff.id, { amount: 1e9, method: 'cash' }), /too large/)
  } finally { s.close() }
})

test('L14: the same limits on CSV import, purchases, stock changes and returns', async () => {
  const { s, tea, rice } = await shop()
  try {
    await assert.rejects(s.call('products.importMany', [{ row: 0, name: 'X', price: 1e9 }], { onExisting: 'skip', fileName: 'x.csv' }), /Row 2 price/)
    await assert.rejects(s.call('products.importMany', [{ row: 0, name: 'X', price: 10, stock: 1.5 }], { onExisting: 'skip', fileName: 'x.csv' }), /Row 2 stock/)
    await assert.rejects(s.call('products.importMany', [{ row: 0, name: 'X', price: 10, variants: 'x' }], { onExisting: 'skip', fileName: 'x.csv' }), /sizes and add-ons/)
    await s.call('products.importMany', [{ row: 0, name: 'Dal', price: 120, unit: 'kg', stock: 2.5 }], { onExisting: 'skip', fileName: 'x.csv' })
    const sup = await s.call<{ id: string }>('suppliers.save', { name: 'Arani' })
    await assert.rejects(s.call('purchases.create', { supplierId: sup.id, supplierBillNo: 'A-1', date: today(), lines: [{ productId: tea.id, qty: 1.5, cost: 50, taxRate: 0 }], paid: 0, method: 'cash' }), /whole numbers/i)
    await assert.rejects(s.call('purchases.create', { supplierId: sup.id, supplierBillNo: 'A-2', date: today(), lines: [{ productId: tea.id, qty: 1, cost: -5, taxRate: 0 }], paid: 0, method: 'cash' }), /cost price/)
    await s.call('purchases.create', { supplierId: sup.id, supplierBillNo: 'A-3', date: today(), lines: [{ productId: rice.id, qty: 2.5, cost: 50, taxRate: 0 }], paid: 0, method: 'cash' })
    await assert.rejects(s.call('inventory.adjust', tea.id, 'purchase', 1.5, ''), /whole numbers/i)
    await s.call('inventory.adjust', rice.id, 'purchase', 0.75, '')
    const o = await bill(s, tea.id, {}, [{ method: 'cash', amount: 100 }])
    await assert.rejects(s.call('returns.create', { orderId: o.id, lines: [{ orderItemId: o.items[0].id, qty: 0.5, restock: true }], reason: 'other', settle: 'refund', refundMethod: 'cash' }), /whole numbers/i)
  } finally { s.close() }
})
