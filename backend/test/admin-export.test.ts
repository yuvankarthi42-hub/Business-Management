import '../src/modules/admin/platform'
import '../src/modules/export'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type Flag = { mode: string; businessIds: string[] }
type Me = { features: Record<string, boolean>; support: { adminName: string; reason: string } | null }
type Bundle = { businessName: string; exportedAt: string; tables: { name: string; rows: Record<string, unknown>[] }[]; images: { path: string; url: string }[] }

test('feature releases flip the customer session', async () => {
  const s = await withShop()
  try {
    assert.equal((await s.call<Me>('auth.me')).features.whatsapp, false)
    s.setToken(s.adminToken)
    const list = await s.call<{ key: string; name: string; flag: Flag }[]>('admin.features')
    assert.deepEqual(list.map((f) => [f.key, f.flag.mode]), [['whatsapp', 'off']])
    await assert.rejects(s.call('admin.setFeature', 'nope', { mode: 'all', businessIds: [] }), /Unknown feature/)
    await assert.rejects(s.call('admin.setFeature', 'whatsapp', { mode: 'some', businessIds: [] }), /Choose who/)

    await s.call('admin.setCustomerFeature', s.businessId, 'whatsapp', true)
    let f = (await s.call<{ key: string; flag: Flag }[]>('admin.features'))[0].flag
    assert.deepEqual(f, { mode: 'selected', businessIds: [s.businessId] })
    s.setToken(s.ownerToken)
    assert.equal((await s.call<Me>('auth.me')).features.whatsapp, true)

    s.setToken(s.adminToken)
    // unknown / foreign ids are dropped
    await s.call('admin.setFeature', 'whatsapp', { mode: 'all', businessIds: ['99999', "1' OR 1=1", s.businessId, s.businessId] })
    f = (await s.call<{ flag: Flag }[]>('admin.features'))[0].flag
    assert.deepEqual(f, { mode: 'all', businessIds: [s.businessId] })
    await s.call('admin.setCustomerFeature', s.businessId, 'whatsapp', false)
    f = (await s.call<{ flag: Flag }[]>('admin.features'))[0].flag
    assert.deepEqual(f, { mode: 'selected', businessIds: [] })
    s.setToken(s.ownerToken)
    assert.equal((await s.call<Me>('auth.me')).features.whatsapp, false)
    s.setToken(s.adminToken)
    await assert.rejects(s.call('admin.setCustomerFeature', '123456', 'whatsapp', true), /Customer not found/)
    const customer = await s.call<{ features: Record<string, boolean> }>('admin.customer', s.businessId)
    assert.equal(customer.features.whatsapp, false)
  } finally { s.close() }
})

test('admin team: create, roles, last super, deactivate', async () => {
  const s = await withShop()
  try {
    s.setToken(s.adminToken)
    type A = { id: string; name: string; username: string; role: string; permissions: string[]; active: boolean; lastLoginAt: string | null }
    let team = await s.call<A[]>('admin.team')
    assert.equal(team.length, 1)
    const me = team[0]
    assert.equal(me.role, 'super')
    assert.ok(!('password_hash' in me) && !('password' in me))

    await assert.rejects(s.call('admin.saveAdmin', { name: 'M', username: 'lakshmi', role: 'manager', password: 'mgr12345' }), /already taken/)
    await assert.rejects(s.call('admin.saveAdmin', { name: 'M', username: 'admin1', role: 'manager', password: 'mgr12345' }), /already taken/)
    await assert.rejects(s.call('admin.saveAdmin', { name: 'M', username: 'mgr1', role: 'boss', password: 'mgr12345' }), /Choose a role/)
    await assert.rejects(s.call('admin.saveAdmin', { name: 'M', username: 'mgr1', role: 'manager', password: '123' }), /at least 6/)
    const mgr = await s.call<A>('admin.saveAdmin', { name: 'Meena', username: 'Mgr1', role: 'manager', password: 'mgr12345' })
    assert.equal(mgr.username, 'mgr1')
    assert.equal(mgr.role, 'manager')

    // the manager can sign in but not manage the team
    s.setToken(null)
    const { token: mgrToken } = await s.call<{ token: string }>('admin.login', 'mgr1', 'mgr12345')
    s.setToken(mgrToken)
    await assert.rejects(s.call('admin.team'), /can’t do this/)
    await assert.rejects(s.call('admin.updateSettings', { pricePerBranchMonth: 1 }), /can’t do this/)

    s.setToken(s.adminToken)
    // only super: can't demote yourself (last super), can't change own role
    await assert.rejects(s.call('admin.saveAdmin', { id: me.id, name: 'Admin', username: 'admin1', role: 'manager' }), /at least one active super/)
    await s.call('admin.saveAdmin', { name: 'Second', username: 'super2', role: 'super', password: 'super2pw' })
    await assert.rejects(s.call('admin.saveAdmin', { id: me.id, name: 'Admin', username: 'admin1', role: 'manager' }), /own role/)
    await assert.rejects(s.call('admin.setAdminActive', me.id, false), /deactivate yourself/)
    await assert.rejects(s.call('admin.saveAdmin', { id: '987654', name: 'X', username: 'xxxx', role: 'manager' }), /Admin not found/)

    // role change takes effect on the manager's next request
    const changed = await s.call<A>('admin.saveAdmin', { id: mgr.id, name: 'Meena S', username: 'mgr1', role: 'support' })
    assert.equal(changed.role, 'support')
    s.setToken(mgrToken)
    assert.equal((await s.call<{ role: string }>('admin.me')).role, 'support')
    await assert.rejects(s.call('admin.setFeature', 'whatsapp', { mode: 'all', businessIds: [] }), /can’t do this/)

    // deactivating ends the token
    s.setToken(s.adminToken)
    await s.call('admin.setAdminActive', mgr.id, false)
    s.setToken(mgrToken)
    await assert.rejects(s.call('admin.me'), /sign-in required/)
    s.setToken(null)
    await assert.rejects(s.call('admin.login', 'mgr1', 'mgr12345'), /Wrong admin/)
    s.setToken(s.adminToken)
    await s.call('admin.setAdminActive', mgr.id, true)
    s.setToken(mgrToken)
    await assert.rejects(s.call('admin.me'), /sign-in required/) // the old token stays dead
    s.setToken(null)
    const again = await s.call<{ token: string }>('admin.login', 'mgr1', 'mgr12345')
    s.setToken(again.token)
    assert.equal((await s.call<{ name: string }>('admin.me')).name, 'Meena S')

    // password reset signs out
    s.setToken(s.adminToken)
    await s.call('admin.saveAdmin', { id: mgr.id, name: 'Meena S', username: 'mgr1', role: 'support', password: 'newpass99' })
    s.setToken(again.token)
    await assert.rejects(s.call('admin.me'), /sign-in required/)

    s.setToken(s.adminToken)
    team = await s.call<A[]>('admin.team')
    assert.equal(team.length, 3)
    assert.ok(team.find((a) => a.username === 'admin1')!.lastLoginAt)
  } finally { s.close() }
})

test('support view: read-only customer token, end logs minutes', async () => {
  const s = await withShop()
  try {
    s.setToken(s.adminToken)
    await assert.rejects(s.call('admin.startSupport', s.businessId, 'no'), /Write why/)
    await assert.rejects(s.call('admin.startSupport', '424242', 'printer issue'), /Customer not found/)
    const sup = await s.call<{ onboarded: boolean; token: string; branchId: string }>('admin.startSupport', s.businessId, 'Bill not printing')
    assert.equal(sup.onboarded, false)
    assert.equal(sup.branchId, s.mainBranch)
    // it is a customer token, not an admin one
    s.setToken(sup.token)
    await assert.rejects(s.call('admin.customers'), /sign-in required/)
    const me = await s.call<Me>('auth.me')
    assert.equal(me.support?.adminName, 'Admin')
    assert.equal(me.support?.reason, 'Bill not printing')
    await assert.rejects(s.call('business.update', { address: 'x' }), /read-only/)
    await assert.rejects(s.call('dataExport.mine'), /read-only/)
    assert.equal(await s.call('admin.endSupport'), s.businessId)
    // the owner's own token: nothing to end
    s.setToken(s.ownerToken)
    assert.equal(await s.call('admin.endSupport'), null)
    s.setToken(s.adminToken)
    const log = await s.call<{ action: string; detail: string; businessName: string }[]>('admin.audit')
    assert.match(log.find((x) => x.action === 'support_end')!.detail, /closed after 1 min/)
    assert.equal(log.find((x) => x.action === 'support_start')!.businessName, 'Test Mart')
    assert.ok(log.findIndex((x) => x.action === 'support_end') < log.findIndex((x) => x.action === 'support_start'))
  } finally { s.close() }
})

test('usage report, settings, audit, export', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 20, unit: 'pc', trackStock: true, stock: 50 })
    const draft = (qty: number) => ({ type: 'counter', tableId: null, customerId: null, discount: 0, notes: '', source: 'pos', items: [{ id: `t${qty}`, productId: tea.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 }] })
    await s.call('orders.checkout', draft(2), [{ method: 'cash', amount: 40 }])
    await s.call('orders.checkout', draft(3), [{ method: 'upi', amount: 60 }])
    // a stored product photo
    const media = await s.db.insert('media_files', { business_id: s.businessId, purpose: 1, bucket: 'products', object_key: `${s.businessId}/products/tea.webp`, content_type: 'image/webp', bytes: 1000 })
    await s.db.update('products', tea.id, { image_media_id: media.ROWID })

    s.setToken(s.adminToken)
    type U = { rows: { id: string; bills7: number; bills30: number; sales30: number; lastBillAt: string | null; lastLoginAt: string | null; branches: number; monthlyPrice: number; state: string }[]; months: { key: string; amount: number; customers: number }[]; summary: Record<string, number> }
    const u = await s.call<U>('admin.usage')
    const row = u.rows.find((r) => r.id === s.businessId)!
    assert.equal(row.bills7, 2)
    assert.equal(row.bills30, 2)
    assert.equal(row.sales30, 100)
    assert.ok(row.lastBillAt && row.lastLoginAt)
    assert.equal(row.branches, 1)
    assert.equal(row.monthlyPrice, 3 * 499)
    assert.equal(row.state, 'active')
    assert.equal(u.months.length, 12)
    assert.equal(u.months[11].customers, 1)
    assert.ok(u.months[11].amount > 0)
    assert.equal(u.summary.customers, 1)
    assert.equal(u.summary.billing7, 1)
    assert.equal(u.summary.inactive14, 0)
    assert.equal(u.summary.logins7, 1)
    assert.equal(u.summary.mrr, 3 * 499)
    assert.equal(u.summary.thisMonth, u.summary.last12)

    // settings
    assert.equal((await s.call<{ pricePerBranchMonth: number }>('admin.settings')).pricePerBranchMonth, 499)
    await assert.rejects(s.call('admin.updateSettings', { pricePerBranchMonth: -1 }), /valid price/)
    await assert.rejects(s.call('admin.updateSettings', { pricePerBranchMonth: '5' }), /valid price/)
    const set = await s.call<{ pricePerBranchMonth: number; features: Record<string, Flag> }>('admin.updateSettings', { pricePerBranchMonth: 599.4 })
    assert.equal(set.pricePerBranchMonth, 599)
    assert.equal((await s.call<U>('admin.usage')).summary.mrr, 3 * 599)

    // export (admin)
    const bundle = await s.call<Bundle>('admin.exportCustomer', s.businessId)
    assert.equal(bundle.businessName, 'Test Mart')
    const t = (b: Bundle, n: string) => b.tables.find((x) => x.name === n)!
    assert.deepEqual(bundle.tables.map((x) => x.name), ['Business', 'Branches', 'Staff', 'Categories', 'Products', 'Customers', 'Bills', 'Bill items', 'Payments', 'Returns', 'Expenses', 'Stock movements', 'Stock batches', 'Attendance', 'Salary', 'Advances', 'Tables', 'WhatsApp messages', 'Audit log', 'Subscription'])
    assert.equal(t(bundle, 'Bills').rows.length, 2)
    assert.equal(t(bundle, 'Bills').rows[0].Total, 40)
    assert.equal(t(bundle, 'Bills').rows[0]['Made by'], 'Lakshmi')
    assert.equal(t(bundle, 'Bill items').rows.length, 2)
    assert.equal(t(bundle, 'Payments').rows.length, 2)
    assert.equal(t(bundle, 'Staff').rows[0].Username, 'lakshmi')
    assert.equal(t(bundle, 'Staff').rows[0].Role, 'Owner')
    const p = t(bundle, 'Products').rows[0]
    assert.equal(p.Stock, 45)
    assert.equal(p.Photo, `images/${tea.id}.webp`)
    assert.deepEqual(bundle.images, [{ path: `images/${tea.id}.webp`, url: `/uploads/${s.businessId}/products/tea.webp` }])
    assert.equal(t(bundle, 'Stock movements').rows.length, 3)
    assert.equal(t(bundle, 'Subscription').rows[0].Months, 12)
    assert.equal(t(bundle, 'Business').rows[0]['Branch limit'], 3)
    const text = JSON.stringify(bundle)
    for (const bad of ['password', 'hash', '$2a$', '$2b$', 'shop1234', 'token']) assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `export contains ${bad}`)
    assert.ok(!text.includes('dataUrl'))
    await assert.rejects(s.call('admin.exportCustomer', '55555'), /Customer not found/)

    // the owner's own export: no subscription sheet, logged in the shop's audit log
    s.setToken(s.ownerToken)
    const mine = await s.call<Bundle>('dataExport.mine')
    assert.ok(!mine.tables.some((x) => x.name === 'Subscription'))
    assert.equal(t(mine, 'Bills').rows.length, 2)
    assert.ok(!JSON.stringify(mine).includes('$2'))
    const mine2 = await s.call<Bundle>('dataExport.mine')
    assert.ok(t(mine2, 'Audit log').rows.some((r) => r.Action === 'export'))

    // staff without settings.manage can't export
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Ravi', phone: '9876500002', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    s.setToken(null)
    s.setToken((await s.call<{ token: string }>('auth.login', '9876500002', 'ravi1234')).token)
    await assert.rejects(s.call('dataExport.mine'), /permission/)

    // admin audit: newest first, with the actions above
    s.setToken(s.adminToken)
    const log = await s.call<{ action: string; detail: string }[]>('admin.audit', 500)
    assert.equal(log[0].action, 'export')
    assert.match(log[0].detail, /Exported \d+ rows, 1 photos/)
    assert.ok(log.some((x) => x.action === 'settings' && x.detail === 'Price per branch / month 499 → 599'))
    assert.equal((await s.call<unknown[]>('admin.audit', 1)).length, 1)
  } finally { s.close() }
})
