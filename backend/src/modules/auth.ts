// Customer sign-in, "who am I", branch switch, language.
import { normalizePhone } from '@/core/phone'
import { subscriptionState, DEACTIVATED_MESSAGE } from '@/core/subscription'
import { ALL_BRANCHES, type Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { checkPassword, hashPassword } from '../core/passwords'
import { define, publicRead, publicWrite, userRead, userWrite } from '../core/registry'
import { signToken } from '../core/tokens'
import { loadBusiness } from '../domain/business'
import { findLogin } from '../domain/directory'
import { bumpEpoch } from '../domain/session'
import { str } from '../domain/util'

export const USER_TOKEN_TTL = 12 * 3600 // 12 h, then sign in again
const LOCK_AFTER = 5, LOCK_MINUTES = 15
// Unknown sign-in names still cost one password check, so the reply time doesn't tell which names exist.
let dummy: Promise<string> | null = null
const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'))

/** What the app keeps as "me" — the same shape the screens used with the mock. */
export async function meFor(c: Ctx) {
  const s = c.s
  // Next bill / order numbers change with every bill, so they're read fresh (not from the cached session).
  const fresh = await loadBusiness(c, s.business.id)
  const business = { ...(fresh?.business ?? s.business) }
  const branchesAll = fresh?.branches ?? s.allBranches
  const branches = branchesAll.filter((b) => s.allowed.includes(b.id))
  const isAll = s.branchId === ALL_BRANCHES
  const branch = isAll ? { id: ALL_BRANCHES, businessId: business.id, name: 'All branches', address: '', isDefault: false, active: true } : branches.find((b) => b.id === s.branchId)!
  return {
    user: s.user, business, role: s.role, branch, branches, isAll,
    subscription: subscriptionState(business, c.now),
    branchLimit: { max: business.maxBranches ?? 1, used: branchesAll.length },
    features: s.features,
    support: s.support,
    permissions: s.permissions === 'all' ? ('all' as const) : [...s.permissions],
  }
}

define('auth', {
  /** Sign in with the username from the product admin, or the mobile number / email. */
  login: { ...publicWrite(async (c, identifier: string, password: string) => {
    const id = String(identifier ?? '').trim().toLowerCase()
    if (!id || !password) throw new ApiError('Enter your username and password')
    // Which shop: the platform's list of sign-in names (unique across every shop).
    let hit: { businessId: string; userId: string } | null = null
    let match: { col: 'phone' | 'username' | 'email'; value: string } | null = null
    if (/^[+\d][\d\s()-]*$/.test(id)) {
      let mobile: string | null
      try { mobile = normalizePhone(id, 'IN') } catch (e) { throw new ApiError((e as Error).message) }
      if (mobile) { hit = await findLogin(c, 'phone', mobile); match = { col: 'phone', value: mobile } }
    } else if (/^[a-z0-9._-]{4,30}$/.test(id)) {
      hit = await findLogin(c, 'username', id); match = { col: 'username', value: id }
    }
    if (!hit && /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(id)) { hit = await findLogin(c, 'email', id); match = { col: 'email', value: id } }
    let row = null
    if (hit) {
      try { await c.useShop(hit.businessId) } catch { hit = null }
      // The user row must still carry that name (a name being changed on another device is not used).
      const u = hit ? await c.db.get('users', hit.userId) : null
      if (u && match && str(u[match.col]).toLowerCase() === match.value.toLowerCase() && str(u.business_id) === hit!.businessId) row = u
    }
    if (!row) { await checkPassword(password, await dummyHash()); throw new ApiError('Wrong mobile number or password', 401, 'BAD_LOGIN') }
    if (row.locked_until && new Date(str(row.locked_until)).getTime() > Date.now()) throw new ApiError(`Too many wrong tries. Try again after ${LOCK_MINUTES} minutes.`, 429, 'LOCKED')
    if (!(await checkPassword(password, str(row.password_hash)))) {
      const n = Number(row.failed_logins ?? 0) + 1
      await c.db.update('users', row.ROWID, { failed_logins: n >= LOCK_AFTER ? 0 : n, locked_until: n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null })
      throw new ApiError('Wrong mobile number or password', 401, 'BAD_LOGIN')
    }
    if (row.is_active === false) throw new ApiError('Your login has been turned off. Ask your shop owner.', 403, 'INACTIVE')
    const bundle = await loadBusiness(c, str(row.business_id))
    if (!bundle) throw new ApiError('Wrong mobile number or password', 401, 'BAD_LOGIN')
    if (subscriptionState(bundle.business).blocked) throw new ApiError(DEACTIVATED_MESSAGE, 403, 'DEACTIVATED')
    await c.db.update('users', row.ROWID, { failed_logins: 0, locked_until: null, last_login_at: c.now.toISOString() })
    await c.platform.update('businesses', str(row.business_id), { last_login_at: c.now.toISOString() })
    const tv = Number(row.token_version ?? 1)
    return { token: signToken({ t: 'u', uid: row.ROWID, bid: str(row.business_id), tv }, USER_TOKEN_TTL), branchId: str(row.default_branch_id), mustChangePassword: !!row.must_change_password }
  }), quiet: true },

  /** Public sign-up is closed: only the product admin creates customer accounts. */
  signup: publicRead(async () => { throw new ApiError('New accounts are created by the product admin. Please contact us to get your username and password.') }),

  me: userRead(async (c) => meFor(c)),

  /** Check the branch is allowed. The app then sends it with every request (x-branch). */
  switchBranch: userRead(async (c, branchId: string) => {
    const s = c.s
    if (branchId === ALL_BRANCHES ? s.allowed.length < 2 : !s.allowed.includes(branchId)) throw new ApiError('You don’t have access to that branch')
    return { branchId }
  }),

  /** A personal preference — allowed even when the account is read-only. */
  setLanguage: userWrite(async (c, language: string) => {
    if (!/^[a-z]{2}$/.test(language)) throw new ApiError('Unknown language')
    await c.db.update('users', c.userId, { language })
    await bumpEpoch(c, c.businessId)
    return language
  }, { readOnlyOk: true, quiet: true }),

  /** Change own password (also used for the first sign-in when the admin gave a temporary one). */
  changePassword: userWrite(async (c, current: string, next: string) => {
    const row = await c.db.get('users', c.userId)
    if (!row || !(await checkPassword(current, str(row.password_hash)))) throw new ApiError('Current password is wrong')
    const { assertPassword, hashPassword } = await import('../core/passwords')
    assertPassword(next)
    const tv = Number(row.token_version ?? 1) + 1
    await c.db.update('users', c.userId, { password_hash: await hashPassword(next), must_change_password: false, password_changed_at: c.now.toISOString(), token_version: tv })
    await bumpEpoch(c, c.businessId)
    return { token: signToken({ t: 'u', uid: c.userId, bid: c.businessId, tv }, USER_TOKEN_TTL) }
  }, { readOnlyOk: true, quiet: true }),
})
