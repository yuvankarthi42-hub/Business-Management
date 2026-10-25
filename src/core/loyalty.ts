// Loyalty points rules, shared by the app, the demo API and the backend.
import { r2 } from './pricing'
import type { Business, LoyaltySettings, OrderItem } from './types'

export const DEFAULT_LOYALTY: LoyaltySettings = {
  enabled: false, spendPerPoint: 100, pointValue: 1, minRedeem: 100, maxBillPct: 20, expiryMonths: 12, earnOnDiscounted: true,
}

export const loyaltyOf = (b: Pick<Business, 'loyalty'>): LoyaltySettings => ({ ...DEFAULT_LOYALTY, ...(b.loyalty ?? {}) })
export const loyaltyOn = (b: Pick<Business, 'loyalty'>) => !!b.loyalty?.enabled

/** Checks a settings change from the browser. */
export function cleanLoyalty(x: Partial<LoyaltySettings> | null | undefined, cur: LoyaltySettings = DEFAULT_LOYALTY): LoyaltySettings {
  const v = { ...cur, ...(x ?? {}) }
  const num = (n: unknown) => Number(n)
  const out: LoyaltySettings = {
    enabled: v.enabled === true,
    spendPerPoint: num(v.spendPerPoint), pointValue: r2(num(v.pointValue)), minRedeem: Math.floor(num(v.minRedeem)),
    maxBillPct: num(v.maxBillPct), expiryMonths: Math.floor(num(v.expiryMonths)), earnOnDiscounted: v.earnOnDiscounted !== false,
  }
  if (!(out.spendPerPoint >= 1 && out.spendPerPoint <= 100000)) throw new Error('Spend for 1 point must be between ₹1 and ₹1,00,000')
  if (!(out.pointValue > 0 && out.pointValue <= 1000)) throw new Error('Value of 1 point must be more than ₹0')
  if (!(out.minRedeem >= 0 && out.minRedeem <= 1_000_000)) throw new Error('Minimum points to use must be 0 or more')
  if (!(out.maxBillPct > 0 && out.maxBillPct <= 100)) throw new Error('Points can pay between 1% and 100% of a bill')
  if (!(out.expiryMonths >= 0 && out.expiryMonths <= 120)) throw new Error('Expiry must be between 0 (never) and 120 months')
  return out
}

/** Points a paid bill earns: whole points only. Lines sold below MRP are left out when the shop says so. */
export function pointsToEarn(s: LoyaltySettings, total: number, items: Pick<OrderItem, 'qty' | 'unitPrice' | 'mrp'>[] = []) {
  if (!s.enabled || !(total > 0)) return 0
  let base = total
  if (!s.earnOnDiscounted && items.length) {
    const all = items.reduce((a, i) => a + i.qty * i.unitPrice, 0)
    const full = items.filter((i) => !i.mrp).reduce((a, i) => a + i.qty * i.unitPrice, 0)
    base = all > 0 ? (total * full) / all : 0
  }
  return Math.floor(r2(base) / s.spendPerPoint)
}

export const pointsValue = (s: LoyaltySettings, points: number) => r2(points * s.pointValue)

/** The most points a customer can use on a bill of this total (before points). */
export function maxRedeemable(s: LoyaltySettings, balance: number, billTotal: number) {
  if (!s.enabled || balance < Math.max(1, s.minRedeem)) return 0
  const cap = Math.floor((billTotal * s.maxBillPct) / 100 / s.pointValue + 1e-9)
  return Math.max(0, Math.min(balance, cap))
}

/** Why these points can't be used — empty when they can. */
export function redeemError(s: LoyaltySettings, points: number, balance: number, billTotal: number) {
  if (!s.enabled) return 'Loyalty points are turned off'
  if (!Number.isInteger(points) || points <= 0) return 'Enter the points to use'
  if (points > balance) return `The customer has only ${balance} points`
  if (points < s.minRedeem) return `At least ${s.minRedeem} points are needed to use them`
  const max = maxRedeemable(s, balance, billTotal)
  if (points > max) return `Points can pay up to ${s.maxBillPct}% of this bill — ${max} points`
  return ''
}

/** Expiry date (YYYY-MM-DD) for points earned on `day`; null = never. */
export function pointsExpiry(s: LoyaltySettings, day: string) {
  if (!s.expiryMonths) return null
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + s.expiryMonths, d))
  return t.toISOString().slice(0, 10)
}

/** Points taken back when part of a bill is returned (in proportion; never more than were earned). */
export const pointsForReturn = (earned: number, billTotal: number, returned: number) =>
  earned > 0 && billTotal > 0 ? Math.min(earned, Math.floor((earned * Math.min(returned, billTotal)) / billTotal)) : 0
