// Low fixes, step 3: L2 (branch limits), L3 (support view needs a still-valid admin), L7 (no account-existence
// leaks), L10 (admin ticket permission and logging). Rules are tried straight against the API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

const code = (e: unknown) => (e as { code?: string }).code
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

async function twoBranches() {
  const s = await withShop()
  try { return await setup(s) } catch (e) { s.close(); throw e }
}
async function setup(s: Awaited<ReturnType<typeof withShop>>) {
  await s.call('business.update', { modules: { billing: true, products: true, orders: true, tables: true, inventory: true, expenses: true, staff: true, customers: true, reports: true } })
  const town = await s.call<{ id: string }>('branches.save', { name: 'Town' })
  // A manager who works in the main branch only, with these areas' permissions.
  const role = await s.call<{ id: string }>('roles.save', { name: 'Branch manager', permissions: ['inventory.manage', 'expenses.manage', 'users.manage', 'tables.manage', 'billing.create', 'customers.manage', 'settings.manage', 'reports.view', 'orders.view'] })
  await s.call('users.save', { name: 'Mani', phone: '9876500051', roleId: role.id, password: 'Mani#Pass2026', branchIds: [s.mainBranch] })
  // Town branch data, made by the owner.
  s.setBranch(town.id)
  const sup = await s.call<{ id: string }>('suppliers.save', { name: 'Arani' })
  const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 20 })
  const purchase = await s.call<{ id: string }>('purchases.create', { supplierId: sup.id, supplierBillNo: 'T-1', date: today(), lines: [{ productId: tea.id, qty: 5, cost: 10, taxRate: 0 }], paid: 0, method: 'cash' })
  const expense = await s.call<{ id: string }>('expenses.save', { amount: 50, category: 'other' })
  const table = await s.call<{ id: string }>('tables.save', { label: 'T9', floor: 'Main', seats: 2 })
  s.setBranch(null)
  const townStaff = await s.call<{ id: string }>('users.save', { name: 'Raju', phone: '9876500052', roleId: '', canLogin: false, branchId: town.id, branchIds: [town.id] })
  const asManager = async () => { s.setToken(null); s.setToken((await s.call<{ token: string }>('auth.login', '9876500051', 'Mani#Pass2026')).token) }
  return { s, town, sup, tea, purchase, expense, table, townStaff, asManager }
}

test('L2: a branch-limited manager can’t reach another branch’s purchases, expenses, tables or staff', async () => {
  const { s, sup, purchase, expense, table, townStaff, asManager } = await twoBranches()
  try {
    await asManager()
    const notFound = (e: unknown) => code(e) === 'NOT_FOUND'
    await assert.rejects(s.call('purchases.get', purchase.id), notFound)
    await assert.rejects(s.call('purchases.void', purchase.id, 'wrong bill'), notFound)
    await assert.rejects(s.call('expenses.void', expense.id), notFound)
    await assert.rejects(s.call('tables.remove', table.id), notFound)
    await assert.rejects(s.call('tables.unmerge', table.id), notFound)
    await assert.rejects(s.call('staff.setPay', townStaff.id, { type: 'monthly', amount: 9000, commissionPct: 0 }), notFound)
    await assert.rejects(s.call('staff.giveAdvance', townStaff.id, { amount: 500, method: 'cash' }), notFound)
    // The supplier is shared; the ledger shows only this manager's branches.
    const ledger = await s.call<{ purchases: unknown[] }>('suppliers.ledger', sup.id)
    assert.equal(ledger.purchases.length, 0)
  } finally { s.close() }
})

test('L2: GST report and data download need every branch; only the owner changes branches', async () => {
  const { s, town, asManager } = await twoBranches()
  try {
    await asManager()
    await assert.rejects(s.call('reports.gst', today().slice(0, 7)), (e) => code(e) === 'FORBIDDEN')
    await assert.rejects(s.call('dataExport.mine'), (e) => code(e) === 'FORBIDDEN')
    await assert.rejects(s.call('branches.save', { id: town.id, name: 'Renamed' }), (e) => code(e) === 'FORBIDDEN')
    // The owner: unchanged.
    s.setToken(s.ownerToken)
    await s.call('reports.gst', today().slice(0, 7))
    await s.call('dataExport.mine')
    await s.call('branches.save', { id: town.id, name: 'Town' })
  } finally { s.close() }
})

test('L3: a support view ends when its admin is turned off', async () => {
  const s = await withShop()
  try {
    s.setToken(s.adminToken)
    await s.call('admin.saveAdmin', { name: 'Supa', username: 'supa1', role: 'support', password: 'Support#2026' })
    s.setToken(null)
    s.setToken((await s.call<{ token: string }>('admin.login', 'supa1', 'Support#2026')).token)
    const view = await s.call<{ token: string }>('admin.startSupport', s.businessId, 'Bill not printing')
    s.setToken(view.token)
    await s.call('auth.me') // works while the admin is active
    s.setToken(s.adminToken)
    const supa = (await s.call<{ id: string; username: string }[]>('admin.team')).find((a) => a.username === 'supa1')!
    await s.call('admin.setAdminActive', supa.id, false)
    s.setToken(view.token)
    await assert.rejects(s.call('auth.me'), (e) => code(e) === 'UNAUTHORIZED')
  } finally { s.close() }
})

test('L7: a locked account answers exactly like a wrong password; a number used in another shop gets a general message', async () => {
  const s = await withShop()
  try {
    s.setToken(null)
    let wrong: { code?: string; message?: string } = {}
    try { await s.call('auth.login', 'lakshmi', 'wrong-pass') } catch (e) { wrong = e as typeof wrong }
    const owner = await s.db.first('users', { username: 'lakshmi' })
    await s.db.update('users', owner!.ROWID, { locked_until: new Date(Date.now() + 600_000).toISOString() })
    let locked: { code?: string; message?: string } = {}
    try { await s.call('auth.login', 'lakshmi', 'shop1234') } catch (e) { locked = e as typeof locked }
    assert.equal(locked.code, wrong.code)
    assert.equal(locked.message, wrong.message)
    // Another shop tries to add a staff member with this shop's owner's mobile number.
    s.setToken(s.adminToken)
    const b = await s.call<{ id: string }>('admin.createCustomer', { businessName: 'Other Shop', ownerName: 'Ravi', username: 'othershop', password: 'Other#Shop2026', phone: '9876500099', validity: { months: 12 }, maxBranches: 1 })
    s.setToken(null); s.useShop(b.id)
    s.setToken((await s.call<{ token: string }>('auth.login', 'othershop', 'Other#Shop2026')).token)
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await assert.rejects(s.call('users.save', { name: 'X', phone: '9876543210', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'Xavier#2026' }), (e) => /can’t be used for a login/.test((e as Error).message) && !/another account/.test((e as Error).message))
  } finally { s.close() }
})

test('L10: ticket changes, feature releases and reminder runs are in the admin log; the log needs the right role', async () => {
  const s = await withShop()
  try {
    s.setToken(s.adminToken)
    await s.call('admin.setCustomerFeature', s.businessId, 'singleDevice', true)
    await s.call('admin.setFeature', 'gstReport', { mode: 'all', businessIds: [] })
    const log = await s.call<{ action: string; detail: string }[]>('admin.audit')
    assert.ok(log.some((x) => x.action === 'feature' && /singleDevice on/.test(x.detail)))
    assert.ok(log.some((x) => x.action === 'feature' && /gstReport: all/.test(x.detail)))
  } finally { s.close() }
})
