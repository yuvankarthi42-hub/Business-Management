// Loads "who is signed in" for a request. The result is cached (Catalyst Cache, or the function's memory
// with Turso) so a normal request costs one small epoch read instead of ~30 rows. Any change to the user,
// roles, branches, business settings, subscription or features calls bumpEpoch(), which makes every cached
// copy for that business stale at once.
import { featuresFor, type FeatureFlags } from '@/core/features'
import type { Branch, Business, Role, User } from '@/core/types'
import { ALL_BRANCHES, type Ctx, type Session, type SupportClaim } from '../core/context'
import type { Db } from '../db/types'
import { loadBusiness } from './business'
import { allowedBranches, permissionsOf, roleFrom, userFrom } from './people'
import { getPlatformSetting, str } from './util'

export interface UserClaims { t: 'u'; uid: string; bid: string; tv: number; sup?: SupportClaim }
export interface AdminClaims { t: 'a'; aid: string; tv: number }

interface Cached { user: User; role: Role; business: Business; allBranches: Branch[]; tokenVersion: number; features: Record<string, boolean> }

/** Call after any write that changes what auth.me returns (business, settings, branches, users, roles, features). */
export async function bumpEpoch(c: Ctx, businessId: string | 'global') {
  await c.epochs.bump(c, businessId)
}

export async function featureFlags(db: Db): Promise<FeatureFlags> {
  const flags = await db.select('feature_flags')
  if (!flags.length) return {}
  const sel = await db.select('feature_flag_businesses', { where: { feature_flag_id: { in: flags.map((f) => f.ROWID) } } })
  const modes = ['off', 'selected', 'all'] as const
  return Object.fromEntries(flags.map((f) => [str(f.feature_key), { mode: modes[Number(f.rollout) - 1] ?? 'off', businessIds: sel.filter((s) => s.feature_flag_id === f.ROWID).map((s) => str(s.business_id)) }]))
}

async function loadFresh(c: Ctx, claims: UserClaims): Promise<Cached | null> {
  const db = c.db
  const u = await db.get('users', claims.uid)
  if (!u || str(u.business_id) !== claims.bid) return null
  const [bundle, roleRow, perms, ub, flags] = await Promise.all([
    loadBusiness(c, claims.bid),
    u.role_id ? db.get('roles', str(u.role_id)) : Promise.resolve(null),
    u.role_id ? db.select('role_permissions', { where: { role_id: str(u.role_id) } }) : Promise.resolve([]),
    db.select('user_branches', { where: { user_id: u.ROWID } }),
    featureFlags(c.platform),
  ])
  if (!bundle || !roleRow) return null
  const user = userFrom(u, ub.map((x) => str(x.branch_id)))
  return {
    user, role: roleFrom(roleRow, perms), business: bundle.business, allBranches: bundle.branches,
    tokenVersion: Number(u.token_version ?? 1), features: featuresFor(flags, claims.bid),
  }
}

/** Returns the session, or null when the token no longer matches (password changed, login turned off, business deleted). */
export async function loadSession(c: Ctx, claims: UserClaims, branchHeader: string | undefined): Promise<(Session & { features: Record<string, boolean> }) | null> {
  if (!/^\d{1,16}$/.test(String(claims.uid)) || !/^\d{1,16}$/.test(String(claims.bid))) return null
  c.epoch = await c.epochs.get(c, claims.bid)
  const key = `sess:${claims.bid}:${claims.uid}:${claims.tv}:${c.epoch}`
  let data: Cached | null = null
  const hit = await c.kv.get(key)
  if (hit) { try { data = JSON.parse(hit) } catch { data = null } }
  if (!data) {
    data = await loadFresh(c, claims)
    if (data) await c.kv.set(key, JSON.stringify(data), 6)
  }
  if (!data || data.tokenVersion !== claims.tv) return null
  if (!data.user.active && !claims.sup) return null
  const allowed = allowedBranches(data.user, data.role, data.allBranches.map((b) => b.id))
  const wanted = branchHeader || data.user.branchId
  const branchId = wanted === ALL_BRANCHES ? (allowed.length >= 2 ? ALL_BRANCHES : allowed[0]) : allowed.includes(wanted) ? wanted : allowed.includes(data.user.branchId) ? data.user.branchId : allowed[0]
  if (!branchId) return null
  return {
    user: data.user, role: data.role, business: data.business, allBranches: data.allBranches, allowed,
    permissions: permissionsOf(data.role), branchId, support: claims.sup ?? null, features: data.features,
  }
}

export async function pricePerBranch(db: Db) {
  return (await getPlatformSetting<{ pricePerBranchMonth?: number }>(db, 'pricing', {})).pricePerBranchMonth ?? 499
}
