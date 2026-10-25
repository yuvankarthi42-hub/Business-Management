// Customers' all-time totals (bought, bills, dues, last visit) for the customer list, kept in the shared cache.
// Any bill, payment, return, points or customer change bumps the version (app.ts), so the copy is never stale.
import type { Ctx } from '../core/context'

const verKey = (bid: string) => `cstv:${bid}`
const MAX_BYTES = 400_000

export async function bumpCustomerStats(c: Ctx, bid: string) {
  await c.shared.set(verKey(bid), Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 24)
}

export async function cachedStats<T>(c: Ctx, read: () => Promise<T>): Promise<T> {
  const bid = c.businessId
  const k = `cst:${bid}`
  const [ver, raw] = await Promise.all([c.shared.get(verKey(bid)), c.shared.get(k)])
  if (raw) { try { const s = JSON.parse(raw) as { v: string | null; value: T }; if (s.v === ver) return s.value } catch { /* read again */ } }
  const value = await read()
  const json = JSON.stringify({ v: ver, value })
  if (json.length <= MAX_BYTES) await c.shared.set(k, json, 6)
  return value
}
