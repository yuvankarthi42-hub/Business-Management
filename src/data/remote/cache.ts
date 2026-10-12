// In-memory read cache for the Catalyst backend — the rules the product owner set:
//  • Reads are served from memory and only fetched again when a confirmed change affects them
//    (or after a short time, so changes made on another device show up).
//  • Writes always go straight to the server; the screen updates only after the server confirms.
//    Nothing pending is ever stored (no localStorage / IndexedDB / offline queue).
//  • After a write: apply what the server returned (e.g. new stock levels) and drop the reads it changed.
import { auth, rpc, type Effects, type TokenKind } from './http'
import { invalidatesFor, readPolicy } from './policy'

interface Entry { at: number; ttl: number; tags: string[]; value?: unknown; pending?: Promise<unknown> }
const entries = new Map<string, Entry>()

// ---- change bus (what useData / AppContext listen to) ----
let version = 0
const listeners = new Set<() => void>()
export const getChangeVersion = () => version
export function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function notify() { version++; for (const l of listeners) l() }

/**
 * While the change feed runs (sync.ts), other devices' changes arrive within ~30 s, so cached reads can be
 * trusted longer (up to 30 min). Without it (Catalyst Data Store), the times in policy.ts apply as they are.
 */
let ttlScale = 1
export const setTtlScale = (n: number) => { ttlScale = n }
const ttlOf = (ms: number) => Math.min(ms * ttlScale, Math.max(ms, 30 * 60_000))

const keyOf = (name: string, args: unknown[]) => `${name}|${auth.branch ?? ''}|${JSON.stringify(args)}`

/** A read: from memory when fresh, otherwise one request (shared by everyone asking at the same time). */
export async function cachedRead<T>(name: string, args: unknown[], token: TokenKind): Promise<T> {
  const pol = readPolicy(name)
  if (!pol) return (await rpc<T>(name, args, token)).data
  const key = keyOf(name, args)
  const e = entries.get(key)
  if (e?.pending) return e.pending as Promise<T>
  if (e && 'value' in e && Date.now() - e.at < ttlOf(e.ttl)) return structuredClone(e.value) as T
  const entry: Entry = { at: Date.now(), ttl: pol.ttl, tags: pol.tags }
  const p = rpc<T>(name, args, token).then((r) => { entry.value = r.data; entry.at = Date.now(); delete entry.pending; return structuredClone(r.data) as T })
  entry.pending = p
  entries.set(key, entry)
  try { return await p } catch (err) { if (entries.get(key) === entry) entries.delete(key); throw err }
}

/** A write: server first, then update what we have and tell the screens. */
export async function confirmedWrite<T>(name: string, args: unknown[], token: TokenKind): Promise<T> {
  const r = await rpc<T>(name, args, token)
  applyEffects(r.effects)
  invalidate(invalidatesFor(name, args))
  notify()
  return r.data
}

export function invalidate(tags: string[] | 'all') {
  for (const [k, e] of entries) if (tags === 'all' || e.tags.some((t) => tags.includes(t))) entries.delete(k)
}
export function clearAll() { entries.clear(); notify() }

/** Stock changed by a confirmed bill / return / adjustment: patch the cached product lists in place. */
function applyEffects(fx?: Effects) {
  if (!fx?.stock?.length) return
  for (const [k, e] of entries) {
    if (!k.startsWith('products.list|') || !Array.isArray(e.value)) continue
    const branch = k.split('|')[1]
    for (const p of e.value as { id: string; stock: number; stockByBranch?: Record<string, number> }[]) {
      const changes = fx.stock.filter((s) => s.productId === p.id)
      if (!changes.length) continue
      p.stockByBranch = { ...p.stockByBranch }
      for (const s of changes) p.stockByBranch[s.branchId] = s.stock
      // The list was read for one branch (or all of them): add up the same branches again.
      p.stock = branch && branch !== 'all' ? p.stockByBranch[branch] ?? 0 : Object.values(p.stockByBranch).reduce((a, v) => a + v, 0)
    }
  }
}
