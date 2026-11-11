// Categories, products (save, CSV import, in-store barcodes), photos and daily specials.
import { MAX_BILL_ITEMS } from '@/core/limits'
import { CATALOG_FULL_MAX } from '@/core/catalogIndex'
import { randomBytes } from 'node:crypto'
import { templateFor } from '@/core/config'
import type { ImportItem } from '@/core/productImport'
import { cleanHsn, hsnError } from '@/core/gst'
import { cleanDetails } from '@/core/stickers'
import { planDesign, planDiscount, type DesignInput, type DiscountInput } from '@/core/textile'
import type { Category, Product, Special } from '@/core/types'
import { nextInStoreBarcode } from '@/lib/barcode'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { selectIn } from '../domain/orders'
import { mediaLink, PRIVATE_PREFIX } from '../core/media'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row } from '../db/types'
import { categoryFrom, lightChangesSince, lightIndexPage, loadCategories, loadProductPage, loadProducts, mediaMap, productColumns, syncOptions, wholesaleList, withCostFor } from '../domain/catalog'
import { moveStock, moveStockMany, stockProduct, type BatchInput } from '../domain/stock'
import { audit, bizDay, E, fromMinor, fromMinorOrNull, isId, json, keyPart, own, str, toMilli, toMinor, money, quantity } from '../domain/util'

/** Products per products.page answer (keeps one answer's CPU small for 2,000-item shops). */
export const PRODUCT_PAGE = 300

// ---------- photos ----------
const LIMITS = { product: { main: 51_200, thumb: 20_480 }, category: { main: 51_200, thumb: 20_480 }, ticket: { main: 204_800, thumb: 0 }, poster: { main: 204_800, thumb: 0 }, logo: { main: 81_920, thumb: 0 } } as const
type Purpose = keyof typeof LIMITS

function decodeImage(dataUrl: string, max: number) {
  const m = /^data:(image\/(webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
  if (!m) throw new ApiError('That file is not a supported image')
  const buf = Buffer.from(m[3], 'base64')
  const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8
  const isPng = buf[0] === 0x89 && buf[1] === 0x50
  if (!(isWebp || isJpeg || isPng)) throw new ApiError('That file is not a supported image')
  // Only compressed images are ever stored — whatever a client sends.
  if (buf.length > max) throw new ApiError(`Image is too large after compression (${Math.round(buf.length / 1024)} KB, the limit is ${Math.round(max / 1024)} KB)`)
  return { buf, type: m[1], ext: m[2] === 'jpeg' ? 'jpg' : m[2] }
}

/** Saves a browser-compressed image (and its thumbnail) to Stratus and records it in media_files. */
export async function storeImage(c: Ctx, purpose: Purpose, input: { image: string; thumb?: string | null; width?: number; height?: number; quality?: number; originalBytes?: number }) {
  const lim = LIMITS[purpose]
  const main = decodeImage(input.image, lim.main)
  const id = randomBytes(9).toString('hex')
  // Support screenshots go to the private store when there is one (L9): shown only through short-lived signed links.
  const priv = purpose === 'ticket' && c.files.hasPrivate
  const key = `${priv ? PRIVATE_PREFIX : ''}${c.businessId}/${purpose}s/${id}.${main.ext}`
  let url: string
  if (priv) { await c.files.putPrivate(key, main.buf, main.type); url = mediaLink(key, c.now.getTime()) } else url = await c.files.put(key, main.buf, main.type)
  let thumbKey: string | null = null, thumbUrl: string | null = null
  if (input.thumb && lim.thumb) {
    const t = decodeImage(input.thumb, lim.thumb)
    thumbKey = `${c.businessId}/${purpose}s/${id}_t.${t.ext}`
    thumbUrl = await c.files.put(thumbKey, t.buf, t.type)
  }
  // Ticket screenshots are kept with the tickets (platform database); product photos in the shop's.
  const row = await (purpose === 'ticket' ? c.platform : c.db).insert('media_files', {
    business_id: c.businessId, purpose: E.MediaPurpose[purpose], bucket: priv ? process.env.STRATUS_PRIVATE_BUCKET || 'private' : process.env.STRATUS_BUCKET || 'local', object_key: key, thumb_key: thumbKey,
    content_type: main.type, bytes: main.buf.length, width: input.width ? Math.round(input.width) : null, height: input.height ? Math.round(input.height) : null,
    original_bytes: input.originalBytes ? Math.round(input.originalBytes) : null, created_by: purpose === 'ticket' ? null : c.actorId,
  })
  return { id: row.ROWID, url, thumbUrl, bytes: main.buf.length }
}

/** The media row for an image URL the app sends back on save. Only this business's own files are accepted. */
async function mediaIdFor(c: Ctx, url: string | null | undefined, purpose: Purpose): Promise<string | null> {
  if (!url) return null
  const key = c.files.keyOf(url)
  if (key) {
    if (!key.startsWith(`${c.businessId}/`)) throw new ApiError('That photo belongs to another account')
    const r = await c.db.first('media_files', { object_key: key, business_id: c.businessId })
    if (!r) throw new ApiError('Upload the photo again')
    return r.ROWID
  }
  // A photo link from a CSV that couldn't be downloaded: kept as a link (like the app does).
  if (/^https:\/\/[^\s'"\\]{4,240}$/.test(url)) {
    const ex = await c.db.first('media_files', { object_key: url, business_id: c.businessId })
    if (ex) return ex.ROWID
    return (await c.db.insert('media_files', { business_id: c.businessId, purpose: E.MediaPurpose[purpose], bucket: 'external', object_key: url, content_type: 'image/*', bytes: 0, created_by: c.actorId })).ROWID
  }
  throw new ApiError('Upload the photo again')
}

// ---------- products ----------
const cleanBarcode = (s: string | undefined) => String(s ?? '').trim().replace(/[^0-9A-Za-z._-]/g, '').slice(0, 40)

async function barcodeTaken(c: Ctx, barcode: string, selfId?: string) {
  if (!barcode) return null
  const hit = await c.db.first('products', { barcode_key: `${c.businessId}:${barcode}` })
  return hit && hit.ROWID !== selfId ? hit : null
}

const one = async (c: Ctx, id: string) => (await loadProducts(c, { ids: [id] }))[0]

define('categories', {
  list: userRead(async (c) => loadCategories(c)),
  save: userWrite(async (c, input: Partial<Category> & { name: string }) => {
    const name = String(input.name ?? '').trim()
    if (!name) throw new ApiError('Enter a name')
    const img = input.imageUrl !== undefined ? await mediaIdFor(c, input.imageUrl, 'category') : undefined
    const hsn = input.hsn !== undefined ? cleanHsn(input.hsn) : undefined
    if (hsn && hsnError(hsn)) throw new ApiError(hsnError(hsn))
    const data = { name: name.slice(0, 80), uniq_key: `${c.businessId}:${keyPart(name)}`, ...(input.emoji !== undefined ? { emoji: (input.emoji || '').slice(0, 8) || null } : {}), ...(img !== undefined ? { image_media_id: img } : {}), ...(hsn !== undefined ? { hsn_code: hsn || null } : {}) }
    let row: Row
    try {
      if (input.id) { await own(c, 'categories', input.id, 'Category not found'); row = await c.db.update('categories', input.id, { ...data, is_active: true }) }
      else row = await c.db.insert('categories', { business_id: c.businessId, ...data, sort_order: await c.db.count('categories', { business_id: c.businessId }), is_active: true })
    } catch (e) { if (e instanceof DuplicateError) throw new ApiError(`A category called ${name} already exists`); throw e }
    return categoryFrom(c, row, await mediaMap(c, [str(row.image_media_id)]))
  }, { perm: 'products.manage' }),
  remove: userWrite(async (c, id: string) => {
    const cat = await own(c, 'categories', id, 'Category not found')
    if (await c.db.first('products', { business_id: c.businessId, category_id: cat.ROWID })) throw new ApiError('Move or delete the items in this category first')
    await c.db.delete('categories', cat.ROWID)
  }, { perm: 'products.manage' }),
})

/**
 * What a new design checks against, in one light read: the items with details (planDesign's duplicate check — same
 * `active` and `details` as the full read) and the in-store codes (nextInStoreBarcode only looks at 20… codes, so the
 * next code is the same as from every product's barcode).
 */
async function designChecks(c: Ctx) {
  const rows = await c.db.sql!(`SELECT "is_active" AS active, "details_json" AS details, "barcode" AS barcode FROM "products"
    WHERE "business_id" = ? AND ("details_json" IS NOT NULL OR "barcode" GLOB '20*')`, [Number(c.businessId)])
  return {
    existing: rows.filter((r) => r.details).map((r) => ({ active: r.active == null || Number(r.active) !== 0, details: cleanDetails(json(r.details as string, null)) ?? undefined })),
    codes: rows.map((r) => str(r.barcode as string | null)),
  }
}

/**
 * The items a discount may touch, with only what planDiscount reads (id, category, MRP, price, sizes, active), in the
 * product list's order (sort order, then id) — the same items and values as the full read. Narrowed in SQL to the
 * chosen items or category (planDiscount picks the same ones again).
 */
async function discountItems(c: Ctx, input: DiscountInput) {
  const sql = c.db.sql!.bind(c.db)
  const bid = Number(c.businessId)
  const only = input?.productIds?.length ? [...new Set(input.productIds.map(String).filter(isId))] : null
  const head = `SELECT p."id" AS id, p."sort_order" AS so, p."category_id" AS cat, p."mrp_minor" AS mrp, p."price_minor" AS price, p."is_active" AS active,
    (SELECT COUNT(*) FROM "product_variants" v WHERE v."business_id" = ? AND v."product_id" = p."id" AND v."is_active" = 1) AS sizes
    FROM "products" p WHERE p."business_id" = ?`
  const order = ` ORDER BY p."sort_order" ASC, p."id" ASC`
  let rows: Record<string, unknown>[] = []
  if (only) { for (let i = 0; i < only.length; i += 500) { const part = only.slice(i, i + 500).map(Number); rows.push(...await sql(`${head} AND p."id" IN (${part.map(() => '?').join(', ')})${order}`, [bid, bid, ...part])) } }
  else if (input?.categoryId) rows = await sql(`${head} AND p."category_id" = ?${order}`, [bid, bid, Number(input.categoryId)])
  else rows = await sql(`${head}${order}`, [bid, bid])
  // More than 500 chosen items: read in parts, so put them back in the list's order (sort order, then id).
  if (only && only.length > 500) rows.sort((a, b) => Number(a.so ?? 0) - Number(b.so ?? 0) || Number(a.id) - Number(b.id))
  const items = rows.map((r) => ({
    id: String(r.id), categoryId: r.cat == null ? null : String(r.cat), mrp: fromMinorOrNull(r.mrp as number | null), price: fromMinor(r.price as number | null),
    variants: new Array(Number(r.sizes ?? 0)), active: Number(r.active) !== 0,
  }))
  return items
}

/** New prices, 100 items per UPDATE, all in one request (all or nothing; inside a transaction, part of it). */
async function setPrices(c: Ctx, changes: { id: string; minor: number }[]) {
  const bid = Number(c.businessId)
  const stmts: { sql: string; args: (string | number | null)[] }[] = []
  for (let i = 0; i < changes.length; i += 100) {
    const part = changes.slice(i, i + 100)
    stmts.push({
      sql: `UPDATE "products" SET "price_minor" = CASE "id" ${part.map(() => 'WHEN ? THEN ?').join(' ')} END, "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE "business_id" = ? AND "id" IN (${part.map(() => '?').join(', ')})`,
      args: [...part.flatMap((x) => [Number(x.id), x.minor]), bid, ...part.map((x) => Number(x.id))],
    })
  }
  await c.db.sqlMany!(stmts)
}

define('products', {
  /**
   * The catalogue in pages (the browser joins them, so each answer stays small): `after` = where the last page
   * ended (0 for the first). Catalyst Data Store: the whole list in one page.
   */
  page: userRead(async (c, after?: number, opts?: { checkLarge?: boolean }) => {
    if (!c.dbs.perShop) return { rows: withCostFor(c, await loadProducts(c)), next: null }
    // A sane page start (a huge number can't be a page of this shop: the database would refuse it).
    const at = Math.min(1_000_000_000, Math.max(0, Math.floor(Number(after) || 0)))
    // checkLarge (a device's first read): a large shop (more than CATALOG_FULL_MAX products) is told so at once —
    // its app reads the light index instead — without building a page it would not use. One row past the limit is
    // enough to know (the products aren't counted).
    if (at === 0 && opts?.checkLarge === true) {
      const past = await c.db.select('products', { where: { business_id: c.businessId }, limit: 1, offset: CATALOG_FULL_MAX })
      if (past.length) return { rows: [], next: null, large: true }
    }
    const page = await loadProductPage(c, at, PRODUCT_PAGE)
    // The first page also says how many there are: a large shop's app switches to the light index (catalogIndex.ts).
    const total = at === 0 && page.next !== null ? await c.db.count('products', { business_id: c.businessId }) : undefined
    return { rows: withCostFor(c, page.rows), next: page.next, ...(total !== undefined ? { total } : {}) }
  }),

  /**
   * The light product index of a large shop (src/core/catalogIndex.ts), one database per shop only:
   * `{ after }` = the whole index in pages (id order); `{ since }` = only what changed after that time.
   */
  index: userRead(async (c, input?: { after?: string | null; since?: string | null; stockOnly?: boolean }) => {
    if (!c.dbs.perShop) throw new ApiError('The product index is not used on this setup')
    const since = input?.since
    if (since != null) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(String(since))) throw new ApiError('Bad time')
      return lightChangesSince(c, String(since), input?.stockOnly === true)
    }
    return lightIndexPage(c, input?.after ?? null)
  }),

  /**
   * One active product by barcode (or SKU): a large shop's scan that isn't in the device's index yet (added on
   * another device a moment ago). null = not found.
   */
  byBarcode: userRead(async (c, code: string) => {
    const s = String(code ?? '').trim()
    if (!s || s.length > 40) return null
    const hit = (await c.db.first('products', { barcode_key: `${c.businessId}:${s}` })) ?? (await c.db.first('products', { business_id: c.businessId, sku: s }))
    if (!hit || hit.is_active === false) return null
    return withCostFor(c, await loadProducts(c, { ids: [hit.ROWID] }))[0] ?? null
  }),

  /** Full products (variants, add-ons, details, photos) for items opened from the light index — up to 100 at a time. */
  byIds: userRead(async (c, ids: string[]) => {
    const want = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((x) => isId(x)))]
    if (want.length > 100) throw new ApiError('Up to 100 products at a time')
    if (!want.length) return []
    return withCostFor(c, await loadProducts(c, { ids: want }))
  }),

  save: userWrite(async (c, input: Partial<Product> & { name: string; openingBatch?: BatchInput }) => {
    if (!String(input.name ?? '').trim()) throw new ApiError('Name is required')
    const barcode = input.barcode !== undefined ? cleanBarcode(input.barcode) : undefined
    const dup = barcode ? await barcodeTaken(c, barcode, input.id) : null
    if (dup) throw new ApiError(`Barcode ${barcode} is already used by ${str(dup.name)}`)
    if (input.categoryId) await own(c, 'categories', input.categoryId, 'Choose a category')
    if (input.taxRateId) await own(c, 'tax_rates', input.taxRateId, 'Choose a tax rate')
    const img = input.imageUrl !== undefined ? await mediaIdFor(c, input.imageUrl, 'product') : undefined
    const cols = {
      ...productColumns(input),
      ...(barcode !== undefined ? { barcode: barcode || null, barcode_key: barcode ? `${c.businessId}:${barcode}` : null } : {}),
      ...(img !== undefined ? { image_media_id: img } : {}),
    }
    if (input.id) {
      const ex = await own(c, 'products', input.id, 'Product not found')
      // Stock changes only through movements — never by editing the product.
      await c.db.update('products', ex.ROWID, cols)
      await syncOptions(c, ex.ROWID, input)
      await audit(c, 'product', ex.ROWID, 'update', input.name)
      return one(c, ex.ROWID)
    }
    const row = await c.db.insert('products', {
      business_id: c.businessId, kind: E.ProductKind.goods, unit: 'pc', price_minor: 0, cost_minor: 0, track_stock: false, track_batches: false,
      is_veg: true, sends_to_kitchen: true, is_active: true, sort_order: 0, ...cols,
    })
    await syncOptions(c, row.ROWID, { ...input, variants: input.variants ?? [], addOns: input.addOns ?? [] })
    if (row.track_stock && (input.stock ?? 0) > 0) {
      await moveStock(c, stockProduct(row), c.writeBranch({ fallback: true }), Number(input.stock), 'opening', { note: 'Opening stock', batch: input.openingBatch })
    }
    await audit(c, 'product', row.ROWID, 'create', input.name)
    return one(c, row.ROWID)
  }, { perm: 'products.manage' }),

  /**
   * Import many products at once (from CSV). Existing products (same barcode, otherwise same name) are
   * skipped or updated. New rows are written in batches of 200.
   */
  importMany: userWrite(async (c, rows: (ImportItem & { row: number })[], opts: { onExisting: 'skip' | 'update'; fileName: string }) => {
    if (!Array.isArray(rows) || !rows.length) throw new ApiError('Choose at least one row to import')
    if (rows.length > 5000) throw new ApiError('Up to 5,000 rows at a time')
    const b = c.business
    const branch = c.writeBranch({ fallback: true })
    // Validate everything first, so a bad row doesn't leave a half-done import.
    // A tax rate must be one of this shop's own (never another shop's row id).
    const shopRates = new Set((await c.db.select('tax_rates', { where: { business_id: c.businessId } })).map((r) => r.ROWID))
    const seen = new Set<string>()
    for (const it of rows) {
      if (it.taxRateId && !shopRates.has(String(it.taxRateId))) throw new ApiError(`Row ${it.row + 2}: choose one of your tax rates`)
      if (!String(it.name ?? '').trim() || !(Number(it.price) >= 0)) throw new ApiError(`Row ${it.row + 2}: name and a valid price are needed`)
      // Same limits as the product form: prices 0 … ₹1 crore, lists as lists, opening stock whole unless sold in parts.
      const at = `Row ${it.row + 2}`
      money(it.price, `${at} price`)
      if (it.mrp != null) money(it.mrp, `${at} MRP`)
      if (it.wholesalePrice != null) money(it.wholesalePrice, `${at} wholesale price`)
      if (it.costPrice != null) money(it.costPrice, `${at} cost price`)
      if ((it.variants != null && !Array.isArray(it.variants)) || (it.addOns != null && !Array.isArray(it.addOns))) throw new ApiError(`${at}: check the sizes and add-ons`)
      for (const v of it.variants ?? []) money(v.price, `${at} size price`)
      for (const a of it.addOns ?? []) money(a.price, `${at} add-on price`)
      if (it.stock != null && Number(it.stock) !== 0) quantity(it.stock, it.unit || 'pc', `${at} stock`)
      const code = cleanBarcode(it.barcode)
      if (code) { if (seen.has(code)) throw new ApiError(`Row ${it.row + 2}: barcode ${code} is used twice in the file`); seen.add(code) }
    }
    const [cats, existing] = await Promise.all([c.db.select('categories', { where: { business_id: c.businessId } }), c.db.select('products', { where: { business_id: c.businessId } })])
    const catByName = new Map(cats.map((x) => [str(x.name).trim().toLowerCase(), x.ROWID]))
    const newCats: string[] = []
    const categoryFor = async (name?: string) => {
      if (!name?.trim()) return undefined
      const k = name.trim().toLowerCase()
      let id = catByName.get(k)
      if (!id) {
        id = (await c.db.insert('categories', { business_id: c.businessId, name: name.trim().slice(0, 80), emoji: '📦', sort_order: catByName.size, is_active: true, uniq_key: `${c.businessId}:${keyPart(name)}` })).ROWID
        catByName.set(k, id); newCats.push(name.trim())
      }
      return id
    }
    const byBarcode = new Map(existing.filter((p) => p.barcode).map((p) => [str(p.barcode), p]))
    const byName = new Map(existing.map((p) => [str(p.name).trim().toLowerCase(), p]))
    const tpl = templateFor(b.category)
    let created = 0, updated = 0
    const skippedRows: number[] = []
    const fresh: { it: ImportItem & { row: number }; cols: Record<string, string | number | boolean | null> }[] = []
    for (const it of rows) {
      const name = it.name.trim()
      const code = cleanBarcode(it.barcode)
      const ex = (code && byBarcode.get(code)) || byName.get(name.toLowerCase())
      const img = it.imageUrl ? await mediaIdFor(c, it.imageUrl, 'product').catch(() => null) : undefined
      const categoryId = await categoryFor(it.categoryName)
      if (ex) {
        if (opts.onExisting === 'skip') { skippedRows.push(it.row); continue }
        const patch: Partial<Product> = { name, price: it.price }
        const set = <K extends keyof Product>(k: K, v: Product[K] | undefined) => { if (v !== undefined) patch[k] = v }
        set('categoryId', categoryId); set('mrp', it.mrp); set('wholesalePrice', it.wholesalePrice); set('costPrice', it.costPrice); set('sku', it.sku); set('hsn', it.hsn)
        set('unit', it.unit); set('taxRateId', it.taxRateId); set('isVeg', it.isVeg); set('trackStock', it.trackStock); set('lowStockAt', it.lowStockAt)
        set('trackExpiry', it.trackExpiry); set('sendToKitchen', it.sendToKitchen); set('kind', it.kind); set('active', it.active)
        if (it.variants) patch.variants = it.variants.map((v) => ({ id: '', name: v.name, price: v.price }))
        if (it.addOns) patch.addOns = it.addOns.map((v) => ({ id: '', name: v.name, price: v.price }))
        await c.db.update('products', ex.ROWID, { ...productColumns(patch), ...(code ? { barcode: code, barcode_key: `${c.businessId}:${code}` } : {}), ...(img !== undefined ? { image_media_id: img } : {}) })
        await syncOptions(c, ex.ROWID, patch)
        updated++
        continue // stock of existing items changes only through Inventory, never by re-importing
      }
      const service = it.kind === 'service'
      const p: Partial<Product> = {
        name, categoryId: categoryId ?? null, kind: it.kind ?? (b.category === 'service' ? 'service' : 'goods'), mrp: it.mrp ?? null, sku: it.sku ?? '', hsn: it.hsn ?? null,
        unit: it.unit || (service ? 'service' : tpl.units[0] ?? 'pc'), price: it.price, costPrice: it.costPrice ?? 0, taxRateId: it.taxRateId ?? null,
        trackStock: !service && (it.trackStock ?? b.category === 'retail'), trackExpiry: it.trackExpiry ?? false, lowStockAt: it.lowStockAt ?? (b.category === 'retail' ? 5 : 0),
        isVeg: it.isVeg ?? true, sendToKitchen: it.sendToKitchen ?? (b.category === 'food' || b.category === 'restaurant'), active: it.active ?? true,
      }
      fresh.push({ it, cols: { business_id: c.businessId, sort_order: 0, ...productColumns(p), ...(code ? { barcode: code, barcode_key: `${c.businessId}:${code}` } : {}), image_media_id: img ?? null } })
      byName.set(name.toLowerCase(), {} as Row)
    }
    // New products in batches; then their sizes, add-ons, contractor prices and opening stock in batches too.
    const made = fresh.length ? await c.db.insertMany('products', fresh.map((f) => f.cols)) : []
    const list = made.some((_, i) => fresh[i].it.wholesalePrice) ? await wholesaleList(c) : null
    const variants: Record<string, string | number | boolean | null>[] = [], addons: typeof variants = [], prices: typeof variants = [], stockRows: typeof variants = [], moves: typeof variants = [], batches: typeof variants = []
    made.forEach((row, i) => {
      const it = fresh[i].it
      it.variants?.forEach((v, k) => variants.push({ business_id: c.businessId, product_id: row.ROWID, name: v.name.slice(0, 60), price_minor: toMinor(v.price) ?? 0, sort_order: k, is_active: true }))
      it.addOns?.forEach((v, k) => addons.push({ business_id: c.businessId, product_id: row.ROWID, name: v.name.slice(0, 60), price_minor: toMinor(v.price) ?? 0, sort_order: k, is_active: true }))
      if (list && it.wholesalePrice && it.wholesalePrice > 0) prices.push({ business_id: c.businessId, price_list_id: list.ROWID, product_id: row.ROWID, variant_id: null, price_minor: toMinor(it.wholesalePrice), uniq_key: `${list.ROWID}:${row.ROWID}:0` })
      if (row.track_stock && (it.stock ?? 0) > 0) {
        const q = toMilli(Number(it.stock))
        stockRows.push({ business_id: c.businessId, branch_id: branch, product_id: row.ROWID, qty_milli: q, uniq_key: `${branch}:${row.ROWID}` })
        moves.push({ business_id: c.businessId, branch_id: branch, product_id: row.ROWID, reason: E.StockReason.opening, qty_milli: q, balance_milli: q, note: 'Opening stock (import)', created_by: c.userId })
        if (row.track_batches) batches.push({ business_id: c.businessId, branch_id: branch, product_id: row.ROWID, batch_no: String(it.batchNo ?? '').replace(/['"\\]/g, '').slice(0, 40) || null, expiry_date: it.expiry && /^\d{4}-\d{2}-\d{2}$/.test(it.expiry) ? it.expiry : null, qty_in_milli: q, qty_left_milli: q })
        c.addStock(row.ROWID, branch, Number(it.stock))
      }
      created++
    })
    if (variants.length) await c.db.insertMany('product_variants', variants)
    if (addons.length) await c.db.insertMany('product_addons', addons)
    if (prices.length) await c.db.insertMany('product_prices', prices)
    if (stockRows.length) await c.db.insertMany('branch_stock', stockRows)
    if (moves.length) await c.db.insertMany('stock_movements', moves)
    if (batches.length) await c.db.insertMany('stock_batches', batches)
    await audit(c, 'product', null, 'import', `${created} added, ${updated} updated, ${skippedRows.length} skipped from ${String(opts.fileName ?? '').slice(0, 80)}`)
    return { created, updated, skippedRows, newCategories: newCats, photosCompressed: 0, photosLinked: 0 }
  }, { perm: 'products.manage' }),

  /**
   * Textile: one design in many colours / sizes → one item each (own code for its QR sticker, own stock).
   * Returns the new items so the app can print their stickers straight away.
   */
  saveDesign: userWrite(async (c, input: DesignInput) => {
    if (input?.categoryId) await own(c, 'categories', input.categoryId, 'Choose a category')
    if (input?.taxRateId) await own(c, 'tax_rates', input.taxRateId, 'Choose a tax rate')
    // Turso: one light read for the checks, and every item + its opening stock in a few round trips (not ~4 per
    // colour / size); otherwise as before. Same items, codes, stock and history either way, all in one transaction.
    const fast = !!(c.db.sql && c.db.sqlMany)
    const checks = fast ? await designChecks(c) : null
    const existing = checks ? checks.existing : await loadProducts(c, { withStock: false, withExpiry: false })
    let plan
    try { plan = planDesign(input, existing) } catch (e) { throw new ApiError((e as Error).message) }
    const img = input.imageUrl ? await mediaIdFor(c, input.imageUrl, 'product') : null
    const codes = checks ? checks.codes : (await c.db.select('products', { where: { business_id: c.businessId } })).map((p) => str(p.barcode))
    const branch = c.writeBranch({ fallback: true })
    const ids: string[] = []
    if (fast) {
      const rows = await c.db.insertMany('products', plan.map((p) => {
        const bc = nextInStoreBarcode(codes)
        codes.push(bc)
        return { business_id: c.businessId, sort_order: 0, track_batches: false, ...productColumns(p), barcode: bc, barcode_key: `${c.businessId}:${bc}`, image_media_id: img }
      }))
      await moveStockMany(c, rows.flatMap((row, i) => plan[i].stock > 0 ? [{ p: stockProduct(row), branchId: branch, qty: plan[i].stock, reason: 'opening' as const, opts: { note: 'Opening stock' } }] : []))
      ids.push(...rows.map((r) => r.ROWID))
    } else for (const p of plan) {
      const bc = nextInStoreBarcode(codes)
      codes.push(bc)
      const row = await c.db.insert('products', {
        business_id: c.businessId, sort_order: 0, track_batches: false, ...productColumns(p), barcode: bc, barcode_key: `${c.businessId}:${bc}`, image_media_id: img,
      })
      if (p.stock > 0) await moveStock(c, stockProduct(row), branch, p.stock, 'opening', { note: 'Opening stock' })
      ids.push(row.ROWID)
    }
    await audit(c, 'product', null, 'create', `Design ${input.design || input.name}: ${plan.length} item${plan.length === 1 ? '' : 's'}`.slice(0, 250))
    return loadProducts(c, { ids })
  }, { perm: 'products.manage' }),

  /** New selling prices = MRP less a % for a category (or chosen items). 0% = back to MRP. */
  setDiscount: userWrite(async (c, input: DiscountInput) => {
    if (input?.categoryId) await own(c, 'categories', input.categoryId, 'Choose a category')
    // Turso: only the fields the rule needs, and the new prices without reading the rows back; otherwise as before.
    const fast = !!(c.db.sql && c.db.sqlMany)
    const products = fast ? await discountItems(c, input) : await loadProducts(c, { withStock: false, withExpiry: false })
    let plan
    try { plan = planDiscount(input, products) } catch (e) { throw new ApiError((e as Error).message) }
    if (plan.changes.length) {
      if (fast) await setPrices(c, plan.changes.map((x) => ({ id: x.id, minor: toMinor(x.price) ?? 0 })))
      else await c.db.updateMany('products', plan.changes.map((x) => ({ ROWID: x.id, price_minor: toMinor(x.price) })))
    }
    const cat = input.productIds?.length ? `${input.productIds.length} items` : input.categoryId ? str((await c.db.get('categories', input.categoryId))?.name) : 'all items'
    await audit(c, 'product', null, 'update', `Discount ${Number(input.pct)}% on ${cat}: ${plan.changes.length} prices changed`.slice(0, 250))
    return { updated: plan.changes.length, ids: plan.ids, noMrp: plan.noMrp, withSizes: plan.withSizes }
  }, { perm: 'products.manage' }),

  /** Give every listed product without a barcode its own in-store EAN-13 (prefix 20), for printing labels. */
  assignBarcodes: userWrite(async (c, ids: string[]) => {
    // Only the chosen products, and the highest in-store code so far — not the whole catalogue.
    const want = [...new Set((ids ?? []).map(String))].filter((x) => isId(x))
    if (!want.length) return {}
    const rows = (await selectIn(c, 'products', 'ROWID', want, { business_id: c.businessId })).filter((x) => !str(x.barcode).trim()).sort((a, b) => Number(a.ROWID) - Number(b.ROWID))
    const out: Record<string, string> = {}
    if (!rows.length) return out
    let top = await highestInStoreBarcode(c)
    for (const p of rows) {
      // Each code is the highest + 1. The unique barcode key refuses a code someone else took at the same moment:
      // then the next free one is tried (a few times) — never a duplicate.
      for (let attempt = 0; ; attempt++) {
        const bc = nextInStoreBarcode(top ? [top] : [])
        try {
          await c.db.update('products', p.ROWID, { barcode: bc, barcode_key: `${c.businessId}:${bc}` })
          top = bc
          await audit(c, 'product', p.ROWID, 'update', `${str(p.name)}: barcode ${bc}`)
          out[p.ROWID] = bc
          break
        } catch (e) {
          if (!(e instanceof DuplicateError) || attempt >= 2) throw e
          top = (await highestInStoreBarcode(c)) ?? bc
          if (Number(top.slice(2, 12)) < Number(bc.slice(2, 12))) top = bc // never go back to a code just refused
        }
      }
    }
    return out
  }, { perm: 'products.manage' }),
})

/**
 * The highest in-store barcode used in this shop ("20" + 10 digits + check digit), or null. Turso: one read on the
 * unique barcode-key index (only the "20…" range); otherwise every product's code, as before.
 */
async function highestInStoreBarcode(c: Ctx): Promise<string | null> {
  if (c.dbs.perShop && c.db.sql) {
    const [r] = await c.db.sql(`SELECT MAX("barcode") AS b FROM "products" WHERE "barcode_key" >= ? AND "barcode_key" < ? AND "barcode" GLOB '20${'[0-9]'.repeat(11)}'`, [`${c.businessId}:20`, `${c.businessId}:21`])
    return r?.b ? String(r.b) : null
  }
  const codes = (await c.db.select('products', { where: { business_id: c.businessId } })).map((p) => str(p.barcode)).filter((x) => /^20\d{11}$/.test(x))
  return codes.length ? codes.reduce((a, b) => (Number(b.slice(2, 12)) > Number(a.slice(2, 12)) ? b : a)) : null
}

define('media', {
  /** Photo already compressed in the browser (≤ 50 KB, 320 px thumbnail). The server checks the size again. */
  store: userWrite(async (c, input: { image: string; thumb?: string; width?: number; height?: number; quality?: number; originalBytes?: number; purpose?: 'product' | 'category' }) => {
    const r = await storeImage(c, input.purpose === 'category' ? 'category' : 'product', input)
    return { url: r.url, thumbUrl: r.thumbUrl, bytes: r.bytes }
  }, { perm: 'products.manage', tx: 'none', quiet: true }),
})

// ---------- daily specials ----------
function specialFrom(r: Row): Special {
  return { id: r.ROWID, businessId: str(r.business_id), date: str(r.special_date), productId: str(r.product_id), specialPrice: fromMinorOrNull(r.offer_price_minor), tag: str(r.tag), sort: Number(r.sort_order ?? 0) }
}
export async function specialsFor(c: Ctx, businessId: string, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError('Choose a date')
  return (await c.db.select('daily_specials', { where: { business_id: businessId, special_date: date }, orderBy: [['sort_order', 'ASC']] })).map(specialFrom)
}

define('specials', {
  list: userRead(async (c, date?: string) => specialsFor(c, c.businessId, date || bizDay(c))),
  /** Replace the specials list for one day. */
  save: userWrite(async (c, date: string, rows: Omit<Special, 'id' | 'businessId' | 'date'>[]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError('Choose a date')
    if (rows != null && (!Array.isArray(rows) || rows.length > MAX_BILL_ITEMS)) throw new ApiError('Check the specials list')
    for (const r of rows ?? []) if (!isId(r?.productId)) throw new ApiError('An item in the list was not found')
    // Only the chosen items are read (not the whole catalogue): each must be this shop's.
    const want = [...new Set((rows ?? []).map((r) => String(r.productId)))]
    const prods = new Set(want.length ? (await selectIn(c, 'products', 'ROWID', want, { business_id: c.businessId })).map((p) => p.ROWID) : [])
    for (const id of want) if (!prods.has(id)) throw new ApiError('An item in the list was not found')
    for (const r of rows ?? []) if (r.specialPrice != null) money(r.specialPrice, 'Offer price')
    const old = await c.db.select('daily_specials', { where: { business_id: c.businessId, special_date: date } })
    if (old.length) await c.db.deleteMany('daily_specials', old.map((x) => x.ROWID))
    if (rows?.length) await c.db.insertMany('daily_specials', rows.map((r, i) => ({ business_id: c.businessId, branch_id: null, product_id: r.productId, special_date: date, offer_price_minor: r.specialPrice == null ? null : toMinor(r.specialPrice), tag: String(r.tag ?? '').slice(0, 40) || null, sort_order: i })))
    await audit(c, 'product', null, 'update', `specials ${date}: ${rows?.length ?? 0} items`)
  }, { perm: 'products.manage' }),
})
