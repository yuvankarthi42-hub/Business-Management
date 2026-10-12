// Categories, products (save, CSV import, in-store barcodes), photos and daily specials.
import { randomBytes } from 'node:crypto'
import { templateFor } from '@/core/config'
import type { ImportItem } from '@/core/productImport'
import type { Category, Product, Special } from '@/core/types'
import { nextInStoreBarcode } from '@/lib/barcode'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row } from '../db/types'
import { categoryFrom, loadCategories, loadProducts, mediaMap, productColumns, syncOptions, wholesaleList } from '../domain/catalog'
import { moveStock, stockProduct, type BatchInput } from '../domain/stock'
import { audit, bizDay, E, fromMinorOrNull, isId, keyPart, own, str, toMilli, toMinor } from '../domain/util'

// ---------- photos ----------
const LIMITS = { product: { main: 51_200, thumb: 20_480 }, category: { main: 51_200, thumb: 20_480 }, ticket: { main: 204_800, thumb: 0 }, poster: { main: 204_800, thumb: 0 } } as const
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
  const key = `${c.businessId}/${purpose}s/${id}.${main.ext}`
  const url = await c.files.put(key, main.buf, main.type)
  let thumbKey: string | null = null, thumbUrl: string | null = null
  if (input.thumb && lim.thumb) {
    const t = decodeImage(input.thumb, lim.thumb)
    thumbKey = `${c.businessId}/${purpose}s/${id}_t.${t.ext}`
    thumbUrl = await c.files.put(thumbKey, t.buf, t.type)
  }
  // Ticket screenshots are kept with the tickets (platform database); product photos in the shop's.
  const row = await (purpose === 'ticket' ? c.platform : c.db).insert('media_files', {
    business_id: c.businessId, purpose: E.MediaPurpose[purpose], bucket: process.env.STRATUS_BUCKET || 'local', object_key: key, thumb_key: thumbKey,
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
    const data = { name: name.slice(0, 80), uniq_key: `${c.businessId}:${keyPart(name)}`, ...(input.emoji !== undefined ? { emoji: (input.emoji || '').slice(0, 8) || null } : {}), ...(img !== undefined ? { image_media_id: img } : {}) }
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

define('products', {
  list: userRead(async (c) => loadProducts(c)),

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
    const seen = new Set<string>()
    for (const it of rows) {
      if (!String(it.name ?? '').trim() || !(Number(it.price) >= 0)) throw new ApiError(`Row ${it.row + 2}: name and a valid price are needed`)
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
        set('categoryId', categoryId); set('mrp', it.mrp); set('wholesalePrice', it.wholesalePrice); set('costPrice', it.costPrice); set('sku', it.sku)
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
        name, categoryId: categoryId ?? null, kind: it.kind ?? (b.category === 'service' ? 'service' : 'goods'), mrp: it.mrp ?? null, sku: it.sku ?? '',
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

  /** Give every listed product without a barcode its own in-store EAN-13 (prefix 20), for printing labels. */
  assignBarcodes: userWrite(async (c, ids: string[]) => {
    const all = await c.db.select('products', { where: { business_id: c.businessId } })
    const codes = all.map((p) => str(p.barcode))
    const out: Record<string, string> = {}
    for (const p of all.filter((x) => (ids ?? []).includes(x.ROWID) && !str(x.barcode).trim())) {
      const bc = nextInStoreBarcode(codes)
      codes.push(bc)
      await c.db.update('products', p.ROWID, { barcode: bc, barcode_key: `${c.businessId}:${bc}` })
      await audit(c, 'product', p.ROWID, 'update', `${str(p.name)}: barcode ${bc}`)
      out[p.ROWID] = bc
    }
    return out
  }, { perm: 'products.manage' }),
})

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
    const prods = new Set((await c.db.select('products', { where: { business_id: c.businessId } })).map((p) => p.ROWID))
    for (const r of rows ?? []) if (!isId(r.productId) || !prods.has(r.productId)) throw new ApiError('An item in the list was not found')
    const old = await c.db.select('daily_specials', { where: { business_id: c.businessId, special_date: date } })
    if (old.length) await c.db.deleteMany('daily_specials', old.map((x) => x.ROWID))
    if (rows?.length) await c.db.insertMany('daily_specials', rows.map((r, i) => ({ business_id: c.businessId, branch_id: null, product_id: r.productId, special_date: date, offer_price_minor: r.specialPrice == null ? null : toMinor(r.specialPrice), tag: String(r.tag ?? '').slice(0, 40) || null, sort_order: i })))
    await audit(c, 'product', null, 'update', `specials ${date}: ${rows?.length ?? 0} items`)
  }, { perm: 'products.manage' }),
})
