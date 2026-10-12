import type { Product, Special } from './types'

/** Local calendar date as YYYY-MM-DD — specials are planned per business day. */
export const dateKey = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export interface SpecialInfo { special: Special; originalPrice: number }

/**
 * Applies today's special prices to the catalogue. The same function is used by the POS,
 * the customer QR menu and server-side re-pricing, so a special costs the same everywhere.
 */
export function applySpecials(products: Product[], specials: Special[]) {
  const map = new Map<string, SpecialInfo>()
  for (const s of specials) {
    const p = products.find((x) => x.id === s.productId)
    if (p) map.set(p.id, { special: s, originalPrice: p.price })
  }
  const priced = products.map((p) => {
    const sp = map.get(p.id)?.special
    return sp && sp.specialPrice != null && !p.variants.length ? { ...p, price: sp.specialPrice } : p
  })
  const ordered = [...specials].sort((a, b) => a.sort - b.sort).map((s) => priced.find((p) => p.id === s.productId)).filter(Boolean) as Product[]
  return { products: priced, specials: ordered, info: map }
}
