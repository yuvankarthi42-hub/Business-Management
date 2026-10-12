import { r2 } from './pricing'
import type { AddOn, BillingSettings, OrderItem, PriceTier, Product, Variant } from './types'
import { uid } from '@/lib/format'

export function taxRateOf(p: Product, billing: BillingSettings) {
  if (!billing.taxEnabled) return 0
  const id = p.taxRateId ?? billing.defaultTaxRateId
  return billing.taxRates.find((t) => t.id === id)?.rate ?? 0
}

export function makeItem(
  p: Product, billing: BillingSettings,
  opts: { variant?: Variant | null; addOns?: AddOn[]; qty?: number; notes?: string; tier?: PriceTier } = {},
): OrderItem {
  const addOns = opts.addOns ?? []
  const tier = opts.tier === 'wholesale' && wholesaleOn(billing) ? 'wholesale' : 'retail'
  const base = basePrice(p, opts.variant ?? null, tier)
  return {
    id: uid('oi_'),
    productId: p.id,
    name: p.name,
    variantId: opts.variant?.id ?? null,
    variantName: opts.variant?.name ?? null,
    addOns: addOns.map((a) => ({ id: a.id, name: a.name, price: a.price })),
    qty: opts.qty ?? 1,
    unit: p.unit,
    unitPrice: r2(base + addOns.reduce((s, a) => s + a.price, 0)),
    taxRate: taxRateOf(p, billing),
    notes: opts.notes ?? '',
    kotQty: 0,
    ...(tier === 'wholesale' && base !== (opts.variant ? opts.variant.price : p.price) ? { priceTier: tier } : {}),
  }
}

export const wholesaleOn = (billing: BillingSettings) => !!billing.wholesale?.enabled
export const wholesaleLabel = (billing: BillingSettings) => billing.wholesale?.label?.trim() || 'Wholesale rate'

/** Retail price, or the wholesale price when the bill is on that list and the item has one. */
export function basePrice(p: Product, variant: Variant | null, tier: PriceTier = 'retail') {
  if (tier === 'wholesale') {
    const w = variant ? variant.wholesalePrice : p.wholesalePrice
    if (w != null && w > 0) return w
  }
  return variant ? variant.price : p.price
}

/** Re-price bill lines for a price list (customer changed, or the contractor-rate switch). */
export function repriceItems(items: OrderItem[], products: Product[], billing: BillingSettings, tier: PriceTier): OrderItem[] {
  const t = tier === 'wholesale' && wholesaleOn(billing) ? 'wholesale' : 'retail'
  return items.map((i) => {
    const p = products.find((x) => x.id === i.productId)
    if (!p) return i
    const v = i.variantId ? p.variants.find((x) => x.id === i.variantId) ?? null : null
    const base = basePrice(p, v, t)
    const { priceTier: _old, ...rest } = i
    return { ...rest, unitPrice: r2(base + i.addOns.reduce((s, a) => s + a.price, 0)), ...(t === 'wholesale' && base !== (v ? v.price : p.price) ? { priceTier: 'wholesale' as const } : {}) }
  })
}

/** Same product + variant + add-ons + notes => merge quantities instead of adding a new line. */
export const itemKey = (i: Pick<OrderItem, 'productId' | 'variantId' | 'addOns' | 'notes'>) =>
  [i.productId, i.variantId ?? '', i.addOns.map((a) => a.id).sort().join('+'), i.notes].join('|')

export function mergeInto(items: OrderItem[], add: OrderItem): OrderItem[] {
  const k = itemKey(add)
  const found = items.find((i) => itemKey(i) === k)
  if (!found) return [...items, add]
  return items.map((i) => (i === found ? { ...i, qty: r2(i.qty + add.qty) } : i))
}

export const itemLabel = (i: OrderItem) =>
  [i.name, i.variantName ? `(${i.variantName})` : ''].filter(Boolean).join(' ')
