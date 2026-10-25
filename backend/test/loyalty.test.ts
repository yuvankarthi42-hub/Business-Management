import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanLoyalty, DEFAULT_LOYALTY, maxRedeemable, pointsExpiry, pointsForReturn, pointsToEarn, redeemError } from '../../src/core/loyalty'
import { expirePoints } from '../src/domain/points'
import { withShop } from './fixtures'

type P = { id: string }
type C = { id: string; pointsBalance: number }
type O = { id: string; total: number; tax: number; discount: number; pointsRedeemed?: number; pointsValue?: number; pointsEarned?: number; pointsBalance?: number | null; items: { id: string }[] }
type E = { kind: string; points: number; balanceAfter: number; ref: string; expiresOn: string | null; note: string }
const line = (p: P, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const ON = { ...DEFAULT_LOYALTY, enabled: true }

test('loyalty core: earn, use limits, return share, expiry date, settings checks', () => {
  assert.equal(pointsToEarn(ON, 4080), 40)
  assert.equal(pointsToEarn({ ...ON, enabled: false }, 4080), 0)
  assert.equal(pointsToEarn({ ...ON, earnOnDiscounted: false }, 1000, [{ qty: 1, unitPrice: 500, mrp: 600 }, { qty: 1, unitPrice: 500 }]), 5, 'only the full-price line earns')
  assert.equal(maxRedeemable(ON, 340, 10800), 340)
  assert.equal(maxRedeemable(ON, 5000, 1000), 200, '20% of the bill')
  assert.equal(maxRedeemable(ON, 99, 10000), 0, 'below the minimum')
  assert.match(redeemError(ON, 50, 340, 10000), /At least 100/)
  assert.match(redeemError(ON, 400, 340, 10000), /only 340/)
  assert.match(redeemError(ON, 300, 340, 1000), /up to 20%/)
  assert.equal(redeemError(ON, 200, 340, 1000), '')
  assert.equal(pointsForReturn(40, 4000, 1000), 10)
  assert.equal(pointsForReturn(40, 4000, 9999), 40)
  assert.equal(pointsExpiry(ON, '2026-01-31'), '2027-01-31')
  assert.equal(pointsExpiry({ ...ON, expiryMonths: 0 }, '2026-01-31'), null)
  assert.throws(() => cleanLoyalty({ spendPerPoint: 0 }), /Spend/)
  assert.throws(() => cleanLoyalty({ maxBillPct: 120 }), /between 1% and 100%/)
  assert.deepEqual(cleanLoyalty({ enabled: true, minRedeem: 50.7 }), { ...ON, minRedeem: 50 })
})

test('loyalty: earn on bills, use points as a discount before GST, return / cancel, manual change, expiry', async () => {
  const s = await withShop()
  try {
    // Off by default: bills earn nothing and points can't be used.
    await s.call('business.update', { billing: { taxEnabled: false } })
    const saree = await s.call<P>('products.save', { name: 'Saree', price: 5000 })
    const cu = await s.call<C>('customers.save', { name: 'Kalaiselvi', phone: '9800000401' })
    const o0 = await s.call<O>('orders.checkout', draft([line(saree)], { customerId: cu.id }), [{ method: 'cash', amount: 5000 }])
    assert.equal(o0.pointsEarned ?? 0, 0)
    await assert.rejects(s.call('orders.checkout', draft([line(saree)], { customerId: cu.id, pointsToRedeem: 100 }), [{ method: 'cash', amount: 4900 }]), /turned off/)
    await assert.rejects(s.call('business.update', { loyalty: { enabled: true, spendPerPoint: -1 } }), /Spend/)
    const biz = await s.call<{ billing: { taxRates: { id: string; rate: number }[] } }>('business.update', { loyalty: { enabled: true }, billing: { taxEnabled: true, taxMode: 'inclusive', roundOff: true } })
    const r5 = biz.billing.taxRates.find((t) => t.rate === 5)!.id
    const silk = await s.call<P>('products.save', { name: 'Silk Saree', price: 10800, taxRateId: r5 })

    // Earn: ₹10,800 → 108 points, printed on the bill.
    const o1 = await s.call<O>('orders.checkout', draft([line(silk)], { customerId: cu.id }), [{ method: 'cash', amount: 10800 }])
    assert.deepEqual([o1.pointsEarned, o1.pointsBalance], [108, 108])
    // Walk-in bills earn nothing.
    const w = await s.call<O>('orders.checkout', draft([line(silk)]), [{ method: 'cash', amount: 10800 }])
    assert.equal(w.pointsEarned ?? 0, 0)

    // Use: checked against the rules.
    await assert.rejects(s.call('orders.checkout', draft([line(silk)], { customerId: cu.id, pointsToRedeem: 500 }), [{ method: 'cash', amount: 10300 }]), /only 108/)
    await assert.rejects(s.call('orders.checkout', draft([line(silk)], { pointsToRedeem: 100 }), [{ method: 'cash', amount: 10700 }]), /Select the customer/)
    const o2 = await s.call<O>('orders.checkout', draft([line(silk)], { customerId: cu.id, pointsToRedeem: 108 }), [{ method: 'cash', amount: 10692 }])
    assert.equal(o2.total, 10692)
    assert.deepEqual([o2.pointsRedeemed, o2.pointsValue, o2.discount], [108, 108, 108])
    assert.equal(o2.tax, Math.round((10692 - 10692 / 1.05) * 100) / 100, 'GST only on what the customer pays')
    assert.equal(o2.pointsEarned, 106)
    assert.equal(o2.pointsBalance, 106)
    let c = (await s.call<C[]>('customers.list')).find((x) => x.id === cu.id)!
    assert.equal(c.pointsBalance, 106)

    // Return half of bill 1 → 54 of its 108 points come back off; cancel bill 2 → its 106 go, the 108 used return.
    await s.call('returns.create', { orderId: o1.id, lines: [{ orderItemId: o1.items[0].id, qty: 0.5, restock: true }], reason: 'other', settle: 'refund', refundMethod: 'cash' })
    c = (await s.call<C[]>('customers.list')).find((x) => x.id === cu.id)!
    assert.equal(c.pointsBalance, 106 - 54)
    await s.call('orders.cancel', o2.id, 'Billed by mistake')
    c = (await s.call<C[]>('customers.list')).find((x) => x.id === cu.id)!
    assert.equal(c.pointsBalance, 52 - 52 + 108, 'earned points can only go to zero; used points come back')

    // Manual change (owner, with a reason), and history with bill numbers.
    await assert.rejects(s.call('customers.adjustPoints', cu.id, 50, ''), /reason/)
    await assert.rejects(s.call('customers.adjustPoints', cu.id, -1000, 'oops'), /only/)
    await s.call('customers.adjustPoints', cu.id, 50, 'Diwali gift')
    const hist = await s.call<E[]>('customers.points', cu.id)
    assert.equal(hist[0].kind, 'adjust')
    assert.equal(hist[0].balanceAfter, 158)
    assert.ok(hist.some((h) => h.kind === 'earn' && h.ref.startsWith('INV-') && h.expiresOn))
    assert.ok(hist.some((h) => h.kind === 'return' && h.ref.startsWith('CN-')))

    // Expiry: earned points past their date are removed (used ones are not counted twice).
    const all = await s.db.select('customer_points', { where: { customer_id: cu.id } })
    const left = all.filter((r) => Number(r.remaining) > 0).reduce((a, r) => a + Number(r.remaining), 0)
    assert.equal(left, 158, 'every available point is in a row that can expire')
    const expired = await expirePoints(s.db, s.businessId, '2999-01-01')
    assert.equal(expired, 0, 'the earned points were all used or taken back; the gift and the points given back on cancel have no expiry')
    // A fresh earn does expire.
    await s.call<O>('orders.checkout', draft([line(silk)], { customerId: cu.id }), [{ method: 'cash', amount: 10800 }])
    assert.equal(await expirePoints(s.db, s.businessId, '2999-01-01'), 108)
    assert.equal((await s.call<C[]>('customers.list')).find((x) => x.id === cu.id)!.pointsBalance, 158)
    assert.equal(await expirePoints(s.db, s.businessId, '2999-01-01'), 0, 'running again does nothing')
  } finally { s.close() }
})
