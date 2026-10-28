import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers'
import { DEFAULT_PLANS, monthlyValue, planAmount, planKeyFor, plansFrom, priceFor } from '../../src/core/plans'

test('price rules: a year at the yearly price, extra branches 10 × a month, months and days at the monthly price', () => {
  const t = DEFAULT_PLANS.textile // ₹999 / ₹9,999 / ₹599
  assert.equal(planAmount(t, 1, 1, '', ''), 999)
  assert.equal(planAmount(t, 1, 12, '', ''), 9999)
  assert.equal(planAmount(t, 2, 1, '', ''), 999 + 599)
  assert.equal(planAmount(t, 2, 12, '', ''), 9999 + 599 * 10)
  assert.equal(planAmount(t, 1, 24, '', ''), 2 * 9999)
  assert.equal(planAmount(t, 1, 14, '', ''), 9999 + 2 * 999)
  assert.equal(planAmount(t, 1, null, '2026-01-01T00:00:00Z', '2026-01-16T00:00:00Z'), Math.round(999 / 2), 'half a month')
  assert.equal(monthlyValue(DEFAULT_PLANS.restaurant, 3), 799 + 2 * 499)
  // Which list a shop is on: textile shops are stored as retail.
  assert.equal(planKeyFor({ category: 'retail', subType: 'Silk & Sarees' }), 'textile')
  assert.equal(planKeyFor({ category: 'retail', subType: 'Supermarket' }), 'retail')
  assert.equal(planKeyFor({ category: 'food', subType: 'Bakery' }), 'food')
  assert.equal(planKeyFor({ category: 'restaurant', subType: 'Hotel' }), 'restaurant')
  // Saved lists: bad or missing entries fall back to the defaults; own price wins only for that customer.
  const plans = plansFrom({ food: { month: 299, year: 2999, extraBranch: 199 }, textile: { month: -1 } })
  assert.deepEqual(plans.food, { month: 299, year: 2999, extraBranch: 199 })
  assert.deepEqual(plans.textile, DEFAULT_PLANS.textile)
  const own = { '7': { month: 100, year: 1000, extraBranch: 50 } }
  assert.equal(priceFor(plans, own, { id: '7', category: 'food', subType: '' }).price.month, 100)
  assert.equal(priceFor(plans, own, { id: '8', category: 'food', subType: '' }).price.month, 299)
})

test('admin: prices by business type; a customer’s own price is only for them, from their next payment', async () => {
  const s = await startServer()
  try {
    await s.call('admin.setup', 'test-setup-key-1234567890', { name: 'Admin', username: 'admin1', password: 'secret123' })
    s.setToken((await s.call<{ token: string }>('admin.login', 'admin1', 'secret123')).token)
    type Period = { amount: number; months: number | null; branches: number; pricePerBranch: number }
    type Cust = { plan: string; price: { month: number; year: number; extraBranch: number }; customPrice: boolean; monthlyPrice: number; periods: Period[] }
    const make = (name: string, user: string, phone: string, plan?: string) => s.call<{ id: string }>('admin.createCustomer', { businessName: name, ownerName: 'Owner', username: user, password: 'shop1234', phone, validity: { months: 12 }, maxBranches: 2, ...(plan ? { plan } : {}) })
    const silk = await make('Silk House', 'silkhouse', '9876500011', 'textile')
    const cafe = await make('Tea Point', 'teapoint', '9876500012') // no plan: fast food, as before

    let a = await s.call<Cust>('admin.customer', silk.id)
    assert.equal(a.plan, 'textile')
    assert.equal(a.periods[0].amount, 9999 + 599 * 10, 'first year, 2 branches, textile price')
    assert.equal(a.monthlyPrice, 999 + 599)
    const b = await s.call<Cust>('admin.customer', cafe.id)
    assert.equal(b.plan, 'food')
    assert.equal(b.periods[0].amount, 3999 + 249 * 10)

    // Own price for the silk shop only.
    await assert.rejects(s.call('admin.setCustomPrice', silk.id, { month: 'x', year: 1, extraBranch: 1 }), /valid prices/)
    await s.call('admin.setCustomPrice', silk.id, { month: 700, year: 7000, extraBranch: 300 })
    a = await s.call<Cust>('admin.customer', silk.id)
    assert.equal(a.customPrice, true)
    assert.equal(a.monthlyPrice, 700 + 300)
    assert.equal(a.periods[0].amount, 9999 + 5990, 'the payment already made keeps its price')
    assert.equal((await s.call<Cust>('admin.customer', cafe.id)).customPrice, false, 'other customers unchanged')
    // The next extension uses it.
    await s.call('admin.renew', silk.id, { months: 1 }, 'paid by UPI')
    a = await s.call<Cust>('admin.customer', silk.id)
    const ext = a.periods.find((p) => p.months === 1)!
    assert.equal(ext.amount, 700 + 300)
    assert.equal(ext.pricePerBranch, 700)

    // A type price change doesn't touch the own price; removing the own price goes back to the type's.
    await s.call('admin.updateSettings', { plans: { textile: { month: 1099, year: 10999, extraBranch: 649 } } })
    assert.equal((await s.call<Cust>('admin.customer', silk.id)).monthlyPrice, 1000)
    await s.call('admin.setCustomPrice', silk.id, null)
    a = await s.call<Cust>('admin.customer', silk.id)
    assert.equal(a.customPrice, false)
    assert.equal(a.monthlyPrice, 1099 + 649)
    assert.equal((await s.call<{ customPrices: number }>('admin.settings')).customPrices, 0)
  } finally { s.close() }
})
