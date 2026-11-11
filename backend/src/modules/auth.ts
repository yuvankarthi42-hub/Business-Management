// Customer sign-in, "who am I", branch switch, language.
import { normalizePhone } from '@/core/phone'
import { subscriptionState, DEACTIVATED_MESSAGE } from '@/core/subscription'
import { ALL_BRANCHES, type Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { checkPassword, hashPassword, needsRehash } from '../core/passwords'
import { define, handler, publicRead, publicWrite, userRead, userWrite } from '../core/registry'
import { signToken, verifyToken } from '../core/tokens'
import { loadBusiness, withFreshNumbers } from '../domain/business'
import { findLogin } from '../domain/directory'
import { issueDeviceToken, WRONG_SHOP, lockedError, lockedMinutes, loginRateLimits, recordWrongPassword, wrongWithDevice } from '../domain/loginGuard'
import { rateLimit } from '../domain/tracking'
import { bumpEpoch } from '../domain/session'
import { getSetting, putSetting, str } from '../domain/util'

export const USER_TOKEN_TTL = 12 * 3600 // 12 h, then sign in again
/** Shop setting written when product support resets the owner's password: { userId, at }. Cleared by changePassword. */
export const SUPPORT_RESET = 'supportReset'
// Unknown sign-in names still cost one password check, so the reply time doesn't tell which names exist.
let dummy: Promise<string> | null = null
const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'))

/** What the app keeps as "me" — the same shape the screens used with the mock. */
export async function meFor(c: Ctx) {
  const s = c.s
  // Next bill / order numbers change with every bill, so they're read fresh; the rest is the session's (built by the
  // same loadBusiness, and read again after any change to the shop), with its modules (a module whose feature
  // isn't released to the customer counts as off).
  const fresh = await withFreshNumbers(c.db, s.business, s.allBranches)
  const business = fresh.business
  const branchesAll = fresh.branches
  const branches = branchesAll.filter((b) => s.allowed.includes(b.id))
  const isAll = s.branchId === ALL_BRANCHES
  const branch = isAll ? { id: ALL_BRANCHES, businessId: business.id, name: 'All branches', address: '', isDefault: false, active: true } : branches.find((b) => b.id === s.branchId)!
  return {
    user: s.user, business, role: s.role, branch, branches, isAll,
    subscription: subscriptionState(business, c.now),
    branchLimit: { max: business.maxBranches ?? 1, used: branchesAll.length },
    features: s.features,
    support: s.support,
    // Support reset the password: the app shows only "Set a new password" (the API refuses everything else).
    ...(c.mustSetPassword ? { mustSetPassword: true } : {}),
    permissions: s.permissions === 'all' ? ('all' as const) : [...s.permissions],
  }
}

/** How long a checkPassword proof can be used for changePassword. */
const PW_PROOF_TTL = 5 * 60

define('auth', {
  /** Sign in with the username from the product admin, or the mobile number / email. */
  login: { ...publicWrite(async (c, identifier: string, password: string) => {
    const id = String(identifier ?? '').trim().toLowerCase()
    if (!id || !password) throw new ApiError('Enter your username and password')
    // Rate limits first (per address, and per login from that address), before any lookup or password check.
    await loginRateLimits(c, 'shop', id)
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
      const found = hit
      // Server log only (never shown to the user): why a known sign-in name still didn't sign in.
      const why = (reason: string, e?: unknown) => console.warn(`[auth.login] ${match?.col} found for shop ${found.businessId} user ${found.userId}, but ${reason}`, e ?? '')
      try { await c.useShop(found.businessId) } catch (e) { why('the shop database could not be opened', e); hit = null }
      // The user row must still carry that name (a name being changed on another device is not used).
      const u = hit ? await c.db.get('users', found.userId).catch((e) => { why('reading the user failed', e); return null }) : null
      if (hit && !u) why('there is no such user in the shop database')
      else if (u && match && str(u[match.col]).toLowerCase() !== match.value.toLowerCase()) why(`the user's ${match.col} is different now`)
      else if (u && str(u.business_id) !== found.businessId) why(`the user belongs to shop ${str(u.business_id)}`)
      else if (u && u.can_login === false) why('this staff member has no app access')
      else if (u) row = u
    }
    if (!row) { await checkPassword(password, await dummyHash()); throw new ApiError(WRONG_SHOP, 401, 'BAD_LOGIN') }
    const account = `${str(row.business_id)}:${row.ROWID}`
    const locked = await lockedMinutes(c, 'shop', row, account)
    if (locked) throw lockedError(locked)
    if (!(await checkPassword(password, str(row.password_hash)))) {
      // Counted only now (a right password is never counted), in one atomic step.
      await recordWrongPassword(c, c.db, 'users', row, account)
      await wrongWithDevice(c, 'shop', account)
      throw new ApiError(WRONG_SHOP, 401, 'BAD_LOGIN')
    }
    if (row.is_active === false) throw new ApiError('Your login has been turned off. Ask your shop owner.', 403, 'INACTIVE')
    const bundle = await loadBusiness(c, str(row.business_id))
    if (!bundle) throw new ApiError(WRONG_SHOP, 401, 'BAD_LOGIN')
    if (subscriptionState(bundle.business).blocked) throw new ApiError(DEACTIVATED_MESSAGE, 403, 'DEACTIVATED')
    // An older or weaker hash (bcrypt, fewer iterations, no pepper yet) is replaced in the same write.
    const rehash = needsRehash(str(row.password_hash)) ? { password_hash: await hashPassword(password) } : {}
    await c.db.update('users', row.ROWID, { failed_logins: 0, locked_until: null, last_login_at: c.now.toISOString(), ...rehash })
    await c.platform.update('businesses', str(row.business_id), { last_login_at: c.now.toISOString() })
    const tv = Number(row.token_version ?? 1)
    // This browser's device token (lets it sign in while someone else's guessing has locked the account).
    const deviceToken = await issueDeviceToken(c, 'shop', account, tv)
    // Support reset this password: the session may only set a new password until that's done (app.ts).
    // (Read with the shop's settings above — no extra read.)
    const reset = bundle.supportReset
    const pwc = !!reset && reset.userId === row.ROWID
    return {
      token: signToken({ t: 'u', uid: row.ROWID, bid: str(row.business_id), tv, ...(pwc ? { pwc: 1 } : {}) }, USER_TOKEN_TTL),
      branchId: str(row.default_branch_id), mustChangePassword: !!row.must_change_password, deviceToken,
      ...(pwc ? { passwordResetAt: String(reset!.at ?? '') } : {}),
    }
  }), quiet: true },

  /** Public sign-up is closed: only the product admin creates customer accounts. */
  signup: publicRead(async () => { throw new ApiError('New accounts are created by the product admin. Please contact us to get your username and password.') }),

  me: userRead(async (c) => meFor(c)),
  /**
   * App start-up in one call (instead of four): the signed-in user, their support tickets, pending QR orders (when the
   * screen shows them) and the change-feed position. Each part is exactly what its own action returns.
   */
  boot: userRead(async (c) => {
    const run = (name: string, ...args: unknown[]) => handler(name)!.run(c, ...args)
    const qrOn = !!c.business.modules.qrOrdering && c.can('tables.manage')
    const [me, support, qrPending, feed] = await Promise.all([
      meFor(c), run('support.unread'), qrOn ? run('qr.pending') : Promise.resolve(null), run('sync.changes', null),
    ])
    // liveHub: whether this server has live updates (events.ticket gives a stream) — none on Catalyst, so the app
    // doesn't ask for a ticket on every page load.
    // supportUnread: the menu's Help & support badge (the tickets themselves are read when that page opens).
    return { me, supportUnread: support, qrPending, feed, liveHub: !!c.liveUrl }
  }),

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
  /**
   * Step 1 of a password change in two requests (each one password hash, so each stays small): checks the current
   * password and returns a proof for changePassword — valid 5 minutes, for this user only, until their password or
   * sign-in changes (it carries their token version).
   */
  checkPassword: userWrite(async (c, current: string) => {
    // Guessing the current password from a signed-in session: limited per user (any address).
    await rateLimit(c, 'pwcheck', 10, 'Too many tries. Please wait a minute and try again.', `${c.businessId}:${c.userId}`)
    const row = await c.db.get('users', c.userId)
    if (!row || !(await checkPassword(current, str(row.password_hash)))) throw new ApiError('Current password is wrong')
    return { proof: signToken({ t: 'pw', uid: c.userId, bid: c.businessId, tv: Number(row.token_version ?? 1) }, PW_PROOF_TTL) }
  }, { readOnlyOk: true, quiet: true }),

  /**
   * Change your own password. With a proof from checkPassword (same user, still valid) the current password isn't
   * hashed again; without one (or a stale one) it is checked here, as always. Other devices are signed out.
   */
  changePassword: userWrite(async (c, current: string, next: string, opts?: { proof?: string }) => {
    await rateLimit(c, 'pwcheck', 10, 'Too many tries. Please wait a minute and try again.', `${c.businessId}:${c.userId}`)
    const row = await c.db.get('users', c.userId)
    if (!row) throw new ApiError('Current password is wrong')
    const proof = verifyToken<{ t?: string; uid?: string; bid?: string; tv?: number }>(opts?.proof)
    const proven = !!proof && proof.t === 'pw' && String(proof.uid) === c.userId && String(proof.bid) === c.businessId && Number(proof.tv) === Number(row.token_version ?? 1)
    if (!proven && !(await checkPassword(current, str(row.password_hash)))) throw new ApiError('Current password is wrong')
    const { assertPassword, hashPassword } = await import('../core/passwords')
    assertPassword(next, [str(row.phone), str(row.username), str(row.email)])
    const tv = Number(row.token_version ?? 1) + 1
    await c.db.update('users', c.userId, { password_hash: await hashPassword(next), must_change_password: false, password_changed_at: c.now.toISOString(), token_version: tv })
    // Their own password now: the support-reset notice is done (the new token below has no restriction).
    if ((await getSetting<{ userId?: string } | null>(c.db, c.businessId, SUPPORT_RESET, null))?.userId === c.userId) await putSetting(c.db, c.businessId, SUPPORT_RESET, null, c.userId)
    // Signs the other devices out (the shop's sign-in cache); the customers' QR menu is not affected.
    await bumpEpoch(c, c.businessId, { menu: false })
    return { token: signToken({ t: 'u', uid: c.userId, bid: c.businessId, tv }, USER_TOKEN_TTL) }
  }, { readOnlyOk: true, quiet: true }),
})
