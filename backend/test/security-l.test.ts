// Low fixes, step 1: L1 (repeat lookups stay in the shop), L5 (no development secret outside dev / tests),
// L6 (setup / cron keys), L15 (checked discount in totals), L16 (import tax rates must be the shop's own).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { devSecretsAllowed } from '../src/core/tokens'

test('L5: the development secrets only when NODE_ENV is unset, development or test', () => {
  for (const v of [undefined, 'development', 'test']) assert.equal(devSecretsAllowed({ NODE_ENV: v } as NodeJS.ProcessEnv), true, String(v))
  for (const v of ['production', 'staging', 'prod', 'uat']) assert.equal(devSecretsAllowed({ NODE_ENV: v } as NodeJS.ProcessEnv), false, v)
})

test('L6: setup and cron keys — wrong, short or missing keys are refused', async () => {
  const s = await withShop()
  const before = process.env.CRON_KEY
  try {
    s.setToken(null)
    await assert.rejects(s.call('admin.setup', 'wrong-key-wrong-key', { name: 'X', username: 'xadmin', password: 'Admin#2026x' }), /not allowed/)
    process.env.CRON_KEY = 'short-key'
    await assert.rejects(s.call('system.runDailyJobs', 'short-key'), /Not allowed/, 'a key under 32 characters never works')
    delete process.env.CRON_KEY
    await assert.rejects(s.call('system.runDailyJobs', ''), /Not allowed/)
    process.env.CRON_KEY = 'k'.repeat(40)
    await assert.rejects(s.call('system.runDailyJobs', 'k'.repeat(39)), /Not allowed/)
  } finally { if (before === undefined) delete process.env.CRON_KEY; else process.env.CRON_KEY = before; s.close() }
})

test('L15: a discount sent as text is used as its number (totals never go wrong)', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 100 })
    const line = { id: 'tmp_1', productId: tea.id, name: 'x', variantId: null, variantName: null, addOns: [], qty: 1, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '' }
    const r = await s.call<{ order: { total: number; discount: number } }>('orders.save', { type: 'counter', tableId: null, customerId: null, items: [line], discount: '10', notes: '', source: 'pos' })
    assert.equal(r.order.discount, 10)
    assert.equal(r.order.total, 90)
  } finally { s.close() }
})

test('L16: CSV import only takes the shop’s own tax rates', async () => {
  const s = await withShop()
  try {
    await assert.rejects(s.call('products.importMany', [{ row: 0, name: 'Soap', price: 40, taxRateId: '999999' }], { onExisting: 'skip', fileName: 'x.csv' }), /Row 2: choose one of your tax rates/)
    const rates = (await s.call<{ business: { billing: { taxRates: { id: string }[] } } }>('auth.me')).business.billing.taxRates
    await s.call('products.importMany', [{ row: 0, name: 'Soap', price: 40, taxRateId: rates[0].id }], { onExisting: 'skip', fileName: 'x.csv' })
  } finally { s.close() }
})

test('L1: a repeated request id never returns another shop’s record', async () => {
  const s = await withShop()
  try {
    // Shop A pays a supplier with request id X.
    const supA = await s.call<{ id: string }>('suppliers.save', { name: 'Arani Weavers' })
    s.setRequestId('shared-request-id-0001')
    const payA = await s.call<{ id: string; amount: number }>('suppliers.pay', supA.id, { amount: 2500, method: 'upi', reference: 'A' })
    s.setRequestId(null)
    // Shop B (another customer) sends the same request id.
    s.setToken(s.adminToken)
    const b = await s.call<{ id: string }>('admin.createCustomer', { businessName: 'Other Shop', ownerName: 'Ravi', username: 'othershop', password: 'Other#Shop2026', phone: '9876500099', validity: { months: 12 }, maxBranches: 1 })
    s.setToken(null)
    s.useShop(b.id)
    s.setToken((await s.call<{ token: string }>('auth.login', 'othershop', 'Other#Shop2026')).token)
    const supB = await s.call<{ id: string }>('suppliers.save', { name: 'Local Supplier' })
    s.setRequestId('shared-request-id-0001')
    let payB: { id: string; amount: number } | null = null
    try { payB = await s.call('suppliers.pay', supB.id, { amount: 99, method: 'cash', reference: 'B' }) } catch { /* one database for all shops: refused as a duplicate — fine */ }
    s.setRequestId(null)
    if (payB) {
      assert.equal(payB.amount, 99, 'shop B gets its own payment')
      assert.notDeepEqual({ id: payB.id, amount: payB.amount }, { id: payA.id, amount: payA.amount })
    }
  } finally { s.close() }
})
