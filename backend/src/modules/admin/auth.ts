// Product admin sign-in. Separate tokens from customers (t: 'a'); an admin token never opens a shop.
import { ADMIN_ROLES } from '@/core/adminRoles'
import type { AdminRole } from '@/core/types'
import type { AdminSession, Ctx } from '../../core/context'
import { ApiError } from '../../core/errors'
import { assertPassword, checkPassword, hashPassword } from '../../core/passwords'
import { adminRead, define, publicWrite } from '../../core/registry'
import { signToken } from '../../core/tokens'
import type { Db } from '../../db/types'
import type { AdminClaims } from '../../domain/session'
import { code, E, nameOf, str } from '../../domain/util'

export const ADMIN_TOKEN_TTL = 8 * 3600
const LOCK_AFTER = 5, LOCK_MINUTES = 15

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
  await db.insert('platform_admins', { name: 'BillPoodum Admin', username, password_hash: await hashPassword(password), role: E.AdminRole.super, is_active: true })
  return username
}

define('admin', {
  login: publicWrite(async (c, username: string, password: string) => {
    const u = String(username ?? '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,30}$/.test(u) || !password) throw new ApiError('Wrong admin username or password', 401, 'BAD_LOGIN')
    const a = await c.platform.first('platform_admins', { username: u })
    if (!a || a.is_active === false) throw new ApiError('Wrong admin username or password', 401, 'BAD_LOGIN')
    if (a.locked_until && new Date(str(a.locked_until)).getTime() > Date.now()) throw new ApiError(`Too many wrong tries. Try again after ${LOCK_MINUTES} minutes.`, 429, 'LOCKED')
    if (!(await checkPassword(password, str(a.password_hash)))) {
      const n = Number(a.failed_logins ?? 0) + 1
      await c.platform.update('platform_admins', a.ROWID, { failed_logins: n >= LOCK_AFTER ? 0 : n, locked_until: n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null })
      throw new ApiError('Wrong admin username or password', 401, 'BAD_LOGIN')
    }
    await c.platform.update('platform_admins', a.ROWID, { failed_logins: 0, locked_until: null, last_login_at: c.now.toISOString() })
    await c.platform.insert('admin_audit_logs', { admin_id: a.ROWID, admin_name: str(a.name), action: E.AdminAction.login, detail: 'Signed in' })
    const session: AdminSession = { id: a.ROWID, name: str(a.name), username: str(a.username), role: nameOf(E.AdminRole, a.role) as AdminRole }
    return { token: signToken({ t: 'a', aid: a.ROWID, tv: Number(a.token_version ?? 1) }, ADMIN_TOKEN_TTL), admin: adminView(session) }
  }),
  me: adminRead(undefined, async (c) => adminView(c.requireAdmin())),

  /**
   * One-time setup on a new Catalyst project: creates the first super admin. Only works while there is no
   * admin at all, and only with the SETUP_KEY set in the function's environment variables.
   */
  setup: publicWrite(async (c, setupKey: string, input: { name: string; username: string; password: string }) => {
    const want = process.env.SETUP_KEY
    if (!want || want.length < 16 || setupKey !== want) throw new ApiError('Setup is not allowed', 403, 'FORBIDDEN')
    if (await c.platform.count('platform_admins')) throw new ApiError('Setup is already done', 409, 'CONFLICT')
    const username = String(input?.username ?? '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{4,30}$/.test(username)) throw new ApiError('Username: 4–30 letters, numbers, dot, dash or underscore')
    assertPassword(input.password)
    const a = await c.platform.insert('platform_admins', { name: String(input.name ?? '').trim() || 'BillPoodum Admin', username, password_hash: await hashPassword(input.password), role: code(E.AdminRole, 'super'), is_active: true })
    return { id: a.ROWID, username }
  }),
})
