// Customer subscription rules — pure functions so the server can use the same logic.
import type { Business } from './types'

export type SubState = 'active' | 'expiring' | 'expired' | 'deactivated'
export const EXPIRING_DAYS = 7
export const VALIDITY_OPTIONS = [
  { months: 1, label: '1 month' },
  { months: 2, label: '2 months' },
  { months: 6, label: '6 months' },
  { months: 12, label: '1 year' },
] as const

const DAY = 86_400_000

/**
 * Subscriptions follow the platform's calendar (India), wherever the code runs: the API runs in UTC, the
 * browser in the user's zone. A subscription runs until 23:59:59 India time on its last day.
 */
export const PLATFORM_TZ = 'Asia/Kolkata'

/** 'YYYY-MM-DD' of the moment `d` in the zone. */
export function ymdIn(d: Date, tz = PLATFORM_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
/** Minutes the zone is ahead of UTC at that moment (India: 330). */
function offsetMinutes(at: Date, tz: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? ''
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}
/** "YYYY-MM-DD" → 23:59:59.999 of that day in the platform's zone, as ISO. */
export function dateInputToEnd(ymd: string, tz = PLATFORM_TZ) {
  const guess = Date.parse(`${ymd}T23:59:59.999Z`)
  return new Date(guess - offsetMinutes(new Date(guess), tz) * 60_000).toISOString()
}
/** End of the platform-zone day that `d` falls on, as ISO. */
export const endOfDay = (d: Date, tz = PLATFORM_TZ) => dateInputToEnd(ymdIn(d, tz), tz)
/** Same time of day, `months` later on the platform's calendar (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(from: Date, months: number, tz = PLATFORM_TZ) {
  const [y, m, d] = ymdIn(from, tz).split('-').map(Number)
  const total = m - 1 + months
  const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12
  const nd = Math.min(d, new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate())
  return new Date(from.getTime() + (Date.UTC(ny, nm, nd) - Date.UTC(y, m - 1, d)))
}

export function subscriptionState(b: Pick<Business, 'status' | 'subscription'>, now = new Date()) {
  const endAt = b.subscription?.endAt ?? null
  const daysLeft = endAt ? Math.ceil((new Date(endAt).getTime() - now.getTime()) / DAY) : 0
  const expired = !endAt || new Date(endAt).getTime() < now.getTime()
  const state: SubState = b.status === 'deactivated' ? 'deactivated' : expired ? 'expired' : daysLeft <= EXPIRING_DAYS ? 'expiring' : 'active'
  return { state, daysLeft: expired ? 0 : daysLeft, endAt, startAt: b.subscription?.startAt ?? null, readOnly: state === 'expired', blocked: state === 'deactivated' }
}

/** Price for a period: branches × months × price per branch per month (custom dates are charged per day). */
export function periodAmount(branches: number, pricePerBranchMonth: number, months: number | null, startAt: string, endAt: string) {
  if (months) return Math.round(branches * months * pricePerBranchMonth)
  const days = Math.max(1, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / DAY))
  return Math.round(branches * pricePerBranchMonth * (days / 30))
}

export const READ_ONLY_MESSAGE = 'Your subscription has expired, so the account is read-only. Contact the product admin to renew.'
export const DEACTIVATED_MESSAGE = 'This account has been deactivated. Please contact the product admin.'
export const branchLimitMessage = (max: number) => `Your plan allows ${max} branch${max === 1 ? '' : 'es'}. Contact the product admin to add more branches.`
