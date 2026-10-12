import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

test('customer account: create, sign in, me, settings, setup', async () => {
  const s = await withShop()
  try {
    type Me = { user: { name: string; password: string }; business: { name: string; billing: { taxRates: { id: string; rate: number }[]; defaultTaxRateId: string; nextInvoiceNumber: number; invoicePrefix: string } }; role: { name: string }; permissions: string; branches: { id: string }[]; subscription: { state: string } }
    const me = await s.call<Me>('auth.me')
    assert.equal(me.user.name, 'Lakshmi')
    assert.equal(me.user.password, '')
    assert.equal(me.role.name, 'Owner')
    assert.equal(me.permissions, 'all')
    assert.equal(me.subscription.state, 'active')
    assert.equal(me.business.billing.taxRates.length, 4)
    assert.equal(me.business.billing.invoicePrefix, 'INV-')
    // wrong password → refused; mobile number login works too
    s.setToken(null)
    await assert.rejects(s.call('auth.login', '9876543210', 'bad'), /Wrong/)
    const byPhone = await s.call<{ token: string }>('auth.login', '98765 43210', 'shop1234')
    s.setToken(byPhone.token)

    const upd = await s.call<Me['business']>('business.update', { address: '1 Main Rd', billing: { invoicePrefix: 'TM-', nextInvoiceNumber: 500, roundOff: false } })
    assert.equal(upd.billing.invoicePrefix, 'TM-')
    assert.equal(upd.billing.nextInvoiceNumber, 500)
    // never lowered
    const upd2 = await s.call<Me['business']>('business.update', { billing: { nextInvoiceNumber: 10 } })
    assert.equal(upd2.billing.nextInvoiceNumber, 500)

    const setup = await s.call<{ categoryIds: string[] }>('business.saveSetup', {
      name: 'Test Mart', category: 'retail', subType: 'Supermarket', modules: { billing: true, products: true, inventory: true, tables: false }, terminology: {},
      orderTypes: ['counter'], categories: [{ name: 'Dairy', emoji: '🥛' }, { name: 'Snacks', emoji: '🍪' }, { name: 'dairy', emoji: 'x' }], tables: [],
    })
    assert.equal(setup.categoryIds.filter(Boolean).length, 2)
    const me2 = await s.call<Me & { business: { category: string; subType: string; billing: { taxMode: string } } }>('auth.me')
    assert.equal(me2.business.category, 'retail')
    assert.equal(me2.business.billing.taxMode, 'inclusive')
    assert.equal(me2.business.billing.taxRates.find((t) => t.id === me2.business.billing.defaultTaxRateId)?.rate, 0)

    // staff + roles
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    const cashier = roles.find((r) => r.name === 'Cashier')!
    await assert.rejects(s.call('users.save', { name: 'Ravi', phone: '9876500002', roleId: cashier.id }), /Password/)
    const ravi = await s.call<{ id: string }>('users.save', { name: 'Ravi', phone: '9876500002', roleId: cashier.id, password: 'ravi1234' })
    assert.ok(ravi.id)
    s.setToken(null)
    const r = await s.call<{ token: string }>('auth.login', '9876500002', 'ravi1234')
    s.setToken(r.token)
    await assert.rejects(s.call('business.update', { name: 'Hack' }), /permission/)
    // branch from a header the user may not open is ignored (falls back to their own)
    s.setBranch('99999999999')
    const meR = await s.call<{ branch: { id: string } }>('auth.me')
    assert.equal(meR.branch.id, s.mainBranch)
  } finally { s.close() }
})

test('read-only and deactivated accounts', async () => {
  const s = await withShop()
  try {
    s.setToken(s.adminToken)
    await s.call('admin.setStatus', s.businessId, 'deactivated', 'unpaid')
    s.setToken(s.ownerToken)
    await assert.rejects(s.call('auth.me'), /deactivated/)
    s.setToken(s.adminToken)
    await s.call('admin.setStatus', s.businessId, 'active')
    // expire the subscription directly in the table
    await s.db.update('businesses', s.businessId, { subscription_end_at: new Date(Date.now() - 86400000).toISOString() })
    s.env.kv = s.env.kv // cache is busted by the epoch below
    await s.call('admin.updateCustomer', s.businessId, { adminNote: 'x' })
    s.setToken(s.ownerToken)
    const me = await s.call<{ subscription: { state: string } }>('auth.me')
    assert.equal(me.subscription.state, 'expired')
    await assert.rejects(s.call('business.update', { address: 'x' }), /read-only/)
    await s.call('auth.setLanguage', 'ta') // allowed while read-only
  } finally { s.close() }
})
