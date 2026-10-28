import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutoParts, isGarage, isVegetableShop, productFormFor, setupDefaultsFor, TEMPLATES, usesRetailPos } from '../../src/core/config'
import { categoryEmojisFor } from '../../src/core/categoryEmojis'
import { planKeyFor } from '../../src/core/plans'
import { withShop } from './fixtures'

test('new shop types: vegetables & fruits, auto spare parts, vehicle service / garage', () => {
  const retail = TEMPLATES.find((t) => t.key === 'retail')!, service = TEMPLATES.find((t) => t.key === 'service')!
  assert.ok(retail.subTypes.includes('Vegetables & Fruits') && retail.subTypes.includes('Auto Spare Parts') && retail.units.includes('bunch'))
  assert.ok(service.subTypes.includes('Vehicle Service / Garage'))
  const veg = { category: 'retail' as const, subType: 'Vegetables & Fruits' }, auto = { category: 'retail' as const, subType: 'Auto Spare Parts' }, garage = { category: 'service' as const, subType: 'Vehicle Service / Garage' }
  assert.ok(isVegetableShop(veg) && !usesRetailPos(veg), 'vegetables: tile billing')
  assert.ok(isAutoParts(auto) && usesRetailPos(auto), 'spare parts: scan-first billing')
  assert.ok(isGarage(garage))
  assert.deepEqual(setupDefaultsFor(veg), { taxRate: 0, taxMode: 'exclusive', modules: {} })
  assert.deepEqual(setupDefaultsFor(auto), { taxRate: 18, taxMode: 'inclusive', modules: { mobileOrders: true, customerOrders: true } })
  assert.equal(setupDefaultsFor(garage).taxRate, 18)
  assert.equal(productFormFor(veg).namePlaceholder, 'Tomato')
  assert.ok(productFormFor(auto).showMrp)
  assert.equal(categoryEmojisFor(veg)[0].label, 'Leafy Greens')
  assert.equal(categoryEmojisFor(auto)[0].label, 'Engine Oil')
  assert.equal(categoryEmojisFor(garage)[0].label, 'General Service')
  assert.deepEqual([planKeyFor(veg), planKeyFor(auto), planKeyFor(garage)], ['retail', 'retail', 'service'])
})

test('existing shop types keep exactly the same set-up defaults (no impact)', () => {
  const was = (b: { category: 'food' | 'restaurant' | 'retail' | 'service'; subType: string }) => {
    const hw = b.category === 'retail' && /hardware|electric/i.test(b.subType)
    const tex = b.category === 'retail' && /silk|saree|sari|textile|fabric|garment|cloth|readymade|boutique|apparel/i.test(b.subType)
    const sup = b.category === 'retail' && /super|grocery|maligai|kirana|provision|mart/i.test(b.subType)
    return { taxRate: hw ? 18 : tex ? 5 : b.category === 'retail' ? 0 : 5, taxMode: sup || tex ? 'inclusive' : 'exclusive', modules: hw ? { mobileOrders: true, customerOrders: true } : {} }
  }
  for (const t of TEMPLATES) for (const sub of t.subTypes) {
    if (['Vegetables & Fruits', 'Auto Spare Parts', 'Vehicle Service / Garage'].includes(sub)) continue
    assert.deepEqual(setupDefaultsFor({ category: t.category, subType: sub }), was({ category: t.category, subType: sub }), `${t.key} · ${sub}`)
  }
})

test('set-up as an auto spare-parts shop: GST 18 % included in prices, Customer Orders on', async () => {
  const s = await withShop()
  try {
    const me = await s.call<{ business: { modules: Record<string, boolean> } }>('auth.me')
    await s.call('business.saveSetup', { name: 'Balaji Auto', category: 'retail', subType: 'Auto Spare Parts', modules: me.business.modules, terminology: {}, orderTypes: ['counter'], categories: [{ name: 'Engine Oil', emoji: '🛢️' }], tables: [] })
    const b = (await s.call<{ business: { subType: string; modules: Record<string, boolean>; billing: { taxMode: string; defaultTaxRateId: string; taxRates: { id: string; rate: number }[] } } }>('auth.me')).business
    assert.equal(b.subType, 'Auto Spare Parts')
    assert.equal(b.billing.taxMode, 'inclusive')
    assert.equal(b.billing.taxRates.find((r) => r.id === b.billing.defaultTaxRateId)?.rate, 18)
    assert.ok(b.modules.customerOrders && b.modules.mobileOrders)
  } finally { s.close() }
})
