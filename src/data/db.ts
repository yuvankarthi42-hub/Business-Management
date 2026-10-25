// In-memory mock database persisted to IndexedDB (falls back to localStorage).
// Each collection maps 1:1 to a MySQL table in server/schema.sql.
import type {
  AuditLog, Branch, Business, Category, Customer, DiningTable, Expense, KitchenTicket, Order, Payment, Product,
  Campaign, Role, Special, StockBatch, StockMovement, User, WaMessage, SaleReturn, Attendance, StaffAdvance, SalaryPayment, ReminderLog, Ticket, PlatformAdmin, SubscriptionPeriod, AdminAuditLog, PlatformSettings,
  PointsEntry, Purchase, Supplier, SupplierPayment,
} from '@/core/types'
import { seedAdminTeam, seedPlatform } from './seedPlatform'
import { dropHealthEvents, dropSmsReminders, fixFutureDemoTimes, markContractors, seedStaffAndWholesale, seedSupport } from './seedOps'
import { buildSeed, demoSpecials } from './seed'
import { addFoodDemo, addRetailDemos, addTextileDemo, addTextileHsn, seedDemoBatches } from './seedRetail'
import { normalizePhone } from '@/core/phone'

export interface DB {
  version: number
  seededAt: string
  businesses: Business[]
  branches: Branch[]
  roles: Role[]
  users: User[]
  categories: Category[]
  products: Product[]
  customers: Customer[]
  orders: Order[]
  payments: Payment[]
  kots: KitchenTicket[]
  tables: DiningTable[]
  expenses: Expense[]
  stockMovements: StockMovement[]
  batches: StockBatch[]
  specials: Special[]
  campaigns: Campaign[]
  auditLogs: AuditLog[]
  // Product admin (platform level, not per business)
  admins: PlatformAdmin[]
  subscriptionPeriods: SubscriptionPeriod[]
  adminAudit: AdminAuditLog[]
  platform: PlatformSettings
  // WhatsApp integration
  waMessages: WaMessage[]
  returns: SaleReturn[]
  attendance: Attendance[]
  advances: StaffAdvance[]
  salaries: SalaryPayment[]
  reminderLog: ReminderLog[]
  tickets: Ticket[]
  /** Server-side secrets (e.g. WhatsApp access tokens). Never returned by the API. */
  secrets: { businessId: string; kind: 'whatsapp_token'; value: string }[]
  // Purchases & suppliers
  suppliers: Supplier[]
  purchases: Purchase[]
  supplierPayments: (SupplierPayment & { businessId: string; branchId: string })[]
  /** Loyalty points history; `remaining` = earned points not yet used / expired (used oldest first). */
  points: (PointsEntry & { businessId: string; remaining: number; returnId?: string | null })[]
}

const KEY = 'billpoodum.db' // legacy localStorage key (moved to IndexedDB on first load)
const VERSION = 26
const IDB_NAME = 'billpoodum'
const IDB_STORE = 'kv'

let db: DB
let mode: 'idb' | 'local' = 'idb'
let idb: IDBDatabase | null = null
const listeners = new Set<() => void>()
let changeVersion = 0
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('billpoodum-db') : null

// ---------- IndexedDB helpers (large quota; localStorage is ~5 MB in many browsers) ----------

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const idbGet = <T,>(key: string) => new Promise<T | undefined>((resolve, reject) => {
  const r = idb!.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key)
  r.onsuccess = () => resolve(r.result as T | undefined)
  r.onerror = () => reject(r.error)
})

/** Bring an older save up to the current version without losing test data. */
function migrate(parsed: DB): DB | null {
  parsed.campaigns ??= [] // added after v6; older saves simply have none
  parsed.batches ??= []
  parsed.returns ??= []
  parsed.attendance ??= []
  parsed.advances ??= []
  parsed.salaries ??= []
  parsed.reminderLog ??= []
  parsed.tickets ??= []
  parsed.suppliers ??= []
  parsed.purchases ??= []
  parsed.supplierPayments ??= []
  parsed.points ??= []
  if (parsed.version === 5) migrate5to6(parsed)
  if (parsed.version === 6) migrate6to7(parsed)
  if (parsed.version === 7) { addRetailDemos(parsed); parsed.version = 8 }
  if (parsed.version === 8) { addFoodDemo(parsed); parsed.version = 9 }
  if (parsed.version === 9) {
    // Supermarket demo: shelf prices include GST; give packaged items an MRP a little above the selling price.
    const fm = parsed.businesses.find((b) => b.id === 'biz_freshmart')
    if (fm) fm.billing.taxMode = 'inclusive'
    parsed.products.filter((p) => p.businessId === 'biz_freshmart' && p.barcode && p.mrp == null).forEach((p, i) => { p.mrp = i % 3 === 0 ? p.price : Math.ceil((p.price * 1.08) / 5) * 5 })
    parsed.version = 10
  }
  if (parsed.version === 10) {
    for (const b of parsed.businesses) b.modules.customerOrders ??= b.category === 'retail'
    parsed.version = 11
  }
  if (parsed.version === 11) {
    // Hardware shops: take orders on the shop floor (Take Order) and track them in Customer Orders.
    for (const b of parsed.businesses) if (b.category === 'retail' && /hardware|electric/i.test(b.subType)) { b.modules.mobileOrders = true; b.modules.customerOrders = true }
    parsed.version = 12
  }
  if (parsed.version === 12) { normalizeAllPhones(parsed); parsed.version = 13 }
  if (parsed.version === 13) { seedDemoBatches(parsed); parsed.version = 14 }
  if (parsed.version === 14) { seedPlatform(parsed); parsed.version = 15 }
  if (parsed.version === 15) { seedAdminTeam(parsed); parsed.version = 16 }
  if (parsed.version === 16) { addWhatsApp(parsed); parsed.version = 17 }
  if (parsed.version === 17) { seedStaffAndWholesale(parsed); parsed.version = 18 }
  if (parsed.version === 18) { markContractors(parsed); parsed.version = 19 }
  if (parsed.version === 19) { seedSupport(parsed); parsed.version = 20 }
  if (parsed.version === 20) { fixFutureDemoTimes(parsed); parsed.version = 21 }
  if (parsed.version === 21) { dropSmsReminders(parsed); parsed.version = 22 }
  if (parsed.version === 22) { dropHealthEvents(parsed); parsed.version = 23 }
  if (parsed.version === 23) { addTextileDemo(parsed); normalizeAllPhones(parsed); seedPlatform(parsed); parsed.version = 24 } // silk & saree demo shop
  if (parsed.version === 24) { const k = parsed.businesses.find((b) => b.id === 'biz_kanchi_silks'); if (k) k.billing.orderTypes = ['counter']; parsed.version = 25 } // saree shop: counter only
  if (parsed.version === 25) { addTextileHsn(parsed); parsed.version = 26 } // HSN on the saree shop's categories
  return parsed.version === VERSION ? parsed : null
}

/** Load the database before the app renders. Call once from main.tsx. */
export async function initDB() {
  try {
    idb = await openIdb()
    const stored = await idbGet<DB>('db')
    const savedVersion = stored?.version
    const fromIdb = stored ? migrate(stored) : null
    if (fromIdb) {
      db = fromIdb
      if (savedVersion !== VERSION) persist(db) // save the migrated copy
    } else {
      // First run on IndexedDB: move the old localStorage save over (or create fresh demo data).
      const raw = localStorage.getItem(KEY)
      const legacy = raw ? migrate(JSON.parse(raw) as DB) : null
      db = legacy ?? freshSeed(false)
      persist(db)
      localStorage.removeItem(KEY)
    }
  } catch (e) {
    console.warn('[mock-db] IndexedDB unavailable, falling back to localStorage', e)
    mode = 'local'
    try {
      const raw = localStorage.getItem(KEY)
      db = (raw && migrate(JSON.parse(raw) as DB)) || freshSeed(false)
    } catch { db = freshSeed(false) }
    persist(db)
  }
}

/** Restaurant demo (3 branches) + bakery + supermarket + hardware shop. */
function freshSeed(save = true): DB {
  const fresh = buildSeed(VERSION)
  addRetailDemos(fresh)
  addFoodDemo(fresh)
  addTextileDemo(fresh)
  normalizeAllPhones(fresh)
  seedDemoBatches(fresh)
  seedPlatform(fresh)
  seedAdminTeam(fresh)
  addWhatsApp(fresh)
  seedStaffAndWholesale(fresh)
  markContractors(fresh)
  seedSupport(fresh)
  if (save) persist(fresh)
  return fresh
}

/** v17: WhatsApp integration collections + its release flag (off until the product admin turns it on). */
function addWhatsApp(d: DB) {
  d.waMessages ??= []
  d.secrets ??= []
  d.platform.features ??= {}
  d.platform.features.whatsapp ??= { mode: 'off', businessIds: [] }
}

/** Keeps existing test data when new features add collections or module flags. */
function migrate5to6(d: DB): DB {
  d.specials = []
  for (const b of d.businesses) {
    const food = b.category === 'food' || b.category === 'restaurant'
    b.modules = { ...b.modules, specials: b.modules.specials ?? food, qrOrdering: b.modules.qrOrdering ?? food }
    if (b.id === 'biz_foodcorner') d.specials.push(...demoSpecials(b.id, d.products))
  }
  d.version = 6
  return d
}

/** Every stored mobile number → E.164 (+91 for the existing Indian demo data). Unparseable values are kept as-is. */
function normalizeAllPhones(d: DB) {
  const fix = (v: string | undefined | null, iso: string) => { try { return normalizePhone(v, iso) ?? '' } catch { return v ?? '' } }
  const countryOf = (businessId: string) => d.businesses.find((b) => b.id === businessId)?.defaultCountry ?? 'IN'
  for (const b of d.businesses) { b.defaultCountry ??= 'IN'; b.phone = fix(b.phone, b.defaultCountry) }
  for (const br of d.branches) br.phone = fix(br.phone, countryOf(br.businessId))
  for (const u of d.users) u.phone = fix(u.phone, countryOf(u.businessId))
  for (const c of d.customers) c.phone = fix(c.phone, countryOf(c.businessId))
  for (const o of d.orders) if (o.guest) o.guest.phone = fix(o.guest.phone, countryOf(o.businessId))
}

/** Multi-branch: per-branch stock, branch status. Existing stock moves to each business's main branch. */
function migrate6to7(d: DB): DB {
  for (const br of d.branches) { br.active ??= true; br.phone ??= '' }
  for (const p of d.products) {
    if (p.stockByBranch) continue
    const main = d.branches.find((b) => b.businessId === p.businessId && b.isDefault) ?? d.branches.find((b) => b.businessId === p.businessId)
    p.stockByBranch = main && p.trackStock ? { [main.id]: p.stock } : {}
  }
  d.version = 7
  return d
}

function persist(d: DB): boolean {
  if (mode === 'idb' && idb) {
    // put() structured-clones synchronously, so later in-memory edits don't leak into this write.
    const t = idb.transaction(IDB_STORE, 'readwrite')
    t.objectStore(IDB_STORE).put(d, 'db')
    t.oncomplete = () => channel?.postMessage('changed')
    t.onerror = () => console.error('[mock-db] could not save to IndexedDB', t.error)
    return true
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
    return true
  } catch (e) {
    console.warn('[mock-db] could not persist to localStorage (quota?)', e)
    return false
  }
}

export const getDB = () => db

/** Run a mutation, persist and notify subscribers (simulates a committed DB transaction). */
export function tx<T>(fn: (d: DB) => T): T {
  // Snapshot so a failed mutation rolls back completely, like a SQL transaction.
  const snapshot = structuredClone(db)
  let result: T
  try {
    result = fn(db)
  } catch (e) {
    db = snapshot
    throw e
  }
  if (!persist(db)) {
    db = snapshot
    throw new Error('Browser storage is full. Use smaller photos, or reset demo data in Settings.')
  }
  changeVersion++
  listeners.forEach((l) => l())
  return result
}

/** Tell screens to re-read (e.g. after switching branch, which changes what the API returns). */
export function notify() {
  changeVersion++
  listeners.forEach((l) => l())
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const getChangeVersion = () => changeVersion

export function resetDB() {
  db = freshSeed()
  changeVersion++
  listeners.forEach((l) => l())
}

// Keep multiple open tabs (e.g. POS + kitchen display) in sync.
channel?.addEventListener('message', async () => {
  if (mode !== 'idb' || !idb) return
  const fresh = await idbGet<DB>('db')
  if (fresh) { db = fresh; changeVersion++; listeners.forEach((l) => l()) }
})
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (mode !== 'local' || e.key !== KEY || !e.newValue) return
    try {
      db = JSON.parse(e.newValue)
      changeVersion++
      listeners.forEach((l) => l())
    } catch { /* ignore */ }
  })
}
