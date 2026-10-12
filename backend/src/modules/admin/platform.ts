// Product admin: feature releases, the admin team, support view, usage report, platform settings and the admin audit log.
import { ADMIN_ROLES } from '@/core/adminRoles'
import { FEATURES, type FeatureFlag, type FeatureKey } from '@/core/features'
import type { AdminRole } from '@/core/types'
import type { AdminSession, Ctx } from '../../core/context'
import { ApiError } from '../../core/errors'
import { assertPassword, hashPassword } from '../../core/passwords'
import { adminRead, adminWrite, define } from '../../core/registry'
import { signToken } from '../../core/tokens'
import type { Row } from '../../db/types'
import { bumpEpoch, featureFlags, pricePerBranch, type UserClaims } from '../../domain/session'
import { code, E, fromMinor, getPlatformSetting, nameOf, putPlatformSetting, r2, str, strOrNull } from '../../domain/util'
import { acrossShops } from '../../domain/directory'
import { adminView } from './auth'
import { adminLog, adminLogFrom, businessLite, checkUsernameFormat, findBiz, ownerOf } from './shared'

export const SUPPORT_TOKEN_TTL = 2 * 3600
const DAY = 86_400_000
const OFF: FeatureFlag = { mode: 'off', businessIds: [] }

const isFeature = (key: unknown): key is FeatureKey => typeof key === 'string' && Object.prototype.hasOwnProperty.call(FEATURES, key)
const isRole = (role: unknown): role is AdminRole => typeof role === 'string' && Object.prototype.hasOwnProperty.call(ADMIN_ROLES, role)
const adminFrom = (a: Row): AdminSession => ({ id: a.ROWID, name: str(a.name), username: str(a.username), role: nameOf(E.AdminRole, a.role) as AdminRole })
const activeSupers = (c: Ctx) => c.platform.count('platform_admins', { is_active: true, role: E.AdminRole.super })

// ---------- feature flags ----------

/** Writes one flag (feature_flags + feature_flag_businesses), logs it, and makes every cached session stale. */
async function applyFeature(c: Ctx, key: FeatureKey, flag: FeatureFlag) {
  const a = c.requireAdmin('features.manage')
  if (!isFeature(key)) throw new ApiError('Unknown feature')
  if (!flag || !['off', 'selected', 'all'].includes(flag.mode)) throw new ApiError('Choose who gets it')
  const asked = [...new Set((Array.isArray(flag.businessIds) ? flag.businessIds : []).map(String))].filter((id) => /^\d{1,20}$/.test(id))
  const found: Row[] = []
  for (let i = 0; i < asked.length; i += 100) found.push(...await c.platform.select('businesses', { where: { ROWID: { in: asked.slice(i, i + 100) }, deleted_at: null } }))
  const ids = asked.filter((id) => found.some((b) => b.ROWID === id))
  const before = (await featureFlags(c.platform))[key] ?? OFF

  const f = FEATURES[key]
  let row = await c.platform.first('feature_flags', { feature_key: key })
  const cols = { name: f.name, description: f.description.slice(0, 255), rollout: code(E.Rollout, flag.mode), updated_by: a.id }
  if (row) await c.platform.update('feature_flags', row.ROWID, cols)
  else row = await c.platform.insert('feature_flags', { feature_key: key, ...cols })
  const cur = await c.platform.select('feature_flag_businesses', { where: { feature_flag_id: row.ROWID } })
  const drop = cur.filter((x) => !ids.includes(str(x.business_id))).map((x) => x.ROWID)
  if (drop.length) await c.platform.deleteMany('feature_flag_businesses', drop)
  const add = ids.filter((id) => !cur.some((x) => str(x.business_id) === id))
  if (add.length) await c.platform.insertMany('feature_flag_businesses', add.map((id) => ({ feature_flag_id: row!.ROWID, business_id: id, uniq_key: `${row!.ROWID}:${id}` })))

  // Names for the log: the newly added ones are in `found`; removed ones need a read.
  const removedIds = before.businessIds.filter((x) => !ids.includes(x))
  const removedRows = removedIds.length ? await c.platform.select('businesses', { where: { ROWID: { in: removedIds.slice(0, 100) } } }) : []
  const nameOfBiz = (id: string, rows: Row[]) => str(rows.find((b) => b.ROWID === id)?.name)
  const added = ids.filter((x) => !before.businessIds.includes(x)).map((x) => nameOfBiz(x, found)).filter(Boolean)
  const removed = removedIds.map((x) => nameOfBiz(x, removedRows)).filter(Boolean)
  const who = flag.mode === 'all' ? 'all customers' : flag.mode === 'off' ? 'off' : `${ids.length} selected customer${ids.length === 1 ? '' : 's'}`
  await adminLog(c, a, 'feature', null, `${f.name}: ${who}${added.length ? ` · added ${added.join(', ')}` : ''}${removed.length ? ` · removed ${removed.join(', ')}` : ''}`)
  // Features are part of every cached customer session.
  await bumpEpoch(c, 'global')
}

// ---------- usage report ----------

async function usage(c: Ctx) {
  const now = c.now.getTime()
  const businesses = await c.platform.select('businesses', { where: { deleted_at: null } })
  const iso = (ms: number) => new Date(ms).toISOString()
  // Subscription money by the month it was recorded, last 12 months (calendar months in UTC).
  const months: { key: string; label: string; amount: number; customers: number }[] = []
  const base = new Date(Date.UTC(c.now.getUTCFullYear(), c.now.getUTCMonth(), 1))
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
    months.push({ key: `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`, label: m.toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }), amount: 0, customers: 0 })
  }
  const firstMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 11, 1)).toISOString()
  const completed = { status: E.OrderStatus.completed }
  const ids = businesses.map((b) => b.ROWID)
  // Per shop: 3 small GROUP BY reads. Branches and the last sign-in come from the directory copies.
  const [b30, b7, lastBills, periods, price] = await Promise.all([
    acrossShops(c, ids, 'orders', { where: { ...completed, billed_at: { gte: iso(now - 30 * DAY) } }, fns: { n: ['COUNT', 'ROWID'], sales: ['SUM', 'total_minor'] } }),
    acrossShops(c, ids, 'orders', { where: { ...completed, billed_at: { gte: iso(now - 7 * DAY) } }, fns: { n: ['COUNT', 'ROWID'] } }),
    acrossShops(c, ids, 'orders', { where: completed, fns: { last: ['MAX', 'billed_at'] } }),
    c.platform.select('subscription_periods', { where: { CREATEDTIME: { gte: firstMonth } } }),
    pricePerBranch(c.platform),
  ])
  const of = (rows: Record<string, unknown>[], id: string) => rows.find((x) => String(x.business_id) === id)
  const rows = businesses.map((r) => {
    const b = businessLite(r)
    const lastBill = strOrNull(of(lastBills, b.id)?.last as string)
    return {
      id: b.id, name: b.name || '(setup not finished)', subType: b.subType, state: b.st.state,
      bills7: Number(of(b7, b.id)?.n ?? 0),
      bills30: Number(of(b30, b.id)?.n ?? 0),
      sales30: fromMinor(of(b30, b.id)?.sales as number | undefined),
      lastBillAt: lastBill ? new Date(lastBill).toISOString() : null,
      lastLoginAt: strOrNull(r.last_login_at),
      branches: Number(r.branches_used ?? 0),
      monthlyPrice: b.maxBranches * price,
    }
  })
  for (const p of periods) { const m = months.find((x) => x.key === p.CREATEDTIME.slice(0, 7)); if (m) m.amount = r2(m.amount + fromMinor(p.amount_minor)) }
  for (const b of businesses) { const m = months.find((x) => x.key === b.CREATEDTIME.slice(0, 7)); if (m) m.customers++ }
  const live = rows.filter((r) => r.state !== 'deactivated' && r.state !== 'expired')
  return {
    rows,
    months,
    summary: {
      customers: rows.length,
      billing7: rows.filter((r) => r.bills7 > 0).length,
      inactive14: rows.filter((r) => !r.lastBillAt || now - new Date(r.lastBillAt).getTime() > 14 * DAY).length,
      logins7: rows.filter((r) => r.lastLoginAt && now - new Date(r.lastLoginAt).getTime() <= 7 * DAY).length,
      mrr: live.reduce((a, r) => a + r.monthlyPrice, 0),
      thisMonth: months[months.length - 1].amount,
      last12: r2(months.reduce((a, m) => a + m.amount, 0)),
    },
  }
}

const platformSettings = async (c: Ctx) => ({ pricePerBranchMonth: await pricePerBranch(c.platform), features: await featureFlags(c.platform) })

define('admin', {
  // ---- Feature releases ----
  features: adminRead('customers.view', async (c) => {
    const flags = await featureFlags(c.platform)
    return (Object.keys(FEATURES) as FeatureKey[]).map((key) => ({ key, ...FEATURES[key], flag: flags[key] ?? OFF }))
  }),
  setFeature: adminWrite('features.manage', async (c, key: FeatureKey, flag: FeatureFlag) => { await applyFeature(c, key, flag) }),
  /** Turn a feature on / off for one customer (switches the flag to "selected" when needed). */
  setCustomerFeature: adminWrite('features.manage', async (c, businessId: string, key: FeatureKey, on: boolean) => {
    if (!isFeature(key)) throw new ApiError('Unknown feature')
    const b = await findBiz(c, businessId)
    const f = (await featureFlags(c.platform))[key] ?? OFF
    if (f.mode === 'all' && !on) {
      // Everyone except this customer.
      const all = await c.platform.select('businesses', { where: { deleted_at: null } })
      return applyFeature(c, key, { mode: 'selected', businessIds: all.map((x) => x.ROWID).filter((x) => x !== b.ROWID) })
    }
    if (f.mode === 'all') return
    const ids = on ? [...f.businessIds, b.ROWID] : f.businessIds.filter((x) => x !== b.ROWID)
    await applyFeature(c, key, { mode: ids.length ? 'selected' : 'off', businessIds: ids })
  }),

  // ---- Admin team ----
  team: adminRead('team.manage', async (c) => {
    const rows = await c.platform.select('platform_admins', { orderBy: [['CREATEDTIME', 'ASC']] })
    return rows.map((a) => ({ ...adminView(adminFrom(a)), active: a.is_active !== false, createdAt: a.CREATEDTIME, lastLoginAt: strOrNull(a.last_login_at) }))
  }),
  saveAdmin: adminWrite('team.manage', async (c, input: { id?: string; name: string; username: string; role: AdminRole; password?: string }) => {
    const me = c.requireAdmin()
    const name = String(input?.name ?? '').trim().slice(0, 120)
    if (!name) throw new ApiError('Enter the admin’s name')
    if (!isRole(input.role)) throw new ApiError('Choose a role')
    const username = checkUsernameFormat(input.username)
    const ex = input.id ? (/^\d{1,20}$/.test(String(input.id)) ? await c.platform.get('platform_admins', String(input.id)) : null) : null
    if (input.id && !ex) throw new ApiError('Admin not found', 404, 'NOT_FOUND')
    const taken = await c.platform.first('platform_admins', { username })
    if ((taken && taken.ROWID !== ex?.ROWID) || (await c.platform.first('login_names', { login: username }))) throw new ApiError(`Username ${username} is already taken`)
    if (ex) {
      const cur = adminFrom(ex)
      if (cur.role === 'super' && input.role !== 'super' && ex.is_active !== false && (await activeSupers(c)) <= 1) throw new ApiError('Keep at least one active super admin')
      if (cur.id === me.id && input.role !== cur.role) throw new ApiError('You can’t change your own role')
      const changes = [cur.name !== name && 'name', cur.username !== username && `username → ${username}`, cur.role !== input.role && `role ${ADMIN_ROLES[cur.role].name} → ${ADMIN_ROLES[input.role].name}`].filter(Boolean) as string[]
      const patch: Record<string, string | number | null> = { name, username, role: code(E.AdminRole, input.role) }
      if (input.password) {
        assertPassword(input.password)
        // A new token version signs the admin out everywhere.
        Object.assign(patch, { password_hash: await hashPassword(input.password), token_version: Number(ex.token_version ?? 1) + 1, failed_logins: 0, locked_until: null })
        changes.push('password reset')
      }
      if (changes.length) {
        await c.platform.update('platform_admins', ex.ROWID, patch)
        await adminLog(c, me, 'admin_update', null, `${name}: ${changes.join(', ')}`)
      }
      return adminView({ id: ex.ROWID, name, username, role: input.role })
    }
    assertPassword(input.password)
    const a = await c.platform.insert('platform_admins', { name, username, password_hash: await hashPassword(input.password!), role: code(E.AdminRole, input.role), is_active: true })
    await adminLog(c, me, 'admin_create', null, `${name} (${username}) added as ${ADMIN_ROLES[input.role].name}`)
    return adminView(adminFrom(a))
  }),
  setAdminActive: adminWrite('team.manage', async (c, id: string, active: boolean) => {
    const me = c.requireAdmin()
    const row = /^\d{1,20}$/.test(String(id)) ? await c.platform.get('platform_admins', String(id)) : null
    if (!row) throw new ApiError('Admin not found', 404, 'NOT_FOUND')
    const a = adminFrom(row)
    const on = !!active
    if (a.id === me.id && !on) throw new ApiError('You can’t deactivate yourself')
    if (!on && a.role === 'super' && row.is_active !== false && (await activeSupers(c)) <= 1) throw new ApiError('Keep at least one active super admin')
    if ((row.is_active !== false) === on) return
    // Turning an admin off also ends their sign-in tokens.
    await c.platform.update('platform_admins', row.ROWID, on ? { is_active: true } : { is_active: false, token_version: Number(row.token_version ?? 1) + 1 })
    await adminLog(c, me, 'admin_update', null, `${a.name}: ${on ? 'activated' : 'deactivated'}`)
  }),

  // ---- Support view ----
  /**
   * Opens the customer's app strictly read-only, as their owner, for 2 hours. Logged with the reason.
   * Returns a customer token carrying the support claim — the API refuses every write made with it.
   */
  startSupport: adminWrite('customers.support', async (c, businessId: string, reason: string) => {
    const a = c.requireAdmin()
    const r = await findBiz(c, businessId)
    const why = String(reason ?? '').trim().slice(0, 200)
    if (why.length < 4) throw new ApiError('Write why you are opening this account (e.g. the customer’s complaint)')
    const owner = await ownerOf(c, r.ROWID)
    if (!owner) throw new ApiError('This customer has no owner login yet')
    const shop = await c.shopDb(r.ROWID)
    const main = (await shop.first('branches', { business_id: r.ROWID, is_default: true })) ?? (await shop.first('branches', { business_id: r.ROWID }, [['ROWID', 'ASC']]))
    const claims: UserClaims = { t: 'u', uid: owner.ROWID, bid: r.ROWID, tv: Number(owner.token_version ?? 1), sup: { adminId: a.id, adminName: a.name, reason: why, startedAt: c.now.toISOString() } }
    await adminLog(c, a, 'support_start', { id: r.ROWID, name: str(r.name) }, `Support view opened: ${why}`)
    return { onboarded: !!r.onboarded_at, token: signToken({ ...claims }, SUPPORT_TOKEN_TTL), branchId: main?.ROWID ?? str(owner.default_branch_id) }
  }),
  /** Called with the support token (a customer session). Logs how long the view was open; returns the business id. */
  endSupport: {
    access: 'user',
    run: async (c: Ctx) => {
      const s = c.s
      if (!s.support) return null
      const row = /^\d{1,20}$/.test(s.support.adminId) ? await c.platform.get('platform_admins', s.support.adminId) : null
      const mins = Math.max(1, Math.round((c.now.getTime() - new Date(s.support.startedAt).getTime()) / 60000))
      if (row) await adminLog(c, adminFrom(row), 'support_end', { id: s.business.id, name: s.business.name }, `Support view closed after ${mins} min`)
      return s.business.id
    },
  },

  // ---- Usage report ----
  usage: adminRead('reports.view', async (c) => usage(c)),

  // ---- Platform settings & audit ----
  settings: adminRead('customers.view', async (c) => platformSettings(c)),
  updateSettings: adminWrite('pricing.manage', async (c, patch: { pricePerBranchMonth: number }) => {
    const a = c.requireAdmin()
    const p = Number(patch?.pricePerBranchMonth)
    if (typeof patch?.pricePerBranchMonth !== 'number' || !Number.isFinite(p) || !(p >= 0) || p > 1_000_000) throw new ApiError('Enter a valid price')
    const before = await pricePerBranch(c.platform)
    const cur = await getPlatformSetting<Record<string, unknown>>(c.platform, 'pricing', {})
    const next = Math.round(p)
    await putPlatformSetting(c.platform, 'pricing', { ...cur, pricePerBranchMonth: next }, a.id)
    await adminLog(c, a, 'settings', null, `Price per branch / month ${before} → ${next}`)
    return platformSettings(c)
  }),
  audit: adminRead('customers.view', async (c, limit = 200) => {
    const n = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 200)))
    const rows = await c.platform.select('admin_audit_logs', { orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: n })
    return rows.map(adminLogFrom)
  }),
})
