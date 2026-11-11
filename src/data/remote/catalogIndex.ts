// A large shop's light product index on this device (src/core/catalogIndex.ts): read once, kept in IndexedDB (per
// shop, user and branch view), then only "what changed since" is asked for. Without IndexedDB (private mode) it is
// kept for this visit only. Cleared on sign-out. Small shops never use it (products.list loads them as before).
import { fromLightRow, INDEX_PARALLEL, L, LF, type IndexPage, type LightRow } from '@/core/catalogIndex'
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

const readPage = async (after: string | null) => (await rpc<IndexPage>('products.index', [{ after }], 'user')).data

/**
 * The whole index. The first page says where every later page starts, so those are read INDEX_PARALLEL at a time;
 * products added meanwhile come after the last one (followed by its `next`). Without that list (an older server):
 * one page after another, as before. Changes from the first page's time on come with the next "since" read.
 */
async function readAll(): Promise<{ rows: LightRow[]; at: string }> {
  const first = await readPage(null)
  const byId = new Map<string, LightRow>()
  const add = (rs: LightRow[]) => { for (const r of rs) byId.set(r[L.id], r) }
  add(first.rows)
  let after = first.next
  if (first.bounds?.length) {
    const starts = first.bounds
    let next = 0, tail: string | null = null
    await Promise.all(Array.from({ length: Math.min(INDEX_PARALLEL, starts.length) }, async () => {
      while (next < starts.length) {
        const k = next++
        const page = await readPage(starts[k])
        add(page.rows)
        if (k === starts.length - 1) tail = page.next // past the last start: carry on from there
      }
    }))
    after = tail
  }
  while (after !== null) { const page = await readPage(after); add(page.rows); after = page.next }
  return { rows: [...byId.values()], at: first.at }
}

/**
 * The index for this view as the app's products (light ones), in the list's order (sort order, then id).
 * A saved copy is brought up to date with one small read; none (or too old / too many changes): read whole.
 */
export async function loadCatalogIndex(key: string, businessId: string): Promise<Product[]> {
  let saved = memory.get(key) ?? (await idbGet(key))
  if (saved && (saved.v !== VERSION || Date.now() - saved.savedAt > MAX_AGE)) saved = null
  if (saved) {
    // Edited products come as whole rows; products whose only change is stock as small stock entries.
    const ch = (await rpc<IndexPage>('products.index', [{ since: saved.at, stockOnly: true }], 'user')).data
    if (ch.reset) saved = null
    else if (ch.rows.length || ch.stock?.length) {
      const byId = new Map(saved.rows.map((r) => [r[L.id], r]))
      for (const r of ch.rows) byId.set(r[L.id], r)
      for (const [id, stock, stockByBranch, nextExpiry] of ch.stock ?? []) {
        const r = byId.get(id)
        if (!r) continue // not on this device yet: it comes with its next edit or the next full read
        const n = [...r] as LightRow
        n[L.stock] = stock; n[L.stockByBranch] = stockByBranch; n[L.nextExpiry] = r[L.flags] & LF.trackExpiry ? nextExpiry : null
        byId.set(id, n)
      }
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
