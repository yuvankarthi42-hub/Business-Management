// Reports for finished days (the range ends before today) are kept in the shared cache: those figures only change
// when something rewrites the past — a return, a void, a payment for an old bill, an expense, a product's cost…
// Every write except the ones that only add today's sales bumps the shop's report version (app.ts), so a cached
// report is never older than the data it was made from. Today's reports are always worked out fresh.
import type { Ctx } from '../core/context'

const verKey = (bid: string) => `repv:${bid}`
const MAX_BYTES = 400_000

export async function bumpReports(c: Ctx, bid: string) {
  await c.shared.set(verKey(bid), Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 24)
}

/** The cached report for a finished range, or `build()` once (and keep it). */
export async function pastReport<T>(c: Ctx, key: string, build: () => Promise<T>): Promise<T> {
  const bid = c.businessId
  const k = `rep:${bid}:${key}`
  const [ver, raw] = await Promise.all([c.shared.get(verKey(bid)), c.shared.get(k)])
  if (raw) { try { const s = JSON.parse(raw) as { v: string | null; value: T }; if (s.v === ver) return s.value } catch { /* rebuild */ } }
  const value = await build()
  const json = JSON.stringify({ v: ver, value })
  if (json.length <= MAX_BYTES) await c.shared.set(k, json, 6)
  return value
}
