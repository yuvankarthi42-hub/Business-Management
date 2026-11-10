// A large shop's light product index on this device (src/core/catalogIndex.ts): read once, kept in IndexedDB (per
// shop, user and branch view), then only "what changed since" is asked for. Without IndexedDB (private mode) it is
// kept for this visit only. Cleared on sign-out. Small shops never use it (products.list loads them as before).
import { fromLightRow, L, type IndexPage, type LightRow } from '@/core/catalogIndex'
import type { Product } from '@/core/types'
import { rpc } from './http'

const DB = 'kk-catalog'
const STORE = 'index'
const VERSION = 1 // the row layout (core/catalogIndex.ts L); another value = read again
const MAX_AGE = 7 * 86_400_000

interface Saved { v: number; at: string; savedAt: number; rows: LightRow[] }
const memory = new Map<string, Saved>()

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') return res(null)
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(null)
      req.onblocked = () => res(null)
    } catch { res(null) }
  })
}
async function idbGet(key: string): Promise<Saved | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((res) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      r.onsuccess = () => { db.close(); res((r.result as Saved) ?? null) }
      r.onerror = () => { db.close(); res(null) }
    } catch { db.close(); res(null) }
  })
}
async function idbPut(key: string, value: Saved) {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((res) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => { db.close(); res() }
      tx.onerror = () => { db.close(); res() }
    } catch { db.close(); res() }
  })
}

/** Sign-out / another account: forget every saved index on this device. */
export async function clearCatalogIndex() {
  memory.clear()
  try { if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(DB) } catch { /* nothing saved */ }
}

/** Does this device already keep an index for this view? (Then the shop is a large one: no need to ask.) */
export async function hasCatalogIndex(key: string) {
  if (memory.has(key)) return true
  const s = await idbGet(key)
  return !!s && s.v === VERSION && Date.now() - s.savedAt < MAX_AGE
}

async function readAll(): Promise<{ rows: LightRow[]; at: string }> {
  const rows: LightRow[] = []
  let after: string | null = null, at = ''
  do {
    const page: IndexPage = (await rpc<IndexPage>('products.index', [{ after }], 'user')).data
    rows.push(...page.rows)
    if (!at) at = page.at // changes from the first page's time on come with the next "since" read
    after = page.next
  } while (after !== null)
  return { rows, at }
}

/**
 * The index for this view as the app's products (light ones), in the list's order (sort order, then id).
 * A saved copy is brought up to date with one small read; none (or too old / too many changes): read whole.
 */
export async function loadCatalogIndex(key: string, businessId: string): Promise<Product[]> {
  let saved = memory.get(key) ?? (await idbGet(key))
  if (saved && (saved.v !== VERSION || Date.now() - saved.savedAt > MAX_AGE)) saved = null
  if (saved) {
    const ch = (await rpc<IndexPage>('products.index', [{ since: saved.at }], 'user')).data
    if (ch.reset) saved = null
    else if (ch.rows.length) {
      const byId = new Map(saved.rows.map((r) => [r[L.id], r]))
      for (const r of ch.rows) byId.set(r[L.id], r)
      saved = { v: VERSION, at: ch.at, savedAt: Date.now(), rows: [...byId.values()] }
    } else saved = { ...saved, at: ch.at, savedAt: Date.now() }
  }
  if (!saved) {
    const all = await readAll()
    saved = { v: VERSION, at: all.at, savedAt: Date.now(), rows: all.rows }
  }
  memory.set(key, saved)
  void idbPut(key, saved)
  const rows = [...saved.rows].sort((a, b) => a[L.sort] - b[L.sort] || Number(a[L.id]) - Number(b[L.id]))
  return rows.map((r) => fromLightRow(r, businessId))
}
