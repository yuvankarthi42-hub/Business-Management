// Price stickers (textile, supermarket, hardware): layout settings and what price a sticker shows.
// Shared by the app, the mock API and the backend, so the sticker always matches what the bill charges.
import type { BillingSettings, Business, Product, ProductDetails, StickerSettings, StickerSize } from './types'

export const STICKER_SIZES: Record<StickerSize, { name: string; w: number; h: number; sheet: boolean; perSheet?: number }> = {
  '50x38': { name: '50 × 38 mm roll', w: 50, h: 38, sheet: false },
  '50x25': { name: '50 × 25 mm roll', w: 50, h: 25, sheet: false },
  '38x25': { name: '38 × 25 mm roll', w: 38, h: 25, sheet: false },
  a4: { name: 'A4 sheet · 65 stickers', w: 38.1, h: 21.2, sheet: true, perSheet: 65 },
}

export const DEFAULT_STICKERS: StickerSettings = {
  size: '50x38', code: 'qr', showShop: true, showName: true, showDesign: true, showDetails: true, priceMode: 'auto', footer: '', copies: 1,
}

/** Textile shops get QR + 50×38 by default; other shops keep the small barcode label they had. */
export function stickerSettings(b: Pick<Business, 'stickers' | 'category' | 'subType'>): StickerSettings {
  const base = isTextileShop(b) ? DEFAULT_STICKERS : { ...DEFAULT_STICKERS, size: '50x25' as const, code: 'barcode' as const }
  return { ...base, ...(b.stickers ?? {}) }
}

/** Checks a settings patch from the browser (the backend stores only what passes). */
export function cleanStickers(input: Partial<StickerSettings> | null | undefined, cur: StickerSettings = DEFAULT_STICKERS): StickerSettings {
  const x = input ?? {}
  const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
  const copies = Math.floor(Number(x.copies ?? cur.copies))
  if (x.size !== undefined && !(x.size in STICKER_SIZES)) throw new Error('Choose a sticker size')
  if (x.code !== undefined && x.code !== 'qr' && x.code !== 'barcode') throw new Error('Choose QR code or barcode')
  if (x.priceMode !== undefined && x.priceMode !== 'auto' && x.priceMode !== 'mrp') throw new Error('Choose what price to print')
  if (!(copies >= 1 && copies <= 50)) throw new Error('Stickers per item must be between 1 and 50')
  return {
    size: x.size ?? cur.size, code: x.code ?? cur.code,
    showShop: bool(x.showShop, cur.showShop), showName: bool(x.showName, cur.showName), showDesign: bool(x.showDesign, cur.showDesign), showDetails: bool(x.showDetails, cur.showDetails),
    priceMode: x.priceMode ?? cur.priceMode, footer: String(x.footer ?? cur.footer).replace(/\s+/g, ' ').trim().slice(0, 40), copies,
  }
}

export const mrpDiscountsOn = (billing: Pick<BillingSettings, 'mrpDiscounts'>) => billing.mrpDiscounts !== false

/**
 * What a sticker shows. A discount is printed only when discounts are on, the product has an MRP above its
 * selling price, and the sticker isn't set to "MRP only". Otherwise the price is the MRP (or the price when no MRP).
 */
export function stickerPrice(p: Pick<Product, 'price' | 'mrp'>, billing: Pick<BillingSettings, 'mrpDiscounts'>, mode: StickerSettings['priceMode'] = 'auto') {
  const mrp = p.mrp && p.mrp > 0 ? p.mrp : null
  if (mrp && mrp > p.price && mrpDiscountsOn(billing) && mode === 'auto') {
    const off = Math.round((mrp - p.price) * 100) / 100
    return { mrp, price: p.price, off, pct: Math.round((off / mrp) * 100) }
  }
  // No discount to show (or discounts off, when the bill charges MRP): the sticker says MRP only.
  const shown = mrp ?? p.price
  return { mrp: shown, price: shown, off: 0, pct: 0 }
}

/** Silk, saree, textile and garment shops. */
export function isTextileShop(b: Pick<Business, 'category' | 'subType'>) {
  return b.category === 'retail' && /silk|saree|sari|textile|fabric|garment|cloth|readymade|boutique|apparel/i.test(b.subType)
}

/** Discount from MRP → selling price, rounded to the nearest `step` rupees (1 or 10). */
export function discountedPrice(mrp: number, pct: number, step: 1 | 5 | 10 = 1) {
  if (!(mrp > 0) || !(pct >= 0 && pct < 100)) return mrp
  return Math.max(0, Math.round((mrp * (1 - pct / 100)) / step) * step)
}

/** Design no. / fabric / colour / size: trimmed, short, and null when all are empty. */
export function cleanDetails(d: ProductDetails | null | undefined): ProductDetails | null {
  if (!d || typeof d !== 'object') return null
  const out: ProductDetails = {}
  for (const k of ['design', 'fabric', 'colour', 'size'] as const) {
    const v = String(d[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, k === 'fabric' ? 40 : 30)
    if (v) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** "Red · XL · Cotton" — for lists, stickers and the bill. */
export const detailsLine = (d: ProductDetails | null | undefined, keys: (keyof ProductDetails)[] = ['colour', 'size', 'fabric']) =>
  keys.map((k) => d?.[k]).filter(Boolean).join(' · ')
