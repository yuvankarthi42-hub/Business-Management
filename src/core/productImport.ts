// CSV import of products / menu items: fields, column auto-matching, value parsing and row checks.
// Pure functions — the server re-runs the same checks before saving.
import { productFormFor, templateFor } from './config'
import type { Business, Product } from './types'

export type ImportFieldKey =
  | 'name' | 'price' | 'category' | 'mrp' | 'wholesalePrice' | 'costPrice' | 'barcode' | 'sku' | 'unit' | 'tax' | 'isVeg' | 'variants' | 'addOns'
  | 'trackStock' | 'stock' | 'lowStockAt' | 'trackExpiry' | 'expiry' | 'batchNo' | 'sendToKitchen' | 'isService' | 'imageUrl' | 'active'

export interface ImportField {
  key: ImportFieldKey
  label: string
  required?: boolean
  hint: string
  /** Header names (normalised) that match this field automatically. */
  aliases: string[]
}

const F = (key: ImportFieldKey, label: string, hint: string, aliases: string[], required = false): ImportField => ({ key, label, hint, aliases, required })

/** The same fields as the Add item form for this business type. */
export function importFieldsFor(b: Pick<Business, 'category' | 'subType'>): ImportField[] {
  const form = productFormFor(b)
  const retail = b.category === 'retail'
  const list: (ImportField | false)[] = [
    F('name', 'Name', 'Toor Dal 1 kg', ['name', 'itemname', 'productname', 'item', 'product', 'menuitem', 'dish', 'description', 'பெயர்', 'பொருள்'], true),
    F('price', 'Selling price', '140', ['price', 'sellingprice', 'saleprice', 'rate', 'sp', 'amount', 'விலை'], true),
    F('category', 'Category', 'Dal & Pulses', ['category', 'categoryname', 'group', 'department', 'section', 'type', 'வகை']),
    (retail || !!form.showMrp) && F('mrp', 'MRP', '155', ['mrp', 'maximumretailprice', 'listprice']),
    retail && F('wholesalePrice', 'Wholesale / contractor price', '130', ['wholesale', 'wholesaleprice', 'contractor', 'contractorprice', 'contractorrate', 'dealerprice', 'wholesalerate', 'trade', 'tradeprice']),
    F('costPrice', 'Cost price', '118', ['cost', 'costprice', 'purchaseprice', 'buyprice', 'cp', 'purchaserate']),
    F('barcode', 'Barcode', '8901234567890', ['barcode', 'ean', 'ean13', 'upc', 'gtin', 'barcodeno']),
    F('sku', 'SKU / item code', 'FM014', ['sku', 'code', 'itemcode', 'productcode', 'hsn']),
    F('unit', 'Sold per (unit)', templateFor(b.category).units.slice(0, 4).join(' / '), ['unit', 'uom', 'soldper', 'per', 'units']),
    F('tax', 'GST / tax', '5 or 5% or GST 5%', ['gst', 'tax', 'taxrate', 'gstrate', 'vat', 'gstpercent']),
    form.showFoodType && F('isVeg', 'Veg / Non-veg', 'veg / non-veg', ['veg', 'vegnonveg', 'foodtype', 'isveg', 'type']),
    F('variants', form.variants.title, `${form.variants.placeholder}:120 | Large:200`, ['variants', 'sizes', 'size', 'portions', 'options']),
    !!form.addOns && F('addOns', form.addOns!.title, 'Cheese:30 | Egg:20', ['addons', 'addon', 'extras', 'toppings']),
    F('trackStock', 'Track stock', 'yes / no', ['trackstock', 'stocktracking', 'inventory']),
    F('stock', 'Opening stock', '25', ['stock', 'qty', 'quantity', 'openingstock', 'onhand', 'balance', 'closingstock']),
    F('lowStockAt', 'Low stock alert at', '5', ['lowstock', 'lowstockat', 'reorderlevel', 'minstock', 'reorder', 'alertat']),
    retail && F('trackExpiry', 'Track batch & expiry', 'yes / no', ['trackexpiry', 'expirytracking', 'perishable']),
    retail && F('expiry', 'Expiry date', '2026-12-31 or 31-12-2026', ['expiry', 'expirydate', 'exp', 'bestbefore', 'usebefore']),
    retail && F('batchNo', 'Batch no.', 'B2410', ['batch', 'batchno', 'batchnumber', 'lot', 'lotno']),
    form.showKitchen && F('sendToKitchen', 'Send to kitchen (KOT)', 'yes / no', ['kot', 'sendtokitchen', 'kitchen']),
    !form.isService && b.category !== 'retail' && F('isService', 'Is a service (no stock)', 'yes / no', ['service', 'isservice']),
    form.isService && F('isService', 'Is a service', 'yes / no', ['service', 'isservice']),
    F('imageUrl', 'Photo URL', 'https://…/photo.jpg', ['image', 'imageurl', 'photo', 'photourl', 'picture', 'img']),
    F('active', 'Active', 'yes / no', ['active', 'status', 'enabled', 'available']),
  ]
  return list.filter(Boolean) as ImportField[]
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9஀-௿]/g, '')

/** Guess the mapping from the CSV headers (each column used once). */
export function autoMap(fields: ImportField[], headers: string[]): Partial<Record<ImportFieldKey, string>> {
  const out: Partial<Record<ImportFieldKey, string>> = {}
  const used = new Set<string>()
  // Exact alias first, then "header contains alias" for longer names like "Item Name (English)".
  for (const pass of [0, 1]) {
    for (const f of fields) {
      if (out[f.key]) continue
      const h = headers.find((x) => !used.has(x) && (pass === 0 ? f.aliases.includes(norm(x)) || norm(x) === norm(f.label) : f.aliases.some((a) => a.length > 3 && norm(x).includes(a))))
      if (h) { out[f.key] = h; used.add(h) }
    }
  }
  return out
}

// ---------- Parsing ----------

const YES = ['yes', 'y', 'true', '1', 'on', 'ஆம்', 'active', 'enabled', 'available']
const NO = ['no', 'n', 'false', '0', 'off', 'இல்லை', 'inactive', 'disabled', 'notavailable']
const UNIT_ALIASES: Record<string, string> = {
  pcs: 'pc', piece: 'pc', pieces: 'pc', nos: 'pc', no: 'pc', each: 'pc', ea: 'pc', unit: 'pc', number: 'pc',
  kgs: 'kg', kilo: 'kg', kilogram: 'kg', gm: 'g', gms: 'g', gram: 'g', grams: 'g', grm: 'g',
  l: 'ltr', lt: 'ltr', litre: 'ltr', liter: 'ltr', litres: 'ltr', ml: 'ml', mtrs: 'mtr', meter: 'mtr', metre: 'mtr', m: 'mtr',
  feet: 'ft', foot: 'ft', plates: 'plate', cups: 'cup', glasses: 'glass', boxes: 'box', packet: 'pack', pkt: 'pack', packs: 'pack',
  doz: 'dozen', rolls: 'roll', sets: 'set', bags: 'bag', pairs: 'pair', hour: 'hr', hours: 'hr', hrs: 'hr',
}

export const parseNum = (s: string) => {
  const t = s.replace(/[₹,\s]|rs\.?/gi, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}
const parseBool = (s: string) => { const t = norm(s); return YES.includes(t) ? true : NO.includes(t) ? false : undefined }
const parseVeg = (s: string) => {
  const t = norm(s)
  if (['veg', 'v', 'vegetarian', 'சைவம்', 'yes', 'true', '1', 'green'].includes(t)) return true
  if (['nonveg', 'nv', 'nonvegetarian', 'அசைவம்', 'no', 'false', '0', 'red', 'egg'].includes(t)) return false
  return undefined
}
/** "Half:120 | Full:200" (also ; or , between, = or - instead of :) */
export function parseOptions(s: string): { list: { name: string; price: number }[]; bad: string[] } {
  const list: { name: string; price: number }[] = [], bad: string[] = []
  for (const part of s.split(/[|;]|,(?=\s*[^\d\s])/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(.+?)\s*[:=–-]\s*₹?\s*([\d.,]+)$/)
    const price = m ? parseNum(m[2]) : NaN
    if (m && price !== null && !Number.isNaN(price) && price >= 0) list.push({ name: m[1].trim(), price: price! })
    else bad.push(part)
  }
  return { list, bad }
}
/** YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, DD.MM.YY → YYYY-MM-DD */
export function parseDate(s: string): string | null {
  const t = s.trim()
  let y: number, m: number, d: number
  let r = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (r) { y = +r[1]; m = +r[2]; d = +r[3] } else {
    r = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/)
    if (!r) return null
    d = +r[1]; m = +r[2]; y = +r[3] < 100 ? 2000 + +r[3] : +r[3]
  }
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ---------- Rows ----------

/** One product ready to import. Only fields that were mapped are set. */
export interface ImportItem {
  name: string
  price: number
  categoryName?: string
  mrp?: number | null
  wholesalePrice?: number | null
  costPrice?: number
  barcode?: string
  sku?: string
  unit?: string
  taxRateId?: string | null
  isVeg?: boolean
  variants?: { name: string; price: number }[]
  addOns?: { name: string; price: number }[]
  trackStock?: boolean
  stock?: number
  lowStockAt?: number
  trackExpiry?: boolean
  expiry?: string
  batchNo?: string
  sendToKitchen?: boolean
  kind?: Product['kind']
  imageUrl?: string | null
  thumbUrl?: string | null
  active?: boolean
}

export interface CheckedRow {
  index: number
  item: ImportItem
  errors: string[]
  warnings: string[]
  /** Matching product already in the shop (same barcode, otherwise same name). */
  existing: { id: string; name: string } | null
  newCategory: boolean
}

export interface ImportContext {
  business: Pick<Business, 'category' | 'subType' | 'billing'>
  products: Pick<Product, 'id' | 'name' | 'barcode'>[]
  categories: { name: string }[]
}

/** Check every row, including duplicates inside the file and against the shop's products. */
export function checkRows(rows: Partial<Record<ImportFieldKey, string>>[], ctx: ImportContext): CheckedRow[] {
  const units = templateFor(ctx.business.category).units
  const defaultUnit = units[0] ?? 'pc'
  const rates = ctx.business.billing.taxRates
  const cats = new Set(ctx.categories.map((c) => c.name.trim().toLowerCase()))
  const byBarcode = new Map(ctx.products.filter((p) => p.barcode).map((p) => [p.barcode, p]))
  const byName = new Map(ctx.products.map((p) => [p.name.trim().toLowerCase(), p]))
  const seenBarcode = new Map<string, number>(), seenName = new Map<string, number>()
  const retail = ctx.business.category === 'retail'

  return rows.map((r, index) => {
    const errors: string[] = [], warnings: string[] = []
    const v = (k: ImportFieldKey) => (r[k] ?? '').trim()
    const has = (k: ImportFieldKey) => v(k) !== ''
    const num = (k: ImportFieldKey, label: string, opts: { min?: number } = {}) => {
      if (!has(k)) return undefined
      const n = parseNum(v(k))
      if (n === null) return undefined
      if (Number.isNaN(n)) { errors.push(`${label} isn’t a number (“${v(k)}”)`); return undefined }
      if (n < (opts.min ?? 0)) { errors.push(`${label} can’t be below ${opts.min ?? 0}`); return undefined }
      return n
    }
    const bool = (k: ImportFieldKey, label: string) => {
      if (!has(k)) return undefined
      const b = parseBool(v(k))
      if (b === undefined) warnings.push(`${label}: “${v(k)}” isn’t yes / no — left as default`)
      return b
    }

    const item: ImportItem = { name: v('name').replace(/\s+/g, ' '), price: 0 }
    if (!item.name) errors.push('Name is empty')
    else if (item.name.length > 120) errors.push('Name is longer than 120 characters')

    if (has('variants')) {
      const { list, bad } = parseOptions(v('variants'))
      if (bad.length) errors.push(`Sizes not understood: ${bad.join(', ')} — use Name:Price | Name:Price`)
      if (list.length) item.variants = list
    }
    if (has('addOns')) {
      const { list, bad } = parseOptions(v('addOns'))
      if (bad.length) errors.push(`Add-ons not understood: ${bad.join(', ')} — use Name:Price | Name:Price`)
      if (list.length) item.addOns = list
    }
    const price = num('price', 'Price')
    if (price !== undefined) item.price = price
    else if (!has('price') && !item.variants?.length) errors.push('Price is empty')
    else if (!has('price') && item.variants?.length) item.price = Math.min(...item.variants.map((x) => x.price))

    if (has('category')) { item.categoryName = v('category'); }
    const mrp = num('mrp', 'MRP'); if (mrp !== undefined) { item.mrp = mrp; if (mrp && item.price > mrp) warnings.push('Price is more than MRP') }
    const ws = num('wholesalePrice', 'Wholesale price'); if (ws !== undefined) { item.wholesalePrice = ws || null; if (ws && item.price && ws > item.price) warnings.push('Wholesale price is more than the selling price') }
    const cost = num('costPrice', 'Cost price'); if (cost !== undefined) { item.costPrice = cost; if (item.price && cost > item.price) warnings.push('Cost price is more than selling price') }

    if (has('barcode')) {
      const code = v('barcode')
      if (/e\+?\d+$/i.test(code)) errors.push(`Barcode looks rounded by Excel (“${code}”) — format the column as Text and export again`)
      else if (!/^[A-Za-z0-9-]{4,32}$/.test(code)) errors.push(`Barcode “${code}” has spaces or symbols`)
      else {
        item.barcode = code
        if (seenBarcode.has(code)) errors.push(`Same barcode as row ${seenBarcode.get(code)! + 2}`)
        else seenBarcode.set(code, index)
      }
    }
    if (has('sku')) item.sku = v('sku')
    if (has('unit')) {
      const t = norm(v('unit'))
      const u = units.includes(t) ? t : UNIT_ALIASES[t]
      if (u && (units.includes(u) || ['pc', 'kg', 'g', 'ltr', 'ml'].includes(u))) item.unit = u
      else { item.unit = defaultUnit; warnings.push(`Unit “${v('unit')}” not known — using ${defaultUnit}`) }
    }
    if (has('tax')) {
      const t = v('tax').toLowerCase()
      const pct = /exempt|nil|none|^-$/.test(t) ? 0 : parseNum(t.replace(/gst|vat|%|tax/g, ''))
      const rate = pct === null || Number.isNaN(pct) ? undefined : rates.find((x) => x.rate === pct)
      if (rate) item.taxRateId = rate.id
      else warnings.push(`GST “${v('tax')}” doesn’t match your tax rates — default used`)
    }
    if (has('isVeg')) {
      const veg = parseVeg(v('isVeg'))
      if (veg === undefined) warnings.push(`Veg / Non-veg “${v('isVeg')}” not understood — set as veg`)
      else item.isVeg = veg
    }
    const ts = bool('trackStock', 'Track stock'); if (ts !== undefined) item.trackStock = ts
    const stock = num('stock', 'Opening stock'); if (stock !== undefined) { item.stock = stock; if (stock > 0 && item.trackStock === undefined) item.trackStock = true }
    const low = num('lowStockAt', 'Low stock alert'); if (low !== undefined) item.lowStockAt = low
    const te = bool('trackExpiry', 'Track batch & expiry'); if (te !== undefined) item.trackExpiry = te
    if (has('expiry')) {
      const d = parseDate(v('expiry'))
      if (!d) errors.push(`Expiry date “${v('expiry')}” not understood — use 2026-12-31 or 31-12-2026`)
      else { item.expiry = d; if (item.trackExpiry === undefined) item.trackExpiry = true; if (d < new Date().toISOString().slice(0, 10)) warnings.push('Expiry date is already past') }
    }
    if (has('batchNo')) item.batchNo = v('batchNo').slice(0, 30)
    if (item.trackExpiry && (item.stock ?? 0) > 0 && !item.expiry) warnings.push('No expiry date — opening stock added without one')
    const kot = bool('sendToKitchen', 'Send to kitchen'); if (kot !== undefined) item.sendToKitchen = kot
    const svc = bool('isService', 'Is a service'); if (svc !== undefined) item.kind = svc ? 'service' : 'goods'
    if (has('imageUrl')) {
      if (/^https?:\/\/\S+$/i.test(v('imageUrl'))) item.imageUrl = v('imageUrl')
      else warnings.push('Photo URL isn’t a web link — skipped')
    }
    const act = bool('active', 'Active'); if (act !== undefined) item.active = act
    if (retail && item.trackStock === undefined) item.trackStock = true

    // Already in the shop? Barcode wins over name.
    const ex = (item.barcode && byBarcode.get(item.barcode)) || (item.name && byName.get(item.name.toLowerCase())) || null
    const key = item.name.toLowerCase()
    if (key && seenName.has(key) && !item.barcode) warnings.push(`Same name as row ${seenName.get(key)! + 2}`)
    if (key && !seenName.has(key)) seenName.set(key, index)
    const newCategory = !!item.categoryName && !cats.has(item.categoryName.toLowerCase())
    return { index, item, errors, warnings, existing: ex ? { id: ex.id, name: ex.name } : null, newCategory }
  })
}

/** Example file for this business type (downloaded from step 1). */
export function sampleCsv(b: Pick<Business, 'category' | 'subType'>): string {
  const fields = importFieldsFor(b)
  const sub = b.subType.toLowerCase()
  const food = b.category === 'food' || b.category === 'restaurant'
  const rows: Partial<Record<ImportFieldKey, string>>[] = food ? [
    { name: 'Chicken Biryani', price: '', category: 'Biryani & Rice', costPrice: '110', unit: 'plate', tax: '5', isVeg: 'non-veg', variants: 'Half:120 | Full:200', addOns: 'Extra raita:20', sendToKitchen: 'yes', active: 'yes' },
    { name: 'Masala Dosa', price: '80', category: 'Tiffin', costPrice: '35', unit: 'plate', tax: '5', isVeg: 'veg', sendToKitchen: 'yes', active: 'yes' },
  ] : b.category === 'service' ? [
    { name: 'Haircut', price: '150', category: 'Hair', variants: 'Short:150 | Long:250', addOns: 'Hair wash:50', isService: 'yes' },
    { name: 'Facial', price: '499', category: 'Skin & Facial', isService: 'yes' },
  ] : /hardware|electric/.test(sub) ? [
    { name: 'Havells 1.5 sq mm wire 90 m', price: '1850', category: 'Electricals', mrp: '2100', wholesalePrice: '1720', costPrice: '1600', barcode: '8901234500011', sku: 'HW001', unit: 'coil', tax: '18', stock: '12', lowStockAt: '3' },
    { name: 'Anchor 6A switch', price: '28', category: 'Electricals', mrp: '32', wholesalePrice: '24', costPrice: '21', barcode: '8901234500028', sku: 'HW002', unit: 'pc', tax: '18', stock: '200', lowStockAt: '50' },
  ] : [
    { name: 'Toor Dal 1 kg', price: '140', category: 'Dal & Pulses', mrp: '155', costPrice: '118', barcode: '8901234567890', sku: 'FM014', unit: 'pack', tax: '0', stock: '25', lowStockAt: '5' },
    { name: 'Milk 500 ml', price: '27', category: 'Milk & Dairy', mrp: '28', costPrice: '24', barcode: '8901234567906', unit: 'pc', tax: '0', stock: '40', lowStockAt: '10', trackExpiry: 'yes', expiry: '2026-10-12', batchNo: 'B1010' },
  ]
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const head = fields.map((f) => f.label)
  return [head, ...rows.map((r) => fields.map((f) => r[f.key] ?? ''))].map((line) => line.map(esc).join(',')).join('\n')
}
