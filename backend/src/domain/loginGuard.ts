// Sign-in protection (shop staff and product admins). Three layers, so guessing passwords is slow and a known
// owner can't be kept out by someone else:
//  1. Rate limits (atomic counters in the shared cache, keyed on the visitor's real address — core/clientIp.ts):
//     all sign-ins from one address, and tries at one login from one address. Calls sent at the same moment are
//     all counted, so a burst can't slip past.
//  2. Wrong passwords: counted only AFTER a wrong password (never a right one). Every 5th wrong try from one network
//     address locks THAT address out of the account for a while that grows 1 → 5 → 15 minutes (never long or
//     permanent) — so someone guessing elsewhere can't keep the owner out, even on a new device. Only a wide attack
//     (WIDE_LOCK_AFTER wrong tries in WIDE_WINDOW_MIN minutes from any addresses together) locks the whole account
//     (15 minutes). The account's total is still kept in the database (failed_logins), for the admin screens.
//  3. The owner's own devices: a successful sign-in gets a device token from the server (32 random bytes). The app
//     keeps it and sends it only with sign-ins (x-login-device). While the account is locked, a sign-in carrying a
//     valid token for that same account still goes ahead — so a stranger guessing can't lock the owner out.
//     • Only the token's SHA-256 is stored (shared cache, 30 days), with the account's token_version: a password
//       change / reset, turning the login off or "sign out everywhere" raises token_version → every token is void.
//     • A new token on every successful sign-in (the old one is dropped), so a copied token stops working once the
//       owner signs in again. At most 5 per account. 5 wrong passwords sent with a token → it no longer skips locks.
//     • The password check and the rate limits always apply; a token never signs anyone in by itself.
import { createHash, randomBytes } from 'node:crypto'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import type { Db, Row } from '../db/types'
import { rateLimit } from './tracking'
import { str } from './util'

export const LOCK_AFTER = 5
/** A guessing attack from many addresses at once: this many wrong tries in the window lock the whole account. */
const WIDE_LOCK_AFTER = 25
const WIDE_WINDOW_MIN = 15
const WIDE_LOCK_MIN = 15
/** Lock length for the 1st, 2nd, 3rd+ lock in a row (minutes). Capped, so a lock never lasts long. */
const LOCK_STEPS = [1, 5, 15]
const PER_ADDRESS = 30 // sign-ins a minute from one address (all logins)
const PER_LOGIN = 10 // tries at one login a minute from one address
const TRUST_HOURS = 30 * 24
const MAX_DEVICES = 5
const DEVICE_BAD_TRIES = 5

type Kind = 'shop' | 'admin'
const hashKey = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 24)

/** A device token as the app sends it: 32 bytes, URL-safe base64 (43 characters). Anything else is ignored. */
export const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex')
const badKey = (kind: Kind, id: string, hash: string) => `ldevbad:${kind}:${id}:${hash}`
/** All of an account's device tokens in one cache entry: [{ h: sha256 of the token, tv: token_version }], newest last. */
const listKey = (kind: Kind, id: string) => `ldevs:${kind}:${id}`
type DeviceEntry = { h: string; tv: number }
async function readDevices(c: Ctx, kind: Kind, id: string): Promise<DeviceEntry[]> {
  try {
    const v = JSON.parse((await c.shared.get(listKey(kind, id))) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => x && typeof x.h === 'string' && Number.isFinite(Number(x.tv))) : []
  } catch { return [] }
}

/** The token sent with this sign-in, if it is still valid for this account (same token_version, not misused). */
async function validDevice(c: Ctx, kind: Kind, id: string, tokenVersion: number): Promise<string | null> {
  const t = c.loginDevice
  if (!t || !DEVICE_TOKEN.test(t)) return null
  const hash = tokenHash(t)
  // Found by the hash of a 256-bit secret: a made-up token matches nothing. Void after token_version changes.
  const hit = (await readDevices(c, kind, id)).find((d) => d.h === hash)
  if (!hit || Number(hit.tv) !== tokenVersion) return null
  if ((Number(await c.shared.get(badKey(kind, id, hash))) || 0) >= DEVICE_BAD_TRIES) return null
  return hash
}

/** Before looking anything up: the rate limits. */
export async function loginRateLimits(c: Ctx, kind: Kind, login: string) {
  const msg = 'Too many sign-in tries. Please wait a minute and try again.'
  await rateLimit(c, `login:${kind}`, PER_ADDRESS, msg)
  await rateLimit(c, `login:${kind}:${hashKey(login)}`, PER_LOGIN, msg)
}

/** This sign-in's network address (the real visitor's — core/clientIp.ts), hashed: the key of its own lock. */
const netOf = (c: Ctx) => hashKey(c.ip || 'unknown')
const netCount = (kind: Kind, id: string, net: string) => `lnetn:${kind}:${id}:${net}`
const netLock = (kind: Kind, id: string, net: string) => `lnet:${kind}:${id}:${net}`

/**
 * Minutes this sign-in is still locked out (0 = may try): its own network's lock for this account, or the whole
 * account's lock (a wide attack). A valid device token of this account skips either.
 */
export async function lockedMinutes(c: Ctx, kind: Kind, row: Row, id = row.ROWID): Promise<number> {
  const account = row.locked_until ? Date.parse(str(row.locked_until)) : 0
  const net = Number(await c.shared.get(netLock(kind, id, netOf(c)))) || 0
  const until = Math.max(account, net)
  const left = until - Date.now()
  if (!(left > 0)) return 0
  if (await validDevice(c, kind, id, Number(row.token_version ?? 1))) return 0
  return Math.max(1, Math.ceil(left / 60_000))
}

/** A wrong password sent with a device token: after 5, that token no longer skips locks. */
export async function wrongWithDevice(c: Ctx, kind: Kind, id: string) {
  const t = c.loginDevice
  if (t && DEVICE_TOKEN.test(t)) await c.shared.incr(badKey(kind, id, tokenHash(t)), TRUST_HOURS)
}

/**
 * A wrong password: add 1 to the account's total (one atomic step, kept for the admin screens) and to this network's
 * count for the account. Every 5th from this network locks this network out for a while; WIDE_LOCK_AFTER from any
 * networks within WIDE_WINDOW_MIN lock the whole account. `account` = the id used by lockedMinutes. Returns the
 * account's new total. Parallel wrong tries are each counted (no lost updates).
 */
export async function recordWrongPassword(c: Ctx, db: Db, table: 'users' | 'platform_admins', row: Row, account = row.ROWID): Promise<number> {
  const kind: Kind = table === 'platform_admins' ? 'admin' : 'shop'
  let n: number
  if (db.sql) {
    // Table name is one of two constants (never input); the id is a parameter.
    const rows = await db.sql(`UPDATE "${table}" SET "failed_logins" = "failed_logins" + 1 WHERE "id" = ? RETURNING "failed_logins"`, [row.ROWID])
    n = Number(rows[0]?.failed_logins) || 0
  } else if (row.row_version !== undefined) {
    // No SQL (Data Store / in-memory): compare-and-swap on row_version, re-reading on a clash.
    let cur: Row | null = row
    n = 0
    for (let i = 0; i < 8 && cur; i++) {
      n = Number(cur.failed_logins ?? 0) + 1
      if (await db.updateIfVersion(table, cur.ROWID, Number(cur.row_version ?? 1), { failed_logins: n })) break
      cur = await db.get(table, row.ROWID)
    }
  } else {
    // No SQL and no version column (admins on the Data Store / in memory): the shared cache's atomic counter
    // carries the count on top of what the row had; the row keeps the total for the admin screens.
    const extra = await c.shared.incr(`fail:${table}:${row.ROWID}`, 24)
    n = Number(row.failed_logins ?? 0) + Math.max(1, extra)
    await db.update(table, row.ROWID, { failed_logins: n })
  }
  // This network's lock: 1 → 5 → 15 minutes on every 5th wrong try from it (the count lasts a day).
  const net = netOf(c)
  const mine = await c.shared.incr(netCount(kind, account, net), 24)
  if (mine > 0 && mine % LOCK_AFTER === 0) {
    const minutes = LOCK_STEPS[Math.min(mine / LOCK_AFTER, LOCK_STEPS.length) - 1]
    await c.shared.set(netLock(kind, account, net), String(Date.now() + minutes * 60_000), minutes / 60 + 1 / 60)
  }
  // A wide attack (many networks): the whole account, as before — devices that signed in before still get in.
  const wide = await c.shared.incr(`lwide:${kind}:${account}:${Math.floor(Date.now() / (WIDE_WINDOW_MIN * 60_000))}`, WIDE_WINDOW_MIN / 60 + 1 / 60)
  if (wide >= WIDE_LOCK_AFTER && (wide - WIDE_LOCK_AFTER) % LOCK_AFTER === 0) {
    await db.update(table, row.ROWID, { locked_until: new Date(Date.now() + WIDE_LOCK_MIN * 60_000).toISOString() })
  }
  return n
}

/**
 * A right password: a new device token for this browser (returned once; only its hash is kept), bound to the
 * account's token_version. The token this sign-in came with (if any) is dropped, and only the newest 5 are kept.
 */
export async function issueDeviceToken(c: Ctx, kind: Kind, id: string, tokenVersion: number, rowId = id): Promise<string> {
  if (kind === 'admin') await c.shared.del(`fail:platform_admins:${rowId}`)
  // Signed in: this network's wrong-try count and lock for the account start again (as the account's total does).
  const net = netOf(c)
  await Promise.all([c.shared.del(netCount(kind, id, net)), c.shared.del(netLock(kind, id, net))])
  const sent = c.loginDevice && DEVICE_TOKEN.test(c.loginDevice) ? tokenHash(c.loginDevice) : null
  // Drop the token this sign-in came with, and any made for an older password (token_version).
  let list = (await readDevices(c, kind, id)).filter((d) => d.h !== sent && Number(d.tv) === tokenVersion)
  const token = randomBytes(32).toString('base64url')
  list.push({ h: tokenHash(token), tv: tokenVersion })
  // Newest 5 only. (A dropped token's wrong-try count no longer matters: it isn't in the list; it expires by itself.)
  list = list.slice(-MAX_DEVICES)
  await c.shared.set(listKey(kind, id), JSON.stringify(list), TRUST_HOURS)
  return token
}

/** Wrong password, or the account is locked (same reply, so it doesn't tell which accounts exist). */
export const WRONG_SHOP = 'Wrong mobile number or password. After 5 wrong tries, wait a few minutes.'
export const WRONG_ADMIN = 'Wrong admin username or password. After 5 wrong tries, wait a few minutes.'
export const lockedError = (_minutes: number, kind: Kind = 'shop') => new ApiError(kind === 'admin' ? WRONG_ADMIN : WRONG_SHOP, 401, 'BAD_LOGIN')
