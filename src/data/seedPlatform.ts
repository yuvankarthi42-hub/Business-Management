// Product admin + customer subscriptions for the demo data.
import { addMonths, endOfDay, periodAmount } from '@/core/subscription'
import type { Business } from '@/core/types'
import type { DB } from './db'

const DEMO_PLANS: Record<string, { username: string; startDaysAgo: number; months: number; maxBranches?: number }> = {
  biz_foodcorner: { username: 'foodcorner', startDaysAgo: 60, months: 12, maxBranches: 3 },
  biz_freshmart: { username: 'freshmart', startDaysAgo: 20, months: 6, maxBranches: 2 },
  biz_murugan_hw: { username: 'murugan', startDaysAgo: 24, months: 1 }, // expires in a few days
  biz_sweetspot: { username: 'sweetspot', startDaysAgo: 63, months: 2 }, // already expired → read-only
  biz_kanchi_silks: { username: 'kanchisilks', startDaysAgo: 15, months: 12 },
}
export const DEFAULT_PRICE_PER_BRANCH = 499

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)

/** Give every business a subscription, branch limit and an owner username; create the product admin. */
export function seedPlatform(d: DB) {
  d.admins ??= []
  d.subscriptionPeriods ??= []
  d.adminAudit ??= []
  d.platform ??= { pricePerBranchMonth: DEFAULT_PRICE_PER_BRANCH }
  if (!d.admins.length) d.admins.push({ id: 'adm_1', name: 'Kadai Kalanjiyam Admin', username: 'admin', password: 'demo123', role: 'super', active: true, createdAt: new Date().toISOString() })
  const taken = new Set(d.users.map((u) => u.username).filter(Boolean))
  for (const b of d.businesses) {
    const plan = DEMO_PLANS[b.id]
    const branches = d.branches.filter((x) => x.businessId === b.id).length
    if (!b.subscription) {
      const start = new Date(); start.setDate(start.getDate() - (plan?.startDaysAgo ?? 0)); start.setHours(0, 0, 0, 0)
      const months = plan?.months ?? 1
      const endAt = endOfDay(new Date(addMonths(start, months).getTime() - 86_400_000))
      b.subscription = { startAt: start.toISOString(), endAt }
      b.maxBranches ??= Math.max(1, plan?.maxBranches ?? branches)
      b.status ??= 'active'
      d.subscriptionPeriods.push({
        id: `sub_${b.id}`, businessId: b.id, kind: 'new', startAt: b.subscription.startAt, endAt, months, branches: b.maxBranches,
        pricePerBranch: d.platform.pricePerBranchMonth, amount: periodAmount(b.maxBranches, d.platform.pricePerBranchMonth, months, b.subscription.startAt, endAt),
        note: 'Demo account', createdAt: b.subscription.startAt, createdBy: 'adm_1',
      })
    }
    b.maxBranches ??= Math.max(1, branches)
    b.status ??= 'active'
    const owner = ownerOf(d, b)
    if (owner && !owner.username) {
      let name = plan?.username ?? (slug(b.name) || `shop${owner.phone.slice(-4)}`)
      while (taken.has(name)) name = `${name}1`
      owner.username = name
      taken.add(name)
    }
  }
}

/** The account the admin hands over: the first user with full access. */
export function ownerOf(d: DB, b: Pick<Business, 'id'>) {
  const full = new Set(d.roles.filter((r) => r.businessId === b.id && (r.permissions as string[]).includes('*')).map((r) => r.id))
  return d.users.find((u) => u.businessId === b.id && full.has(u.roleId)) ?? d.users.find((u) => u.businessId === b.id)
}

/** v16: admin roles, two more demo admins, and recent sign-ins for the usage report. */
export function seedAdminTeam(d: DB) {
  for (const a of d.admins) a.role ??= 'super'
  const t = new Date().toISOString()
  if (!d.admins.some((a) => a.username === 'manager')) d.admins.push({ id: 'adm_manager', name: 'Priya (Accounts)', username: 'manager', password: 'demo123', role: 'manager', active: true, createdAt: t, lastLoginAt: null })
  if (!d.admins.some((a) => a.username === 'support')) d.admins.push({ id: 'adm_support', name: 'Arun (Support)', username: 'support', password: 'demo123', role: 'support', active: true, createdAt: t, lastLoginAt: null })
  const ago = (days: number) => { const x = new Date(); x.setDate(x.getDate() - days); x.setHours(10, 15, 0, 0); return x.toISOString() }
  const recent: Record<string, number> = { biz_foodcorner: 0, biz_freshmart: 1, biz_murugan_hw: 3, biz_sweetspot: 9, biz_kanchi_silks: 0 }
  for (const [biz, days] of Object.entries(recent)) {
    const b = d.businesses.find((x) => x.id === biz)
    const owner = b && ownerOf(d, b)
    if (owner && !owner.lastLoginAt) owner.lastLoginAt = ago(days)
  }
}
