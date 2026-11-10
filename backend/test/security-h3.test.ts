// H3: "Manage staff & roles" can't be used to take over the shop — enforced on the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type Role = { id: string; name: string; permissions: string[] }
type User = { id: string; name: string; roleId: string; username?: string; branchIds?: string[] }
const forbidden = (re: RegExp) => (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN' && re.test((e as Error).message)

async function setup() {
  const s = await withShop()
  const town = await s.call<{ id: string }>('branches.save', { name: 'Town' })
  const roles = await s.call<Role[]>('roles.list')
  const ownerRole = roles.find((r) => r.permissions.includes('*'))!
  const cashier = roles.find((r) => r.name === 'Cashier')!
  // A staff manager (no Business settings), working only in the main branch.
  const mgrRole = await s.call<Role>('roles.save', { name: 'Staff manager', permissions: ['users.manage', 'billing.create', 'orders.view'] })
  const settingsRole = await s.call<Role>('roles.save', { name: 'Office', permissions: ['settings.manage', 'billing.create'] })
  const mgr = await s.call<User>('users.save', { name: 'Mani', phone: '9876500021', roleId: mgrRole.id, password: 'Manager#2026', branchIds: [s.mainBranch] })
  const townStaff = await s.call<User>('users.save', { name: 'Raju', phone: '9876500022', roleId: cashier.id, password: 'Cashier#2026', branchIds: [town.id] })
  const owner = (await s.call<User[]>('users.list')).find((u) => u.username)!
  const asMgr = async () => { s.setToken(null); s.setToken((await s.call<{ token: string }>('auth.login', '9876500021', 'Manager#2026')).token) }
  return { s, town, ownerRole, cashier, mgrRole, settingsRole, mgr, townStaff, owner, asMgr }
}

test('Owner account and Owner role: only the owner', async () => {
  const { s, ownerRole, cashier, owner, asMgr } = await setup()
  try {
    await asMgr()
    await assert.rejects(s.call('users.save', { id: owner.id, name: owner.name, phone: '9876543210', roleId: owner.roleId, password: 'Takeover#2026' }), forbidden(/Only the owner can change the owner/))
    await assert.rejects(s.call('users.save', { id: owner.id, name: 'X', phone: '9876543210', roleId: cashier.id }), forbidden(/Only the owner/))
    await assert.rejects(s.call('users.save', { name: 'Boss', phone: '9876500023', roleId: ownerRole.id, password: 'Boss#20260', branchIds: [s.mainBranch] }), forbidden(/full \(Owner\) access/))
    await assert.rejects(s.call('roles.save', { id: ownerRole.id, name: 'Owner', permissions: [] }), forbidden(/Owner role/))
  } finally { s.close() }
})

test('Permission delegation: nobody gives access they don’t have; no changing your own role', async () => {
  const { s, settingsRole, cashier, mgr, mgrRole, asMgr } = await setup()
  try {
    await asMgr()
    // A role with Business settings (the manager doesn't have it): can't be given or created.
    await assert.rejects(s.call('users.save', { name: 'Office', phone: '9876500024', roleId: settingsRole.id, password: 'Office#2026', branchIds: [s.mainBranch] }), forbidden(/Business settings/))
    await assert.rejects(s.call('roles.save', { name: 'Sneaky', permissions: ['billing.create', 'settings.manage'] }), forbidden(/don’t have yourself/))
    // Their own role: no new permissions; no switching roles.
    await assert.rejects(s.call('roles.save', { id: mgrRole.id, name: 'Staff manager', permissions: ['users.manage', 'billing.create', 'orders.view', 'reports.view'] }), forbidden(/./))
    await assert.rejects(s.call('users.save', { id: mgr.id, name: 'Mani', phone: '9876500021', roleId: cashier.id, branchIds: [s.mainBranch] }), forbidden(/own role/))
    // Within their own access it works.
    const r = await s.call<Role>('roles.save', { name: 'Billing only', permissions: ['billing.create'] })
    await s.call('users.save', { name: 'Kavi', phone: '9876500025', roleId: r.id, password: 'Kavi#20260', branchIds: [s.mainBranch] })
  } finally { s.close() }
})

test('Branch access: only to the manager’s own branches; staff of other branches are off limits', async () => {
  const { s, town, townStaff, asMgr } = await setup()
  try {
    // A role inside the manager's own access, so only the branch rule decides here.
    const cashier = await s.call<Role>('roles.save', { name: 'Billing only', permissions: ['billing.create'] })
    await s.call('users.save', { id: townStaff.id, name: 'Raju', phone: '9876500022', roleId: cashier.id, branchIds: [town.id] })
    await asMgr()
    await assert.rejects(s.call('users.save', { name: 'Arun', phone: '9876500026', roleId: cashier.id, password: 'Arun#20260', branchIds: [town.id] }), forbidden(/branches you work in/))
    await assert.rejects(s.call('users.save', { name: 'Arun', phone: '9876500026', roleId: cashier.id, password: 'Arun#20260', branchIds: [s.mainBranch, town.id] }), forbidden(/branches you work in/))
    await assert.rejects(s.call('users.save', { id: townStaff.id, name: 'Raju', phone: '9876500022', roleId: cashier.id, password: 'Changed#2026' }), forbidden(/branch you don’t manage/))
    await s.call('users.save', { name: 'Arun', phone: '9876500026', roleId: cashier.id, password: 'Arun#20260', branchIds: [s.mainBranch] })
  } finally { s.close() }
})

test('The owner (all access) can still do everything', async () => {
  const { s, town, ownerRole, settingsRole, mgr, mgrRole, townStaff, cashier } = await setup()
  try {
    s.setToken(s.ownerToken)
    await s.call('users.save', { name: 'Partner', phone: '9876500027', roleId: ownerRole.id, password: 'Partner#2026', branchIds: [s.mainBranch, town.id] })
    await s.call('users.save', { id: mgr.id, name: 'Mani', phone: '9876500021', roleId: settingsRole.id, branchIds: [s.mainBranch, town.id] })
    await s.call('roles.save', { id: mgrRole.id, name: 'Staff manager', permissions: ['users.manage', 'settings.manage'] })
    await s.call('users.save', { id: townStaff.id, name: 'Raju K', phone: '9876500022', roleId: cashier.id, branchIds: [town.id] })
  } finally { s.close() }
})
