import { r2 } from './pricing'
import { mrpDiscountsOn } from './stickers'
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
  const base = basePrice(p, opts.variant ?? null, tier, billing)
  const mrp = mrpOf(p, opts.variant ?? null, base)
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
    ...(mrp ? { mrp } : {}),
  }
}

/** The product's MRP when the line is charged less than it (no size chosen — sizes have their own prices). */
const mrpOf = (p: Product, variant: Variant | null, base: number) => (!variant && p.mrp && p.mrp > base ? p.mrp : undefined)

export const wholesaleOn = (billing: BillingSettings) => !!billing.wholesale?.enabled
export const wholesaleLabel = (billing: BillingSettings) => billing.wholesale?.label?.trim() || 'Wholesale rate'

/**
 * Retail price, or the wholesale price when the bill is on that list and the item has one.
 * With customer discounts turned off (Settings → Billing), retail items sell at their MRP.
 */
export function basePrice(p: Product, variant: Variant | null, tier: PriceTier = 'retail', billing?: Pick<BillingSettings, 'mrpDiscounts'>) {
  if (tier === 'wholesale') {
    const w = variant ? variant.wholesalePrice : p.wholesalePrice
    if (w != null && w > 0) return w
  }
  if (variant) return variant.price
  if (billing && !mrpDiscountsOn(billing) && p.mrp && p.mrp > p.price) return p.mrp
  return p.price
}

/** Re-price bill lines for a price list (customer changed, or the contractor-rate switch). Lines with a counter price keep it. */
export function repriceItems(items: OrderItem[], products: Product[], billing: BillingSettings, tier: PriceTier): OrderItem[] {
  const t = tier === 'wholesale' && wholesaleOn(billing) ? 'wholesale' : 'retail'
  return items.map((i) => {
    const p = products.find((x) => x.id === i.productId)
    if (!p || i.priceOverride !== undefined) return i
    const v = i.variantId ? p.variants.find((x) => x.id === i.variantId) ?? null : null
    const base = basePrice(p, v, t, billing)
    const mrp = mrpOf(p, v, base)
    const { priceTier: _old, mrp: _oldMrp, ...rest } = i
    return { ...rest, unitPrice: r2(base + i.addOns.reduce((s, a) => s + a.price, 0)), ...(t === 'wholesale' && base !== (v ? v.price : p.price) ? { priceTier: 'wholesale' as const } : {}), ...(mrp ? { mrp } : {}) }
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

// ---------- Price changed at the counter (price change / line discount) ----------

/** Why this counter price can't be used ('' = fine). Never above MRP (illegal for packed goods). */
export function priceOverrideError(price: number, mrp: number | null | undefined) {
  if (!Number.isFinite(price) || price < 0) return 'Enter a valid price'
  if (price > 10_000_000) return 'Price is too high'
  if (mrp && price > mrp + 0.001) return `Price can’t be more than the MRP (${mrp})`
  return ''
}

/** A line with its price changed at the counter (unit price includes add-ons). The catalogue price is kept for display. */
export function withCounterPrice(i: OrderItem, price: number, product?: Pick<Product, 'mrp'> | null): OrderItem {
  const list = i.listPrice ?? i.unitPrice
  const unitPrice = r2(price)
  if (Math.abs(unitPrice - list) < 0.001) return clearCounterPrice(i, product)
  const base = unitPrice - i.addOns.reduce((a, x) => a + x.price, 0)
  const mrp = !i.variantId && product?.mrp && product.mrp > base ? product.mrp : undefined
  const { mrp: _old, ...rest } = i
  return { ...rest, unitPrice, priceOverride: unitPrice, listPrice: list, ...(mrp ? { mrp } : {}) }
}

/** Back to the catalogue price. */
export function clearCounterPrice(i: OrderItem, product?: Pick<Product, 'mrp'> | null): OrderItem {
  if (i.listPrice === undefined) return i
  const { priceOverride: _p, listPrice, mrp: _m, ...rest } = i
  const base = listPrice - i.addOns.reduce((a, x) => a + x.price, 0)
  const mrp = !i.variantId && product?.mrp && product.mrp > base ? product.mrp : undefined
  return { ...rest, unitPrice: listPrice, ...(mrp ? { mrp } : {}) }
}
