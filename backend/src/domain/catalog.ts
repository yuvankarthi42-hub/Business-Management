// Products & categories ⇄ tables (products, product_variants, product_addons, product_prices,
// branch_stock, media_files, stock_batches, categories). Builds the app's `Product` / `Category` shapes.
import type { AddOn, Category, Product, Variant } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { Row, Value, Where } from '../db/types'
import { cleanHsn, hsnError } from '@/core/gst'
import { cleanDetails } from '@/core/stickers'
import { fromLightRow, INDEX_MAX_CHANGES, INDEX_PAGE, L, LF, type IndexPage, type LightRow } from '@/core/catalogIndex'
import { E, fromMilli, fromMinor, fromMinorOrNull, json, nameOf, str, strOrNull, toMilli, toMinor, money } from './util'

export async function mediaMap(c: Ctx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter(Boolean) as string[])]
  if (!want.length) return new Map<string, Row>()
  const rows: Row[] = []
  for (let i = 0; i < want.length; i += 100) rows.push(...await c.db.select('media_files', { where: { ROWID: { in: want.slice(i, i + 100) }, business_id: c.businessId } }))
  return new Map(rows.map((r) => [r.ROWID, r]))
}
/** A product / category photo's links (as the app's Product has them). */
export const imageOf = (c: Ctx, m: Row | undefined) => !m ? { imageUrl: null, thumbUrl: null }
  : m.bucket === 'external' ? { imageUrl: str(m.object_key), thumbUrl: null } // a photo link kept as is (CSV import)
  : { imageUrl: c.files.url(str(m.object_key)), thumbUrl: m.thumb_key ? c.files.url(str(m.thumb_key)) : null }

export function categoryFrom(c: Ctx, r: Row, media: Map<string, Row>): Category {
  return { id: r.ROWID, businessId: str(r.business_id), name: str(r.name), emoji: str(r.emoji), ...imageOf(c, media.get(str(r.image_media_id))), sort: Number(r.sort_order ?? 0), hsn: strOrNull(r.hsn_code) }
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
  /** For customers' screens (QR menu, TV board): no cost and no wholesale prices (not even read). */
  forCustomers?: boolean
}

/** The wholesale / contractor price list (the app has at most one besides retail). */
export const wholesaleList = (c: Ctx) => c.db.first('price_lists', { business_id: c.businessId, is_default: false })

export async function loadProducts(c: Ctx, o: LoadProductsOptions = {}): Promise<Product[]> {
  const biz = c.businessId
  const where = { business_id: biz, ...(o.ids ? { ROWID: { in: o.ids } } : {}), ...(o.activeOnly ? { is_active: true } : {}) }
  const rows = await c.db.select('products', { where, orderBy: [['sort_order', 'ASC'], ['ROWID', 'ASC']] })
  return productsFrom(c, rows, o.ids ? rows.map((r) => r.ROWID) : null, o)
}

/** One page of the product list, in the list's order (sort order, then id): products.page for big shops. */
export async function loadProductPage(c: Ctx, offset: number, limit: number) {
  const rows = await c.db.select('products', { where: { business_id: c.businessId }, orderBy: [['sort_order', 'ASC'], ['ROWID', 'ASC']], limit: limit + 1, offset })
  const more = rows.length > limit
  const mine = more ? rows.slice(0, limit) : rows
  return { rows: await productsFrom(c, mine, mine.map((r) => r.ROWID), {}), next: more ? offset + limit : null }
}

/** Product rows → the app's `Product`, with variants, add-ons, wholesale prices, stock, next expiry and photo. `ids` = read only these products' extras (null = the whole shop's). */
async function productsFrom(c: Ctx, rows: Row[], ids: string[] | null, o: LoadProductsOptions): Promise<Product[]> {
  if (!rows.length) return []
  const biz = c.businessId
  const only: Where = ids ? { product_id: { in: ids } } : {}
  const list = o.forCustomers ? null : await wholesaleList(c)
  const branches = o.branches ?? c.scope()
  const inScope = new Set(branches)
  // Expiry batches only matter for products that track them.
  const anyBatches = o.withExpiry !== false && rows.some((r) => !!r.track_batches)
  const [variants, addons, prices, stock, batches, media] = await Promise.all([
    c.db.select('product_variants', { where: { business_id: biz, is_active: true, ...only }, orderBy: [['sort_order', 'ASC']] }),
    c.db.select('product_addons', { where: { business_id: biz, is_active: true, ...only }, orderBy: [['sort_order', 'ASC']] }),
    list ? c.db.select('product_prices', { where: { business_id: biz, price_list_id: list.ROWID, ...only } }) : Promise.resolve([] as Row[]),
    o.withStock !== false ? c.db.select('branch_stock', { where: { business_id: biz, ...only } }) : Promise.resolve([] as Row[]),
    anyBatches ? c.db.select('stock_batches', { where: { business_id: biz, qty_left_milli: { gt: 0 }, ...only } }) : Promise.resolve([] as Row[]),
    mediaMap(c, rows.map((r) => str(r.image_media_id))),
  ])
  const by = <T extends Row>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = str(x.product_id); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]) } return m }
  const V = by(variants), A = by(addons), S = by(stock), B = by(batches)
  // Wholesale price by product, then by variant ('' = the product's own); the first row wins, as before.
  const P = new Map<string, Map<string, Value>>()
  for (const x of prices) {
    const k = str(x.product_id), v = x.variant_id == null ? '' : str(x.variant_id)
    let m = P.get(k); if (!m) P.set(k, (m = new Map()))
    if (!m.has(v)) m.set(v, x.price_minor)
  }
  return rows.map((r) => {
    const stockByBranch: Record<string, number> = {}
    for (const s of S.get(r.ROWID) ?? []) stockByBranch[str(s.branch_id)] = fromMilli(s.qty_milli)
    const pp = P.get(r.ROWID)
    const trackExpiry = !!r.track_batches
    let nextExpiry: string | null = null
    if (trackExpiry) for (const b of B.get(r.ROWID) ?? []) { const d = str(b.expiry_date); if (d && inScope.has(str(b.branch_id)) && (nextExpiry === null || d < nextExpiry)) nextExpiry = d }
    const p: Product = {
      id: r.ROWID, businessId: biz, name: str(r.name), categoryId: strOrNull(r.category_id), kind: nameOf(E.ProductKind, r.kind) as Product['kind'],
      emoji: str(r.emoji), ...imageOf(c, media.get(str(r.image_media_id))),
      sku: str(r.sku), barcode: str(r.barcode), unit: str(r.unit) || 'pc', price: fromMinor(r.price_minor), mrp: fromMinorOrNull(r.mrp_minor),
      costPrice: o.forCustomers ? 0 : fromMinor(r.cost_minor), wholesalePrice: fromMinorOrNull(pp?.get('')),
      variants: (V.get(r.ROWID) ?? []).map((v): Variant => ({ id: v.ROWID, name: str(v.name), price: fromMinor(v.price_minor), wholesalePrice: fromMinorOrNull(pp?.get(v.ROWID)) })),
      addOns: (A.get(r.ROWID) ?? []).map((a): AddOn => ({ id: a.ROWID, name: str(a.name), price: fromMinor(a.price_minor) })),
      taxRateId: strOrNull(r.tax_rate_id), trackStock: !!r.track_stock, trackExpiry, nextExpiry,
      stockByBranch, stock: Math.round(branches.reduce((n, b) => n + (stockByBranch[b] ?? 0), 0) * 1000) / 1000,
      lowStockAt: fromMilli(r.low_stock_milli), isVeg: r.is_veg !== false, sendToKitchen: r.sends_to_kitchen !== false, active: r.is_active !== false,
      ...(r.details_json ? { details: cleanDetails(json(r.details_json, null)) } : {}),
      hsn: strOrNull(r.hsn_code),
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
  // Prices: real numbers from 0 to ₹1 crore (never negative).
  if (p.price !== undefined) out.price_minor = toMinor(money(p.price, 'Price'))
  if (p.mrp !== undefined) out.mrp_minor = p.mrp == null ? null : toMinor(money(p.mrp, 'MRP'))
  if (p.costPrice !== undefined) out.cost_minor = toMinor(money(p.costPrice ?? 0, 'Cost price'))
  if (p.taxRateId !== undefined) out.tax_rate_id = p.taxRateId || null
  if (p.trackStock !== undefined) out.track_stock = !!p.trackStock
  if (p.trackExpiry !== undefined) out.track_batches = !!p.trackExpiry
  if (p.lowStockAt !== undefined) out.low_stock_milli = toMilli(p.lowStockAt ?? 0)
  if (p.isVeg !== undefined) out.is_veg = !!p.isVeg
  if (p.sendToKitchen !== undefined) out.sends_to_kitchen = !!p.sendToKitchen
  if (p.active !== undefined) out.is_active = !!p.active
  if (p.details !== undefined) { const d = cleanDetails(p.details); out.details_json = d ? JSON.stringify(d) : null }
  if (p.hsn !== undefined) {
    const h = cleanHsn(p.hsn)
    if (hsnError(h)) throw new ApiError(hsnError(h))
    out.hsn_code = h || null
  }
  return out
}

/** Sync sizes, add-ons and contractor prices of one product to what the form sent. */
export async function syncOptions(c: Ctx, productId: string, p: Partial<Product>) {
  const biz = c.businessId
  // Sizes, add-ons and wholesale prices: lists, and every price a real number from 0 to ₹1 crore.
  if ((p.variants != null && !Array.isArray(p.variants)) || (p.addOns != null && !Array.isArray(p.addOns))) throw new ApiError('Check the sizes and add-ons')
  for (const v of p.variants ?? []) { money(v.price ?? 0, 'Size price'); if (v.wholesalePrice != null) money(v.wholesalePrice, 'Wholesale price') }
  for (const a of p.addOns ?? []) money(a.price ?? 0, 'Add-on price')
  if (p.wholesalePrice != null) money(p.wholesalePrice, 'Wholesale price')
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

/** Cost price is for people who manage products / stock or may see profit; everyone else gets 0. */
export const canSeeCost = (c: Ctx) => c.can('products.manage') || c.can('inventory.manage') || c.can('reports.profit')
export const withCostFor = <T extends { costPrice?: number }>(c: Ctx, list: T[]): T[] => (canSeeCost(c) ? list : list.map((p) => ({ ...p, costPrice: 0 })))
/** What a customer's phone may see of a product (QR menu, TV board): no cost or wholesale prices. */
export const forCustomers = <T extends { costPrice?: number; wholesalePrice?: number | null }>(p: T): T => ({ ...p, costPrice: 0, wholesalePrice: null })


// ---------- the light product index (large shops; src/core/catalogIndex.ts) ----------
// One compact row per product, built from only the columns it needs, in ONE round trip per page (raw SQL, one
// database per shop). Stock is the current view's branches; cost only for those who may see it (as products.page).
const LIGHT_COLS = '"id", "name", "category_id", "sort_order", "price_minor", "mrp_minor", "unit", "tax_rate_id", "barcode", "sku", "is_active", "track_stock", "is_veg", "sends_to_kitchen", "kind", "track_batches", "low_stock_milli", "image_media_id", "cost_minor", "emoji", "hsn_code", "updated_at"'
type Sql = { sql: string; args: (string | number | null)[] }

/** The products to put in the index, chosen by `pick` (an id range, or a list of ids) → light rows + the database's time. */
async function lightRowsWhere(c: Ctx, pick: { sql: string; args: (string | number | null)[] }, idsOf: 'range' | 'list', ids?: number[], limit?: number): Promise<{ rows: LightRow[]; dbNow: string; lastId: number | null }> {
  const db = c.db
  const biz = Number(c.businessId)
  const list = await wholesaleList(c)
  const branches = c.scope().map(Number)
  const bIn = branches.map(() => '?').join(', ')
  // The product rows decide the id range the other reads cover.
  const [prows, nowRows] = await db.sqlReads!([
    { sql: `SELECT ${LIGHT_COLS} FROM "products" WHERE "business_id" = ? AND ${pick.sql} ORDER BY "id" LIMIT ?`, args: [biz, ...pick.args, limit ?? 100000] },
    { sql: `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 seconds') AS now`, args: [] },
  ])
  const dbNow = String(nowRows[0]?.now ?? new Date(Date.now() - 2000).toISOString())
  if (!prows.length) return { rows: [], dbNow, lastId: null }
  const pids = prows.map((r) => Number(r.id))
  const lo = pids[0], hi = pids[pids.length - 1]
  // Extras for exactly these products: by id range for a page, by id list for changes.
  const of = (col: string): Sql => (idsOf === 'range' ? { sql: `"${col}" >= ? AND "${col}" <= ?`, args: [lo, hi] } : { sql: `"${col}" IN (${(ids ?? pids).map(() => '?').join(', ')})`, args: ids ?? pids })
  const st = of('product_id')
  const reads: Sql[] = [
    { sql: `SELECT "product_id", "branch_id", "qty_milli" FROM "branch_stock" WHERE "business_id" = ? AND ${st.sql}${branches.length ? ` AND "branch_id" IN (${bIn})` : ''}`, args: [biz, ...st.args, ...branches] },
    { sql: `SELECT "product_id", COUNT(*) AS n, MIN("price_minor") AS lo FROM "product_variants" WHERE "business_id" = ? AND "is_active" = 1 AND ${st.sql} GROUP BY "product_id"`, args: [biz, ...st.args] },
    { sql: `SELECT "product_id", COUNT(*) AS n FROM "product_addons" WHERE "business_id" = ? AND "is_active" = 1 AND ${st.sql} GROUP BY "product_id"`, args: [biz, ...st.args] },
    // Next expiry in the view's branches (only products that track batches have any).
    { sql: `SELECT "product_id", MIN("expiry_date") AS d FROM "stock_batches" WHERE "business_id" = ? AND "qty_left_milli" > 0 AND "expiry_date" IS NOT NULL AND ${st.sql}${branches.length ? ` AND "branch_id" IN (${bIn})` : ''} GROUP BY "product_id"`, args: [biz, ...st.args, ...branches] },
  ]
  if (list) reads.push({ sql: `SELECT "product_id", "price_minor" FROM "product_prices" WHERE "business_id" = ? AND "price_list_id" = ? AND "variant_id" IS NULL AND ${st.sql}`, args: [biz, Number(list.ROWID), ...st.args] })
  const mediaIds = [...new Set(prows.map((r) => r.image_media_id).filter((x) => x != null).map(Number))]
  if (mediaIds.length) reads.push({ sql: `SELECT "id", "bucket", "object_key", "thumb_key" FROM "media_files" WHERE "business_id" = ? AND "id" IN (${mediaIds.map(() => '?').join(', ')})`, args: [biz, ...mediaIds] })
  const res = await db.sqlReads!(reads)
  const [stockR, varR, addR, expR] = res
  const priceR = list ? res[4] : []
  const mediaR = mediaIds.length ? res[list ? 5 : 4] : []
  const expiry = new Map(expR.map((x) => [String(x.product_id), x.d == null ? null : String(x.d)]))
  const stock = new Map<string, Record<string, number>>()
  for (const s of stockR) { const k = String(s.product_id); const m = stock.get(k) ?? {}; m[String(s.branch_id)] = Number(s.qty_milli) / 1000; stock.set(k, m) }
  const vars = new Map(varR.map((v) => [String(v.product_id), { n: Number(v.n), lo: v.lo == null ? null : Number(v.lo) / 100 }]))
  const adds = new Map(addR.map((a) => [String(a.product_id), Number(a.n)]))
  const whole = new Map(priceR.map((p) => [String(p.product_id), Number(p.price_minor) / 100]))
  const media = new Map(mediaR.map((m) => [String(m.id), { ROWID: String(m.id), bucket: m.bucket, object_key: m.object_key, thumb_key: m.thumb_key } as unknown as Row]))
  const cost = canSeeCost(c)
  const rows = prows.map((r): LightRow => {
    const id = String(r.id)
    const sb = stock.get(id) ?? {}
    const total = Math.round(Object.values(sb).reduce((a, v) => a + v, 0) * 1000) / 1000
    const img = r.image_media_id == null ? { imageUrl: null, thumbUrl: null } : imageOf(c, media.get(String(r.image_media_id)))
    const v = vars.get(id)
    const flags = (r.is_active ? LF.active : 0) | (r.track_stock ? LF.trackStock : 0) | (r.is_veg !== 0 ? LF.isVeg : 0) | (r.sends_to_kitchen !== 0 ? LF.sendToKitchen : 0)
      | (r.track_batches ? LF.trackExpiry : 0) | (Number(r.kind) === E.ProductKind.service ? LF.service : 0)
    return [id, String(r.name ?? ''), r.category_id == null ? null : String(r.category_id), Number(r.sort_order ?? 0), Number(r.price_minor ?? 0) / 100,
      r.mrp_minor == null ? null : Number(r.mrp_minor) / 100, String(r.unit || 'pc'), r.tax_rate_id == null ? null : String(r.tax_rate_id), String(r.barcode ?? ''), String(r.sku ?? ''), flags,
      total, sb, Number(r.low_stock_milli ?? 0) / 1000, img.thumbUrl, img.imageUrl, whole.get(id) ?? null, cost ? Number(r.cost_minor ?? 0) / 100 : 0,
      String(r.emoji ?? ''), r.hsn_code == null ? null : String(r.hsn_code), v?.n ?? 0, adds.get(id) ?? 0, v?.lo ?? null, String(r.updated_at),
      r.track_batches ? expiry.get(id) ?? null : null]
  })
  return { rows, dbNow, lastId: hi }
}

/** One page of the whole index, in id order: `after` = the last id of the previous page ('' for the first). */
export async function lightIndexPage(c: Ctx, after: string | null): Promise<IndexPage> {
  const from = /^\d{1,16}$/.test(String(after ?? '')) ? Number(after) : 0
  const { rows, dbNow } = await lightRowsWhere(c, { sql: '"id" > ?', args: [from] }, 'range', undefined, INDEX_PAGE + 1)
  const more = rows.length > INDEX_PAGE
  const page = more ? rows.slice(0, INDEX_PAGE) : rows
  return { rows: page, next: more ? page[page.length - 1][L.id] : null, at: dbNow }
}

/** These products (≤ 100) as light products, in the order of `ids` — Inventory's pages. */
export async function lightProducts(c: Ctx, ids: number[]): Promise<Product[]> {
  if (!ids.length) return []
  const { rows } = await lightRowsWhere(c, { sql: `"id" IN (${ids.map(() => '?').join(', ')})`, args: ids }, 'list', ids)
  const by = new Map(rows.map((r) => [r[L.id], r]))
  return ids.flatMap((id) => { const r = by.get(String(id)); return r ? [fromLightRow(r, c.businessId)] : [] })
}

/** What changed since `since` (a time the server gave): products edited, or whose stock moved, in the view's branches. */
export async function lightChangesSince(c: Ctx, since: string): Promise<IndexPage> {
  const biz = Number(c.businessId)
  const branches = c.scope().map(Number)
  const [ed, mv] = await c.db.sqlReads!([
    { sql: 'SELECT "id" FROM "products" WHERE "business_id" = ? AND "updated_at" > ? LIMIT ?', args: [biz, since, INDEX_MAX_CHANGES + 1] },
    { sql: `SELECT DISTINCT "product_id" FROM "branch_stock" WHERE "business_id" = ? AND "updated_at" > ?${branches.length ? ` AND "branch_id" IN (${branches.map(() => '?').join(', ')})` : ''} LIMIT ?`, args: [biz, since, ...branches, INDEX_MAX_CHANGES + 1] },
  ])
  const ids = [...new Set([...ed.map((r) => Number(r.id)), ...mv.map((r) => Number(r.product_id))])].sort((a, b) => a - b)
  if (ids.length > INDEX_MAX_CHANGES) return { rows: [], next: null, at: since, reset: true }
  if (!ids.length) {
    const [now] = await c.db.sql!(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 seconds') AS now`)
    return { rows: [], next: null, at: String(now?.now ?? since) }
  }
  const all: LightRow[] = []
  let at = since
  // In parts, so a burst of changes never makes one answer big.
  for (let i = 0; i < ids.length; i += INDEX_PAGE) {
    const part = ids.slice(i, i + INDEX_PAGE)
    const r = await lightRowsWhere(c, { sql: `"id" IN (${part.map(() => '?').join(', ')})`, args: part }, 'list', part)
    all.push(...r.rows)
    if (i === 0) at = r.dbNow
  }
  return { rows: all, next: null, at }
}
