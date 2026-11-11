// Product admin sign-in. Separate tokens from customers (t: 'a'); an admin token never opens a shop.
import { ADMIN_ROLES } from '@/core/adminRoles'
import type { AdminRole } from '@/core/types'
import type { AdminSession, Ctx } from '../../core/context'
import { setupKeyOk } from '../../core/clientIp'
import { ApiError } from '../../core/errors'
import { assertPassword, checkPassword, hashPassword, needsRehash } from '../../core/passwords'
import { adminRead, define, publicWrite } from '../../core/registry'
import { signToken } from '../../core/tokens'
import type { Db } from '../../db/types'
import type { AdminClaims } from '../../domain/session'
import { issueDeviceToken, WRONG_ADMIN, lockedError, lockedMinutes, loginRateLimits, recordWrongPassword, wrongWithDevice } from '../../domain/loginGuard'
import { code, E, nameOf, str } from '../../domain/util'

export const ADMIN_TOKEN_TTL = 8 * 3600
// Unknown admin names still cost one password check (same reply time).
let dummy: Promise<string> | null = null
const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'))

export const adminView = (a: AdminSession) => ({ id: a.id, name: a.name, username: a.username, role: a.role, permissions: ADMIN_ROLES[a.role].permissions })

/**
 * Admin for a token. Read every time (admins are few, and with Turso the function instances share no cache),
 * so turning an admin off or changing the password takes effect on the very next request.
 */
export async function loadAdmin(c: Ctx, claims: AdminClaims): Promise<AdminSession | null> {
  if (!/^\d{1,16}$/.test(String(claims.aid))) return null
  const a = await c.platform.get('platform_admins', String(claims.aid))
  if (!a || a.is_active === false || Number(a.token_version ?? 1) !== claims.tv) return null
  return { id: a.ROWID, name: str(a.name), username: str(a.username), role: nameOf(E.AdminRole, a.role) as AdminRole }
}

/** Local development only: creates the first super admin from LOCAL_ADMIN_USER / LOCAL_ADMIN_PASSWORD. */
export async function ensureFirstAdmin(db: Db): Promise<string | null> {
  if (await db.count('platform_admins')) return null
  const username = (process.env.LOCAL_ADMIN_USER ?? '').trim().toLowerCase()
  const password = process.env.LOCAL_ADMIN_PASSWORD ?? ''
  if (!username || !password) { console.log('No product admin yet. Set LOCAL_ADMIN_USER and LOCAL_ADMIN_PASSWORD, or call admin.setup.'); return null }
  await db.insert('platform_admins', { name: 'Kadai Kalanjiyam Admin', username, password_hash: await hashPassword(password), role: E.AdminRole.super, is_active: true })
  return username
}

define('admin', {
  login: publicWrite(async (c, username: string, password: string) => {
    const u = String(username ?? '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,30}$/.test(u) || !password) throw new ApiError(WRONG_ADMIN, 401, 'BAD_LOGIN')
    await loginRateLimits(c, 'admin', u)
    const a = await c.platform.first('platform_admins', { username: u })
    // Unknown or turned-off admin: the same password check time, so the reply doesn't tell which names exist.
    if (!a || a.is_active === false) { await checkPassword(password, await dummyHash()); throw new ApiError(WRONG_ADMIN, 401, 'BAD_LOGIN') }
    const locked = await lockedMinutes(c, 'admin', a)
    if (locked) throw lockedError(locked, 'admin')
    if (!(await checkPassword(password, str(a.password_hash)))) {
      await recordWrongPassword(c, c.platform, 'platform_admins', a, a.ROWID)
      await wrongWithDevice(c, 'admin', a.ROWID)
      throw new ApiError(WRONG_ADMIN, 401, 'BAD_LOGIN')
    }
    // An older or weaker hash (bcrypt, fewer iterations, no pepper yet) is replaced in the same write.
    const rehash = needsRehash(str(a.password_hash)) ? { password_hash: await hashPassword(password) } : {}
    await c.platform.update('platform_admins', a.ROWID, { failed_logins: 0, locked_until: null, last_login_at: c.now.toISOString(), ...rehash })
    const deviceToken = await issueDeviceToken(c, 'admin', a.ROWID, Number(a.token_version ?? 1))
    await c.platform.insert('admin_audit_logs', { admin_id: a.ROWID, admin_name: str(a.name), action: E.AdminAction.login, detail: 'Signed in' })
    const session: AdminSession = { id: a.ROWID, name: str(a.name), username: str(a.username), role: nameOf(E.AdminRole, a.role) as AdminRole }
    return { token: signToken({ t: 'a', aid: a.ROWID, tv: Number(a.token_version ?? 1) }, ADMIN_TOKEN_TTL), admin: adminView(session), deviceToken }
  }),
  me: adminRead(undefined, async (c) => adminView(c.requireAdmin())),

  /**
   * One-time setup on a new Catalyst project: creates the first super admin. Only works while there is no
   * admin at all, and only with the SETUP_KEY set in the function's environment variables.
   */
  setup: publicWrite(async (c, setupKey: string, input: { name: string; username: string; password: string }) => {
    if (!setupKeyOk(String(setupKey ?? ''))) throw new ApiError('Setup is not allowed', 403, 'FORBIDDEN')
    if (await c.platform.count('platform_admins')) throw new ApiError('Setup is already done', 409, 'CONFLICT')
    const username = String(input?.username ?? '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{4,30}$/.test(username)) throw new ApiError('Username: 4–30 letters, numbers, dot, dash or underscore')
    assertPassword(input.password, [username])
    const a = await c.platform.insert('platform_admins', { name: String(input.name ?? '').trim() || 'Kadai Kalanjiyam Admin', username, password_hash: await hashPassword(input.password), role: code(E.AdminRole, 'super'), is_active: true })
    return { id: a.ROWID, username }
  }),
})
