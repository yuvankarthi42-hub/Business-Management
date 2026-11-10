// F-5: reads of customers, bills, returns, staff, roles and stock need a permission that uses them — kitchen staff
// can't read customer data or bills; cashiers and waiters keep everything their screens use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

const code = (e: unknown) => (e as { code?: string }).code
const line = (p: { id: string }) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty: 1, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })

async function setup() {
  const s = await withShop()
  await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, orders: true, tables: true, kitchen: true, inventory: true, customers: true } })
  const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 20 })
  const cu = await s.call<{ id: string }>('customers.save', { name: 'Anu', phone: '9811100001' })
  const o = await s.call<{ id: string }>('orders.checkout', { type: 'counter', tableId: null, customerId: cu.id, items: [line(tea)], discount: 0, notes: '', source: 'pos' }, [{ method: 'cash', amount: 20 }])
  const roles = await s.call<{ id: string; name: string }[]>('roles.list')
  const as = async (role: string, phone: string) => {
    await s.call('users.save', { name: role, phone, roleId: roles.find((r) => r.name === role)!.id, password: `${role.replace(/\s/g, '')}#2026x`, branchIds: [s.mainBranch] })
    return async () => { s.setToken(null); s.setToken((await s.call<{ token: string }>('auth.login', phone, `${role.replace(/\s/g, '')}#2026x`)).token) }
  }
  return { s, tea, cu, o, kitchen: await as('Kitchen Staff', '9876500071'), cashier: await as('Cashier', '9876500072'), waiter: await as('Waiter', '9876500073') }
}
const today = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })

test('F-5: kitchen staff can’t read customers, bills, returns, staff, roles or stock — the kitchen board still works', async () => {
  const { s, cu, o, kitchen } = await setup()
  try {
    await kitchen()
    const calls: [string, ...unknown[]][] = [
      ['customers.list'], ['customers.one', cu.id], ['customers.history', cu.id], ['customers.points', cu.id],
      ['orders.list', {}], ['orders.page', today()], ['orders.running'], ['orders.get', o.id],
      ['returns.list'], ['returns.forOrder', o.id], ['users.list'], ['roles.list'], ['inventory.movements'], ['inventory.batches'],
    ]
    for (const [name, ...args] of calls) await assert.rejects(s.call(name, ...args), (e) => code(e) === 'FORBIDDEN', name)
    await s.call('kitchen.list')
  } finally { s.close() }
})

test('F-5: cashier and waiter keep their screens; staff phones and logins only for those who manage staff', async () => {
  const { s, cu, o, cashier, waiter } = await setup()
  try {
    await cashier()
    for (const [name, ...args] of [['customers.list'], ['customers.one', cu.id], ['customers.history', cu.id], ['customers.points', cu.id], ['orders.list', {}], ['orders.page', today()], ['orders.running'], ['orders.get', o.id], ['returns.forOrder', o.id], ['users.list']] as [string, ...unknown[]][])
      await s.call(name, ...args)
    const staff = await s.call<{ name: string; phone: string; email: string; username?: string }[]>('users.list')
    assert.ok(staff.length >= 4 && staff.every((u) => u.name && u.phone === '' && u.email === '' && !u.username), 'names only for a cashier')
    await waiter()
    for (const [name, ...args] of [['customers.list'], ['customers.history', cu.id], ['orders.page', today()], ['orders.running'], ['orders.get', o.id], ['users.list']] as [string, ...unknown[]][])
      await s.call(name, ...args)
    // The owner: unchanged, full staff details.
    s.setToken(s.ownerToken)
    const full = await s.call<{ phone: string }[]>('users.list')
    assert.ok(full.some((u) => u.phone), 'owner sees phone numbers')
    await s.call('roles.list'); await s.call('inventory.movements'); await s.call('inventory.batches')
  } finally { s.close() }
})
