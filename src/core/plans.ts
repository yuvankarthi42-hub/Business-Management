// Subscription prices by business type (Admin → Pricing), and a customer's own price when the product admin
// sets one for that customer only. Pure functions: the server, the demo app and the admin screens use the same.
import type { Business } from './types'
import { isTextileShop } from './stickers'

export type PlanKey = 'food' | 'restaurant' | 'textile' | 'retail' | 'service'

/** ₹ per month for the first branch, ₹ for a year (usually 2 months free), ₹ per month for each extra branch. */
export interface PlanPrice { month: number; year: number; extraBranch: number }
export type PlanPrices = Record<PlanKey, PlanPrice>

export const PLAN_KEYS: PlanKey[] = ['food', 'restaurant', 'textile', 'retail', 'service']
export const PLAN_LABEL: Record<PlanKey, { name: string; hint: string }> = {
  food: { name: 'Fast food / food shops', hint: 'Tea, juice, bakery, sweets, fast food' },
  restaurant: { name: 'Hotels / restaurants', hint: 'Dine-in, tables, kitchen' },
  textile: { name: 'Silk / textile shops', hint: 'Sarees, fabrics, garments' },
  retail: { name: 'Retail shops', hint: 'Grocery, supermarket, hardware, others' },
  service: { name: 'Service businesses', hint: 'Salon, laundry, repair' },
}

export const DEFAULT_PLANS: PlanPrices = {
  food: { month: 399, year: 3999, extraBranch: 249 },
  restaurant: { month: 799, year: 7999, extraBranch: 499 },
  textile: { month: 999, year: 9999, extraBranch: 599 },
  retail: { month: 399, year: 3999, extraBranch: 249 },
  service: { month: 399, year: 3999, extraBranch: 249 },
}

/** The type a new customer starts as when the product admin picks its plan (the owner can change it at set-up). */
export const PLAN_START: Record<PlanKey, { category: Business['category']; subType: string }> = {
  food: { category: 'food', subType: 'Fast Food' }, restaurant: { category: 'restaurant', subType: 'Restaurant' },
  textile: { category: 'retail', subType: 'Silk & Sarees' }, retail: { category: 'retail', subType: 'Grocery / Maligai' }, service: { category: 'service', subType: 'Salon' },
}

/** Which price list a business is on. Textile shops are stored as retail, so their sub-type decides. */
export function planKeyFor(b: Pick<Business, 'category' | 'subType'>): PlanKey {
  if (b.category === 'retail' && isTextileShop(b)) return 'textile'
  return b.category === 'food' || b.category === 'restaurant' || b.category === 'retail' || b.category === 'service' ? b.category : 'retail'
}

const MAX = 1_000_000
/** A checked price (whole rupees, 0 – 10 lakh), or null when something is missing or wrong. */
export function cleanPlanPrice(v: unknown): PlanPrice | null {
  const o = v as Partial<PlanPrice> | null | undefined
  if (!o || typeof o !== 'object') return null
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX ? Math.round(x) : null)
  const month = n(o.month), year = n(o.year), extraBranch = n(o.extraBranch)
  return month === null || year === null || extraBranch === null ? null : { month, year, extraBranch }
}

/** The saved price lists, with the defaults for any type not saved yet. */
export function plansFrom(saved: Partial<Record<PlanKey, unknown>> | null | undefined): PlanPrices {
  const out = { ...DEFAULT_PLANS }
  for (const k of PLAN_KEYS) { const p = cleanPlanPrice(saved?.[k]); if (p) out[k] = p }
  return out
}

/** This customer's price: their own price if the product admin set one, otherwise their business type's. */
export function priceFor(plans: PlanPrices, custom: Record<string, PlanPrice> | null | undefined, b: Pick<Business, 'id' | 'category' | 'subType'>) {
  const plan = planKeyFor(b)
  const own = custom?.[b.id] ? cleanPlanPrice(custom[b.id]) : null
  return { plan, price: own ?? plans[plan], custom: !!own }
}

/** What the customer pays each month for this many branches. */
export const monthlyValue = (p: PlanPrice, branches: number) => p.month + Math.max(0, branches - 1) * p.extraBranch

/**
 * The amount for a period. Whole years use the yearly price (extra branches also get 2 months free: × 10);
 * remaining months use the monthly price; a custom end date is charged per day at the monthly rate.
 */
export function planAmount(p: PlanPrice, branches: number, months: number | null, startAt: string, endAt: string) {
  const extra = Math.max(0, branches - 1)
  if (months) {
    const years = Math.floor(months / 12), rest = months % 12
    return Math.round(years * (p.year + extra * p.extraBranch * 10) + rest * monthlyValue(p, branches))
  }
  const days = Math.max(1, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000))
  return Math.round(monthlyValue(p, branches) * (days / 30))
}

/** "₹999 + 1 extra branch × ₹599 = ₹1,598 / month" style text for the admin screens. */
export function priceBreakdown(p: PlanPrice, branches: number, months: number | null) {
  const r = (x: number) => `₹${x.toLocaleString('en-IN')}`
  const extra = Math.max(0, branches - 1)
  const years = months ? Math.floor(months / 12) : 0, rest = months ? months % 12 : 0
  const parts: string[] = []
  if (years) parts.push(`${years > 1 ? `${years} × ` : ''}${r(p.year)}/year${extra ? ` + ${extra} extra branch${extra === 1 ? '' : 'es'} × ${r(p.extraBranch * 10)}/year` : ''}`)
  if (rest || !months) parts.push(`${rest ? `${rest} month${rest === 1 ? '' : 's'} × ` : ''}${r(p.month)}${extra ? ` + ${extra} × ${r(p.extraBranch)}` : ''}${months ? '' : '/month, per day'}`)
  return parts.join(' + ')
}
