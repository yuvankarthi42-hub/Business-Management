// Things kept in the platform database about each shop, so sign-in and the product admin never have to open
// every shop's database:
//   login_names — username / mobile / email → shop + user (unique across all shops and admins)
//   businesses  — owner name / username / mobile / email, branches used, last sign-in, last activity
//
// With one database per shop there is no transaction across the two databases, so every change is ordered
// to stay safe if it stops half-way: a sign-in name is claimed BEFORE the user row uses it (a crash leaves an
// unused claim, never two shops with the same name), and released only AFTER the user row stopped using it.
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { TableName } from '../db/schema.gen'
import { DuplicateError, type AggregateOptions, type Db, type Row, type Value } from '../db/types'
import { E, str } from './util'

export type LoginKind = keyof typeof E.LoginKind
export interface Logins { username?: string | null; phone?: string | null; email?: string | null }

const keyOf = (kind: LoginKind, v: string) => (kind === 'phone' ? v.trim() : v.trim().toLowerCase())
const TAKEN: Record<LoginKind, string> = {
  username: 'This username is already taken',
  phone: 'This mobile number is already used by another account',
  email: '',
}

/** Who a sign-in name belongs to. */
export async function findLogin(c: Ctx, kind: LoginKind, value: string) {
  const r = await c.platform.first('login_names', { login: keyOf(kind, value), kind: E.LoginKind[kind] })
  return r ? { businessId: str(r.business_id), userId: str(r.user_id) } : null
}

/** Is the name free (or already this user's)? Admin usernames count too. */
export async function loginFree(c: Ctx, kind: LoginKind, value: string, self?: { businessId: string; userId: string }) {
  const login = keyOf(kind, value)
  const r = await c.platform.first('login_names', { login })
  if (r && !(self && str(r.business_id) === self.businessId && str(r.user_id) === self.userId)) return false
  if (kind === 'username' && (await c.platform.first('platform_admins', { username: login }))) return false
  return true
}

/**
 * Claims the new names of a user (before the user row is written). Returns an undo for when the user write
 * fails, and `release` to call after it succeeded (frees the names the user no longer has).
 * Emails are a convenience: a taken email is simply not usable for sign-in by the second user.
 */
export async function claimLogins(c: Ctx, businessId: string, userId: string | null, next: Logins, prev: Logins = {}) {
  const made: string[] = []
  const undo = async () => { if (made.length) await c.platform.deleteMany('login_names', made).catch((e) => console.error('[logins undo]', e)) }
  // A new user has no id yet: claim with a placeholder and fix it in `bind`.
  const uid = userId ?? '0'
  try {
    for (const kind of ['username', 'phone', 'email'] as const) {
      const v = next[kind] ? keyOf(kind, String(next[kind])) : null
      const old = prev[kind] ? keyOf(kind, String(prev[kind])) : null
      if (!v || v === old) continue
      if (kind === 'username' && (await c.platform.first('platform_admins', { username: v }))) throw new ApiError(TAKEN.username)
      try {
        const r = await c.platform.insert('login_names', { login: v, kind: E.LoginKind[kind], business_id: businessId, user_id: uid })
        made.push(r.ROWID)
      } catch (e) {
        if (!(e instanceof DuplicateError)) throw e
        const ex = await c.platform.first('login_names', { login: v })
        // Left over from an earlier half-finished save of this same user: keep it.
        if (ex && str(ex.business_id) === businessId && userId && str(ex.user_id) === userId) continue
        if (kind !== 'email') throw new ApiError(TAKEN[kind])
      }
    }
  } catch (e) { await undo(); throw e }
  return {
    undo,
    /** After a new user row was inserted: point the claims at it. */
    bind: async (newUserId: string) => { if (made.length) await c.platform.updateMany('login_names', made.map((ROWID) => ({ ROWID, user_id: newUserId }))) },
    /** After the user row was saved: free the names it no longer uses. */
    release: async (realUserId: string) => {
      for (const kind of ['username', 'phone', 'email'] as const) {
        const old = prev[kind] ? keyOf(kind, String(prev[kind])) : null
        const v = next[kind] ? keyOf(kind, String(next[kind])) : null
        if (!old || old === v) continue
        const r = await c.platform.first('login_names', { login: old, business_id: businessId, user_id: realUserId })
        if (r) await c.platform.delete('login_names', r.ROWID)
      }
    },
  }
}

/**
 * Saves a user row together with its sign-in names, in the safe order: new names are claimed first (undone if
 * the request fails), the user row is written, and the names it no longer uses are freed after the commit.
 */
export async function saveUserWithLogins(c: Ctx, businessId: string, existing: Row | null, next: Logins, write: () => Promise<Row>): Promise<Row> {
  const prev: Logins = existing ? { username: (existing.username as string) ?? null, phone: (existing.phone as string) ?? null, email: (existing.email as string) ?? null } : {}
  const claim = await claimLogins(c, businessId, existing?.ROWID ?? null, next, prev)
  c.onFail(claim.undo)
  const row = await write()
  if (!existing) await claim.bind(row.ROWID)
  c.afterCommit(() => claim.release(row.ROWID))
  return row
}

/** The admin's customer list reads these copies; called whenever the owner's details change. */
export async function syncOwner(c: Ctx, businessId: string, owner: Row) {
  await c.platform.update('businesses', businessId, {
    owner_user_id: owner.ROWID, owner_name: str(owner.name) || null, owner_username: str(owner.username) || null,
    owner_phone: str(owner.phone) || null, owner_email: str(owner.email) || null,
  })
}
export async function syncBranchCount(c: Ctx, businessId: string) {
  const n = await (await c.shopDb(businessId)).count('branches', { business_id: businessId })
  await c.platform.update('businesses', businessId, { branches_used: n })
}

/** "Last activity" for the admin list: written at most once an hour per shop (per function instance). */
const touched = new Map<string, number>()
export async function touchActivity(c: Ctx) {
  const id = c.shopId
  if (!id) return
  const last = touched.get(id) ?? 0
  if (c.now.getTime() - last < 3_600_000) return
  touched.set(id, c.now.getTime())
  if (touched.size > 20_000) touched.clear()
  await c.platform.update('businesses', id, { last_activity_at: c.now.toISOString() }).catch((e) => console.error('[touchActivity]', e))
}

/**
 * The same GROUP BY on many shops' data. One database: one query with business_id IN (…). One database per
 * shop: the query on each shop's database (8 at a time). A shop whose database can't be read is left out
 * (and logged) instead of failing the whole admin screen.
 */
export async function acrossShops(c: Ctx, ids: string[], table: TableName, o: AggregateOptions): Promise<Record<string, Value>[]> {
  if (!ids.length) return []
  if (!c.dbs.perShop) {
    const out: Record<string, Value>[] = []
    for (let i = 0; i < ids.length; i += 100) out.push(...await (await c.shopDb(ids[0])).aggregate(table, { ...o, where: { ...o.where, business_id: { in: ids.slice(i, i + 100) } }, groupBy: ['business_id', ...(o.groupBy ?? [])] }))
    return out
  }
  const out: Record<string, Value>[] = []
  await eachShop(c, ids, async (id, db) => {
    const rows = await db.aggregate(table, { ...o, where: { ...o.where, business_id: id } })
    for (const r of rows) out.push({ business_id: id, ...r })
  })
  return out
}

/** Runs fn for each shop's database, a few at a time. Failures are logged and skipped. */
export async function eachShop(c: Ctx, ids: string[], fn: (businessId: string, db: Db) => Promise<void>, concurrency = 8) {
  const queue = [...new Set(ids)]
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try { await fn(id, await c.shopDb(id)) } catch (e) { console.error(`[shop ${id}]`, (e as Error).message) }
    }
  }))
}
