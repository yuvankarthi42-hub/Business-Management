// The light product index of large shops (over CATALOG_FULL_MAX products): one compact row per product, kept on the
// device and refreshed with "what changed since". Billing searches it; every list screen reads it; an item's
// variants, add-ons, photo details and textile details are read only when it is opened (products.byIds).
// Shared by the API (backend/src/domain/catalog.ts) and the app (src/data/remote/catalogIndex.ts).
import type { Product } from './types'

/** Up to this many products the whole catalogue is loaded as before; above it, the light index is used. */
export const CATALOG_FULL_MAX = 2000
/**
 * The customers' QR menu is sent whole up to this many active items; above it, a page at a time (public.menuItems)
 * — so building it stays small (each item costs JSON text; ~500 items took ~17–26 ms). Staff screens keep CATALOG_FULL_MAX.
 */
export const QR_MENU_FULL_MAX = 150
/** Rows per products.index answer (keeps each answer's server CPU small). */
export const INDEX_PAGE = 1000
/** More changes than this since the device's copy: the whole index is read again. */
export const INDEX_MAX_CHANGES = 3000

/** Positions in a light row. */
export const L = {
  id: 0, name: 1, categoryId: 2, sort: 3, price: 4, mrp: 5, unit: 6, taxRateId: 7, barcode: 8, sku: 9, flags: 10,
  stock: 11, stockByBranch: 12, lowStockAt: 13, thumbUrl: 14, imageUrl: 15, wholesalePrice: 16, costPrice: 17,
  emoji: 18, hsn: 19, variants: 20, addOns: 21, minVariantPrice: 22, updatedAt: 23, nextExpiry: 24,
} as const
export const LF = { active: 1, trackStock: 2, isVeg: 4, sendToKitchen: 8, trackExpiry: 16, service: 32 } as const

export type LightRow = [
  id: string, name: string, categoryId: string | null, sort: number, price: number, mrp: number | null, unit: string,
  taxRateId: string | null, barcode: string, sku: string, flags: number, stock: number, stockByBranch: Record<string, number>,
  lowStockAt: number, thumbUrl: string | null, imageUrl: string | null, wholesalePrice: number | null, costPrice: number,
  emoji: string, hsn: string | null, variants: number, addOns: number, minVariantPrice: number | null, updatedAt: string,
  nextExpiry: string | null,
]

export interface IndexPage {
  rows: LightRow[]
  /** Next page (id cursor), or null when this was the last one. */
  next: string | null
  /** Changes after this time are not in these rows (ask again "since" it). */
  at: string
  /** Too many changes since the device's copy: read the whole index again. */
  reset?: boolean
}

/** A light row → the app's Product (variants / add-ons left empty; `light` says how many there are). */
export function fromLightRow(r: LightRow, businessId: string): Product {
  const f = r[L.flags]
  return {
    id: r[L.id], businessId, name: r[L.name], categoryId: r[L.categoryId], kind: f & LF.service ? 'service' : 'goods',
    emoji: r[L.emoji], imageUrl: r[L.imageUrl], thumbUrl: r[L.thumbUrl], sku: r[L.sku], barcode: r[L.barcode], unit: r[L.unit] || 'pc',
    price: r[L.price], mrp: r[L.mrp], costPrice: r[L.costPrice], wholesalePrice: r[L.wholesalePrice], variants: [], addOns: [],
    taxRateId: r[L.taxRateId], trackStock: !!(f & LF.trackStock), trackExpiry: !!(f & LF.trackExpiry), nextExpiry: r[L.nextExpiry] ?? null,
    stockByBranch: r[L.stockByBranch] ?? {}, stock: r[L.stock], lowStockAt: r[L.lowStockAt], isVeg: !!(f & LF.isVeg),
    sendToKitchen: !!(f & LF.sendToKitchen), active: !!(f & LF.active), hsn: r[L.hsn],
    createdAt: r[L.updatedAt], createdBy: '', updatedAt: r[L.updatedAt], updatedBy: '',
    light: { variants: r[L.variants], addOns: r[L.addOns], minVariantPrice: r[L.minVariantPrice] },
  }
}

/** How many sizes / add-ons a product has (a light one says so without carrying them). */
export const variantCount = (p: Pick<Product, 'variants' | 'light'>) => (p.light ? p.light.variants : p.variants.length)
export const addOnCount = (p: Pick<Product, 'addOns' | 'light'>) => (p.light ? p.light.addOns : p.addOns.length)
/** The lowest size price (null without sizes) — a light one carries it. */
export const minVariantPrice = (p: Pick<Product, 'variants' | 'light'>) =>
  p.light ? (p.light.variants ? p.light.minVariantPrice : null) : p.variants.length ? Math.min(...p.variants.map((v) => v.price)) : null
