// QR menu and TV specials board, kept in the shared cache (Catalyst Cache) so a scan usually reads no database.
// A copy is used while: the shop's menu version is unchanged (any product / category / price / special / table /
// settings change, or a bill that changed stock, bumps it — app.ts), it is the same business day (specials are
// per day), and it is under 5 minutes old (a safety net in case a cache write was lost). Ordering is never
// trusted to the copy: placeOrder re-checks prices, stock and the account on every order.
import type { Ctx } from '../core/context'
import { dateFormat } from '@/core/intl'
import { RawJson } from '../core/rawJson'

const MAX_AGE = 5 * 60_000
const verKey = (bid: string) => `menuv:${bid}`

/** Every shop's copies at once (the product admin released or withdrew QR Orders / Daily Specials). */
const ALL_KEY = 'menuv:*'

export async function bumpMenu(c: Ctx, bid: string) {
  await c.shared.set(verKey(bid), Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 24)
}
export async function bumpAllMenus(c: Ctx) {
  await c.shared.set(ALL_KEY, Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 24)
}

const dayIn = (tz: string, d = new Date()) => {
  try { return dateFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) }
  catch { return d.toISOString().slice(0, 10) }
}

/**
 * The cached copy, or `build()` once (and keep it). `key` must only contain checked ids. Kept as one line of
 * checks (version, time, day) and then the answer's JSON text, which is sent as it is (no read-back, no re-encode).
 */
export async function cachedPublic<T>(c: Ctx, bid: string, key: string, build: () => Promise<{ value: T; tz: string }>): Promise<RawJson> {
  const k = `pubj:${bid}:${key}`
  const [own, all, raw] = await Promise.all([c.shared.get(verKey(bid)), c.shared.get(ALL_KEY), c.shared.get(k)])
  const ver = all ? `${own ?? ''}|${all}` : own
  const nl = raw ? raw.indexOf('\n') : -1
  if (raw && nl > 0) {
    try {
      const s = JSON.parse(raw.slice(0, nl)) as { v: string | null; at: number; tz: string; day: string }
      if (s.v === ver && Date.now() - s.at < MAX_AGE && s.day === dayIn(s.tz)) return new RawJson(raw.slice(nl + 1))
    } catch { /* rebuild */ }
  }
  const { value, tz } = await build()
  const text = JSON.stringify(value === undefined ? null : value)
  await c.shared.set(k, `${JSON.stringify({ v: ver, at: Date.now(), tz, day: dayIn(tz) })}\n${text}`, 1)
  return new RawJson(text)
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

