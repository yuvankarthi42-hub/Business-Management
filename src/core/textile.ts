// Textile shops: one design in many sizes / colours, and discounts for a whole category.
// The checks live here so the mock API and the backend accept exactly the same input.
import { cleanDetails, discountedPrice } from './stickers'
import type { ID, Product } from './types'

export interface DesignInput {
  name: string
  categoryId: ID | null
  design: string
  fabric: string
  mrp: number
  /** Selling price (MRP less the shop's discount). */
  price: number
  costPrice: number
  taxRateId: ID | null
  unit: string
  lowStockAt: number
  /** HSN / SAC code (same for every colour and size). */
  hsn?: string | null
  imageUrl?: string | null
  thumbUrl?: string | null
  /** One item per row: colour and/or size, with its opening stock. */
  rows: { colour: string; size: string; stock: number }[]
}

export const MAX_DESIGN_ROWS = 120

/** Checks a design and returns the products to create (stock = opening stock in the current branch). */
export function planDesign(input: DesignInput, existing: Pick<Product, 'details' | 'active'>[]): (Partial<Product> & { name: string; stock: number })[] {
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('Enter the item name')
  const mrp = Number(input.mrp), price = Number(input.price || input.mrp)
  if (!(mrp > 0)) throw new Error('Enter the MRP')
  if (!(price > 0)) throw new Error('Enter the selling price')
  if (price > mrp) throw new Error('Selling price can’t be above the MRP')
  if (!(Number(input.costPrice ?? 0) >= 0)) throw new Error('Enter a valid cost price')
  const rows = Array.isArray(input.rows) ? input.rows : []
  if (!rows.length) throw new Error('Add at least one colour or size')
  if (rows.length > MAX_DESIGN_ROWS) throw new Error(`Up to ${MAX_DESIGN_ROWS} sizes × colours at a time`)
  const design = cleanDetails({ design: input.design })?.design ?? ''
  const fabric = cleanDetails({ fabric: input.fabric })?.fabric ?? ''
  const seen = new Set<string>()
  const key = (colour?: string, size?: string) => `${(colour ?? '').toLowerCase()}|${(size ?? '').toLowerCase()}`
  // Same design no. + colour + size already in the catalogue → that item exists (add stock to it instead).
  const taken = new Set(design ? existing.filter((p) => p.active !== false && p.details?.design?.toLowerCase() === design.toLowerCase()).map((p) => key(p.details?.colour, p.details?.size)) : [])
  return rows.map((r) => {
    const d = cleanDetails({ colour: r.colour, size: r.size }) ?? {}
    const k = key(d.colour, d.size)
    const label = [d.colour, d.size].filter(Boolean).join(' / ')
    if (seen.has(k)) throw new Error(`${label || 'A row'} is listed twice`)
    seen.add(k)
    if (taken.has(k)) throw new Error(`Design ${design}${label ? ` (${label})` : ''} already exists — add stock to it in Inventory`)
    const stock = Number(r.stock ?? 0)
    if (!(stock >= 0 && stock <= 100_000 && Number.isInteger(stock))) throw new Error(`${label || 'Stock'}: enter whole pieces`)
    return {
      name: [name, label].filter(Boolean).join(' · ').slice(0, 150), categoryId: input.categoryId || null, kind: 'goods' as const,
      sku: design, mrp, price, costPrice: Number(input.costPrice ?? 0), taxRateId: input.taxRateId || null, unit: input.unit || 'pc',
      trackStock: true, lowStockAt: Math.max(0, Number(input.lowStockAt ?? 1)), isVeg: true, sendToKitchen: false, active: true,
      details: cleanDetails({ design, fabric, ...d }), imageUrl: input.imageUrl ?? null, thumbUrl: input.thumbUrl ?? null, stock,
      hsn: input.hsn ? String(input.hsn).replace(/\s+/g, '').slice(0, 8) : null,
    }
  })
}

export interface DiscountInput {
  /** Whole category, or null for every item. Ignored when productIds is given. */
  categoryId: ID | null
  productIds?: ID[]
  /** % off MRP. 0 = sell at MRP (removes the discount). */
  pct: number
  /** Round the new price to the nearest ₹1, ₹5 or ₹10. */
  round: 1 | 5 | 10
}

/** New selling prices for a category discount. Items without an MRP, or with sizes, are left alone. */
export function planDiscount(input: DiscountInput, products: Pick<Product, 'id' | 'categoryId' | 'mrp' | 'price' | 'variants' | 'active'>[]) {
  const pct = Number(input.pct)
  if (!(pct >= 0 && pct <= 90)) throw new Error('Discount must be between 0 and 90%')
  const round = ([1, 5, 10] as const).includes(input.round) ? input.round : 1
  const only = input.productIds?.length ? new Set(input.productIds) : null
  const pick = products.filter((p) => p.active !== false && (only ? only.has(p.id) : !input.categoryId || p.categoryId === input.categoryId))
  const changes: { id: ID; price: number }[] = []
  const ids: ID[] = [] // every item now on this discount (for printing new stickers)
  let noMrp = 0, withSizes = 0
  for (const p of pick) {
    if (p.variants.length) { withSizes++; continue }
    if (!(p.mrp && p.mrp > 0)) { noMrp++; continue }
    const price = pct === 0 ? p.mrp : discountedPrice(p.mrp, pct, round)
    ids.push(p.id)
    if (price !== p.price) changes.push({ id: p.id, price })
  }
  if (!pick.length) throw new Error('No items to change')
  return { changes, ids, matched: pick.length, noMrp, withSizes }
}
