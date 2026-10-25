// QR menu and TV specials board, kept in the shared cache (Catalyst Cache) so a scan usually reads no database.
// A copy is used while: the shop's menu version is unchanged (any product / category / price / special / table /
// settings change, or a bill that changed stock, bumps it — app.ts), it is the same business day (specials are
// per day), and it is under 5 minutes old (a safety net in case a cache write was lost). Ordering is never
// trusted to the copy: placeOrder re-checks prices, stock and the account on every order.
import type { Ctx } from '../core/context'

const MAX_AGE = 5 * 60_000
const verKey = (bid: string) => `menuv:${bid}`

export async function bumpMenu(c: Ctx, bid: string) {
  await c.shared.set(verKey(bid), Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 24)
}

const dayIn = (tz: string, d = new Date()) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) }
  catch { return d.toISOString().slice(0, 10) }
}

/** The cached copy, or `build()` once (and keep it). `key` must only contain checked ids. */
export async function cachedPublic<T>(c: Ctx, bid: string, key: string, build: () => Promise<{ value: T; tz: string }>): Promise<T> {
  const k = `pub:${bid}:${key}`
  const [ver, raw] = await Promise.all([c.shared.get(verKey(bid)), c.shared.get(k)])
  if (raw) {
    try {
      const s = JSON.parse(raw) as { v: string | null; at: number; tz: string; day: string; value: T }
      if (s.v === ver && Date.now() - s.at < MAX_AGE && s.day === dayIn(s.tz)) return s.value
    } catch { /* rebuild */ }
  }
  const { value, tz } = await build()
  await c.shared.set(k, JSON.stringify({ v: ver, at: Date.now(), tz, day: dayIn(tz), value }), 1)
  return value
}

/** Which branch a table belongs to (so every table of a branch shares one cached menu). Checked against the version. */
export async function tableBranch(c: Ctx, bid: string, tableId: string): Promise<string | null> {
  const [ver, raw] = await Promise.all([c.shared.get(verKey(bid)), c.shared.get(`pubt:${bid}:${tableId}`)])
  const m = raw ? /^(.*)\|([A-Za-z0-9_-]+)$/.exec(raw) : null
  return m && m[1] === String(ver) ? m[2] : null
}
export async function rememberTableBranch(c: Ctx, bid: string, tableId: string, branchId: string) {
  const ver = await c.shared.get(verKey(bid))
  await c.shared.set(`pubt:${bid}:${tableId}`, `${ver}|${branchId}`, 1)
}

