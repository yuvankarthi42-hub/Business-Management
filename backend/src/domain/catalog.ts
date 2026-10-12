// Products & categories ⇄ tables (products, product_variants, product_addons, product_prices,
// branch_stock, media_files, stock_batches, categories). Builds the app's `Product` / `Category` shapes.
import type { AddOn, Category, Product, Variant } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { Row, Where } from '../db/types'
import { E, fromMilli, fromMinor, fromMinorOrNull, nameOf, str, strOrNull, toMilli, toMinor } from './util'

export async function mediaMap(c: Ctx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter(Boolean) as string[])]
  if (!want.length) return new Map<string, Row>()
  const rows: Row[] = []
  for (let i = 0; i < want.length; i += 100) rows.push(...await c.db.select('media_files', { where: { ROWID: { in: want.slice(i, i + 100) }, business_id: c.businessId } }))
  return new Map(rows.map((r) => [r.ROWID, r]))
}
const imageOf = (c: Ctx, m: Row | undefined) => !m ? { imageUrl: null, thumbUrl: null }
  : m.bucket === 'external' ? { imageUrl: str(m.object_key), thumbUrl: null } // a photo link kept as is (CSV import)
  : { imageUrl: c.files.url(str(m.object_key)), thumbUrl: m.thumb_key ? c.files.url(str(m.thumb_key)) : null }

export function categoryFrom(c: Ctx, r: Row, media: Map<string, Row>): Category {
  return { id: r.ROWID, businessId: str(r.business_id), name: str(r.name), emoji: str(r.emoji), ...imageOf(c, media.get(str(r.image_media_id))), sort: Number(r.sort_order ?? 0) }
}

export async function loadCategories(c: Ctx): Promise<Category[]> {
  const rows = await c.db.select('categories', { where: { business_id: c.businessId, is_active: true }, orderBy: [['sort_order', 'ASC']] })
  const media = await mediaMap(c, rows.map((r) => str(r.image_media_id)))
  return rows.map((r) => categoryFrom(c, r, media))
}

export interface LoadProductsOptions {
  /** Branches whose stock is added up into `stock` (default: the current view). */
  branches?: string[]
  ids?: string[]
  activeOnly?: boolean
  withExpiry?: boolean
  /** false = no stock read (pricing a bill doesn't need it; `stock` is then 0). */
  withStock?: boolean
}

/** The wholesale / contractor price list (the app has at most one besides retail). */
export const wholesaleList = (c: Ctx) => c.db.first('price_lists', { business_id: c.businessId, is_default: false })

export async function loadProducts(c: Ctx, o: LoadProductsOptions = {}): Promise<Product[]> {
  const biz = c.businessId
  const where = { business_id: biz, ...(o.ids ? { ROWID: { in: o.ids } } : {}), ...(o.activeOnly ? { is_active: true } : {}) }
  const rows = await c.db.select('products', { where, orderBy: [['sort_order', 'ASC'], ['ROWID', 'ASC']] })
  if (!rows.length) return []
  const ids: Where = o.ids ? { product_id: { in: rows.map((r) => r.ROWID) } } : {}
  const list = await wholesaleList(c)
  const branches = o.branches ?? c.scope()
  const [variants, addons, prices, stock, batches, media] = await Promise.all([
    c.db.select('product_variants', { where: { business_id: biz, is_active: true, ...ids }, orderBy: [['sort_order', 'ASC']] }),
    c.db.select('product_addons', { where: { business_id: biz, is_active: true, ...ids }, orderBy: [['sort_order', 'ASC']] }),
    list ? c.db.select('product_prices', { where: { business_id: biz, price_list_id: list.ROWID, ...ids } }) : Promise.resolve([] as Row[]),
    o.withStock !== false ? c.db.select('branch_stock', { where: { business_id: biz, ...ids } }) : Promise.resolve([] as Row[]),
    o.withExpiry !== false ? c.db.select('stock_batches', { where: { business_id: biz, qty_left_milli: { gt: 0 }, ...ids } }) : Promise.resolve([] as Row[]),
    mediaMap(c, rows.map((r) => str(r.image_media_id))),
  ])
  const by = <T extends Row>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = str(x.product_id); m.set(k, [...(m.get(k) ?? []), x]) } return m }
  const V = by(variants), A = by(addons), P = by(prices), S = by(stock), B = by(batches)
  return rows.map((r) => {
    const stockByBranch: Record<string, number> = {}
    for (const s of S.get(r.ROWID) ?? []) stockByBranch[str(s.branch_id)] = fromMilli(s.qty_milli)
    const pp = P.get(r.ROWID) ?? []
    const trackExpiry = !!r.track_batches
    const nextExpiry = trackExpiry ? (B.get(r.ROWID) ?? []).filter((b) => branches.includes(str(b.branch_id)) && b.expiry_date).map((b) => str(b.expiry_date)).sort()[0] ?? null : null
    const p: Product = {
      id: r.ROWID, businessId: biz, name: str(r.name), categoryId: strOrNull(r.category_id), kind: nameOf(E.ProductKind, r.kind) as Product['kind'],
      emoji: str(r.emoji), ...imageOf(c, media.get(str(r.image_media_id))),
      sku: str(r.sku), barcode: str(r.barcode), unit: str(r.unit) || 'pc', price: fromMinor(r.price_minor), mrp: fromMinorOrNull(r.mrp_minor),
      costPrice: fromMinor(r.cost_minor), wholesalePrice: fromMinorOrNull(pp.find((x) => x.variant_id == null)?.price_minor),
      variants: (V.get(r.ROWID) ?? []).map((v): Variant => ({ id: v.ROWID, name: str(v.name), price: fromMinor(v.price_minor), wholesalePrice: fromMinorOrNull(pp.find((x) => x.variant_id === v.ROWID)?.price_minor) })),
      addOns: (A.get(r.ROWID) ?? []).map((a): AddOn => ({ id: a.ROWID, name: str(a.name), price: fromMinor(a.price_minor) })),
      taxRateId: strOrNull(r.tax_rate_id), trackStock: !!r.track_stock, trackExpiry, nextExpiry,
      stockByBranch, stock: Math.round(branches.reduce((n, b) => n + (stockByBranch[b] ?? 0), 0) * 1000) / 1000,
      lowStockAt: fromMilli(r.low_stock_milli), isVeg: r.is_veg !== false, sendToKitchen: r.sends_to_kitchen !== false, active: r.is_active !== false,
      createdAt: r.CREATEDTIME, createdBy: '', updatedAt: r.MODIFIEDTIME, updatedBy: '',
    }
    return p
  })
}

/** Columns of the products table for a save. */
export function productColumns(p: Partial<Product>) {
  const out: Record<string, string | number | boolean | null> = {}
  if (p.name !== undefined) out.name = p.name.trim().slice(0, 150)
  if (p.categoryId !== undefined) out.category_id = p.categoryId || null
  if (p.kind !== undefined) out.kind = p.kind === 'service' ? E.ProductKind.service : E.ProductKind.goods
  if (p.emoji !== undefined) out.emoji = (p.emoji || '').slice(0, 8) || null
  if (p.sku !== undefined) out.sku = (p.sku || '').trim().slice(0, 40) || null
  if (p.unit !== undefined) out.unit = (p.unit || 'pc').slice(0, 10)
  if (p.price !== undefined) { if (!(p.price >= 0)) throw new ApiError('Enter a valid price'); out.price_minor = toMinor(p.price) }
  if (p.mrp !== undefined) out.mrp_minor = p.mrp == null ? null : toMinor(p.mrp)
  if (p.costPrice !== undefined) out.cost_minor = toMinor(p.costPrice ?? 0)
  if (p.taxRateId !== undefined) out.tax_rate_id = p.taxRateId || null
  if (p.trackStock !== undefined) out.track_stock = !!p.trackStock
  if (p.trackExpiry !== undefined) out.track_batches = !!p.trackExpiry
  if (p.lowStockAt !== undefined) out.low_stock_milli = toMilli(p.lowStockAt ?? 0)
  if (p.isVeg !== undefined) out.is_veg = !!p.isVeg
  if (p.sendToKitchen !== undefined) out.sends_to_kitchen = !!p.sendToKitchen
  if (p.active !== undefined) out.is_active = !!p.active
  return out
}

/** Sync sizes, add-ons and contractor prices of one product to what the form sent. */
export async function syncOptions(c: Ctx, productId: string, p: Partial<Product>) {
  const biz = c.businessId
  const list = p.wholesalePrice !== undefined || p.variants?.some((v) => v.wholesalePrice !== undefined) ? await wholesaleList(c) : null
  let variantIds = new Map<string, string>()
  if (p.variants) variantIds = await syncList(c, 'product_variants', productId, p.variants.map((v, i) => ({ id: v.id, data: { name: String(v.name ?? '').trim().slice(0, 60), price_minor: toMinor(v.price) ?? 0, sort_order: i, is_active: true } })))
  if (p.addOns) await syncList(c, 'product_addons', productId, p.addOns.map((a, i) => ({ id: a.id, data: { name: String(a.name ?? '').trim().slice(0, 60), price_minor: toMinor(a.price) ?? 0, sort_order: i, is_active: true } })))
  if (list) {
    const cur = await c.db.select('product_prices', { where: { business_id: biz, price_list_id: list.ROWID, product_id: productId } })
    const want: { variant: string | null; price: number | null }[] = []
    if (p.wholesalePrice !== undefined) want.push({ variant: null, price: p.wholesalePrice ?? null })
    for (const v of p.variants ?? []) if (v.wholesalePrice !== undefined) want.push({ variant: variantIds.get(v.id) ?? v.id, price: v.wholesalePrice ?? null })
    for (const w of want) {
      const ex = cur.find((x) => (x.variant_id ?? null) === w.variant)
      if (w.price == null || !(w.price > 0)) { if (ex) await c.db.delete('product_prices', ex.ROWID); continue }
      if (ex) await c.db.update('product_prices', ex.ROWID, { price_minor: toMinor(w.price) })
      else await c.db.insert('product_prices', { business_id: biz, price_list_id: list.ROWID, product_id: productId, variant_id: w.variant, price_minor: toMinor(w.price), uniq_key: `${list.ROWID}:${productId}:${w.variant ?? 0}` })
    }
  }
}

/** Upserts child rows; rows not in the list are hidden (bills keep pointing at them). Returns app id → ROWID. */
async function syncList(c: Ctx, table: 'product_variants' | 'product_addons', productId: string, items: { id: string; data: Record<string, string | number | boolean | null> }[]) {
  const cur = await c.db.select(table, { where: { product_id: productId, business_id: c.businessId } })
  const ids = new Map<string, string>()
  const keep = new Set<string>()
  for (const it of items) {
    if (!it.data.name) throw new ApiError('Every size / add-on needs a name')
    const ex = cur.find((x) => x.ROWID === it.id)
    if (ex) { await c.db.update(table, ex.ROWID, it.data); keep.add(ex.ROWID); ids.set(it.id, ex.ROWID) }
    else { const r = await c.db.insert(table, { business_id: c.businessId, product_id: productId, ...it.data }); keep.add(r.ROWID); ids.set(it.id, r.ROWID) }
  }
  const hide = cur.filter((x) => !keep.has(x.ROWID) && x.is_active !== false)
  if (hide.length) await c.db.updateMany(table, hide.map((x) => ({ ROWID: x.ROWID, is_active: false })))
  return ids
}
