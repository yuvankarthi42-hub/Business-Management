// Helpers for the product admin modules.
import type { AdminAuditLog, Business, SubscriptionPeriod } from '@/core/types'
import { addMonths, dateInputToEnd, endOfDay, periodAmount, subscriptionState } from '@/core/subscription'
import type { AdminSession, Ctx } from '../../core/context'
import { ApiError } from '../../core/errors'
import type { Row } from '../../db/types'
import { loginFree } from '../../domain/directory'
import { pricePerBranch } from '../../domain/session'
import { LOGO_EMOJI as LOGO } from '../../domain/business'
import { code, E, fromMinor, nameOf, str, strOrNull, toMinor } from '../../domain/util'

export type Validity = { months: number } | { endDate: string }

export async function adminLog(c: Ctx, a: AdminSession, action: AdminAuditLog['action'], b: { id: string; name: string } | null, detail: string) {
  await c.platform.insert('admin_audit_logs', {
    admin_id: a.id, admin_name: a.name, business_id: b?.id ?? null, business_name: b?.name ?? '',
    action: code(E.AdminAction, action), detail: detail.slice(0, 255),
  })
}
export function adminLogFrom(r: Row): AdminAuditLog {
  return {
    id: r.ROWID, at: r.CREATEDTIME, adminId: str(r.admin_id), adminName: str(r.admin_name), action: nameOf(E.AdminAction, r.action) as AdminAuditLog['action'],
    businessId: strOrNull(r.business_id), businessName: str(r.business_name), detail: str(r.detail),
  }
}

export function periodFor(v: Validity, from: Date) {
  const start = new Date(from)
  if ('months' in v) {
    if (![1, 2, 3, 6, 12, 24].includes(v.months)) throw new ApiError('Choose a validity period')
    const end = new Date(addMonths(start, v.months).getTime() - 86_400_000)
    return { startAt: start.toISOString(), endAt: endOfDay(end), months: v.months }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.endDate)) throw new ApiError('Choose an end date')
  const endAt = dateInputToEnd(v.endDate)
  if (new Date(endAt) <= start) throw new ApiError('The end date must be after the start date')
  return { startAt: start.toISOString(), endAt, months: null as number | null }
}

export async function addPeriod(c: Ctx, a: AdminSession, businessId: string, branches: number, kind: SubscriptionPeriod['kind'], startAt: string, endAt: string, months: number | null, note: string) {
  const price = await pricePerBranch(c.platform)
  await c.platform.insert('subscription_periods', {
    business_id: businessId, kind: code(E.PeriodKind, kind), start_at: startAt, end_at: endAt, months, branches,
    price_per_branch_minor: toMinor(price) ?? 0, amount_minor: toMinor(periodAmount(branches, price, months, startAt, endAt)) ?? 0,
    note: note.trim().slice(0, 255), admin_id: a.id,
  })
}
export function periodFrom(r: Row): SubscriptionPeriod {
  return {
    id: r.ROWID, businessId: str(r.business_id), kind: nameOf(E.PeriodKind, r.kind) as SubscriptionPeriod['kind'], startAt: str(r.start_at), endAt: str(r.end_at),
    months: r.months == null ? null : Number(r.months), branches: Number(r.branches), pricePerBranch: fromMinor(r.price_per_branch_minor), amount: fromMinor(r.amount_minor),
    note: str(r.note), createdAt: r.CREATEDTIME, createdBy: str(r.admin_id),
  }
}

/** Just the fields the admin screens need from a businesses row (no settings reads). */
export function businessLite(r: Row) {
  const category = nameOf(E.BusinessCategory, r.category) as Business['category']
  const start = strOrNull(r.subscription_start_at), end = strOrNull(r.subscription_end_at)
  const status = nameOf(E.BusinessStatus, r.status) as Business['status']
  const st = subscriptionState({ status, subscription: start && end ? { startAt: start, endAt: end } : undefined })
  return {
    id: r.ROWID, name: str(r.name), category, subType: str(r.sub_type), logoEmoji: LOGO[category], onboarded: !!r.onboarded_at, createdAt: r.CREATEDTIME,
    status: status ?? 'active', st, maxBranches: Number(r.max_branches ?? 1), phone: str(r.phone), address: str(r.address), gstin: str(r.gstin),
    adminNote: str(r.admin_note), remindersPaused: !!r.reminders_paused, subscription: start && end ? { startAt: start, endAt: end } : undefined,
  }
}

export async function findBiz(c: Ctx, id: string) {
  const r = /^\d+$/.test(String(id)) ? await c.platform.get('businesses', String(id)) : null
  if (!r || r.deleted_at) throw new ApiError('Customer not found', 404, 'NOT_FOUND')
  return r
}

/** The owner login of a business (the user the product admin created), from the shop's database. */
export async function ownerOf(c: Ctx, businessId: string): Promise<Row | null> {
  const b = await c.platform.get('businesses', businessId)
  const db = await c.shopDb(businessId)
  if (b?.owner_user_id) { const u = await db.get('users', str(b.owner_user_id)); if (u) return u }
  return db.first('users', { business_id: businessId, username: { ne: null } }, [['ROWID', 'ASC']])
}

export function checkUsernameFormat(raw: string) {
  const u = String(raw ?? '').trim().toLowerCase()
  if (!/^[a-z0-9._-]{4,30}$/.test(u)) throw new ApiError('Username: 4–30 letters, numbers, dot, dash or underscore (no spaces)')
  return u
}
/** Usernames are unique across every shop's logins and the admins. */
export async function checkUsername(c: Ctx, raw: string, self?: { businessId: string; userId: string }) {
  const u = checkUsernameFormat(raw)
  if (!(await loginFree(c, 'username', u, self))) throw new ApiError(`Username ${u} is already taken`)
  return u
}
export function checkBranches(n: number) {
  const v = Math.floor(Number(n))
  if (!(v >= 1 && v <= 100)) throw new ApiError('Branch limit must be between 1 and 100')
  return v
}
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
