// H2: sign-in guessing protection — atomic wrong-password counts, growing short locks, rate limits, the owner's
// own device isn't locked out, and stronger new passwords (existing ones keep working).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { hashPassword } from '../src/core/passwords'

type S = Awaited<ReturnType<typeof withShop>>
const code = (e: unknown) => (e as { code?: string }).code
/** A staff login of its own, so each check starts with a clean count. */
async function staff(s: S, phone: string, password = 'Counter#2026') {
  const roles = await s.call<{ id: string; name: string }[]>('roles.list')
  return s.call<{ id: string }>('users.save', { name: `Staff ${phone}`, phone, roleId: roles.find((r) => r.name === 'Cashier')!.id, password, branchId: s.mainBranch })
}
const login = (s: S, phone: string, password: string) => { s.setToken(null); return s.call<{ token: string }>('auth.login', phone, password) }
const userRow = async (s: S, id: string) => s.db.get('users', id)

test('A right password is never counted as a wrong one; a right sign-in clears the count', async () => {
  const s = await withShop()
  try {
    const u = await staff(s, '9876500011')
    for (let i = 0; i < 4; i++) await assert.rejects(login(s, '9876500011', 'wrong-pass'), (e) => code(e) === 'BAD_LOGIN')
    assert.equal(Number((await userRow(s, u.id))!.failed_logins), 4)
    await login(s, '9876500011', 'Counter#2026')
    const r = await userRow(s, u.id)
    assert.equal(Number(r!.failed_logins), 0)
    assert.equal(r!.locked_until ?? null, null)
  } finally { s.close() }
})

test('Wrong passwords sent at the same moment are all counted (atomic); a burst is cut by the per-login limit', async () => {
  const s = await withShop()
  try {
    const u = await staff(s, '9876500012')
    s.setToken(null)
    const res = await Promise.allSettled(Array.from({ length: 25 }, () => s.call('auth.login', '9876500012', 'wrong-pass')))
    const codes = res.map((r) => (r.status === 'rejected' ? code(r.reason) : 'OK'))
    assert.equal(codes.filter((c) => c === 'RATE_LIMITED').length, 15, '10 tries a minute at one login from one address')
    // Every try that got through was a wrong password and was counted — none lost to a race.
    const r = await userRow(s, u.id)
    const tried = codes.filter((c) => c === 'BAD_LOGIN').length
    assert.equal(tried, 10)
    assert.ok(Number(r!.failed_logins) >= 5 && Number(r!.failed_logins) <= 10, `counted ${r!.failed_logins}`)
    assert.ok(r!.locked_until, 'locked after 5')
    assert.ok(!codes.includes('OK'))
  } finally { s.close() }
})

test('Every 5th wrong try locks for a short, growing time (1 → 5 → 15 min, never longer)', async () => {
  const s = await withShop()
  try {
    const u = await staff(s, '9876500013')
    for (let i = 0; i < 5; i++) await assert.rejects(login(s, '9876500013', 'wrong-pass'), (e) => code(e) === 'BAD_LOGIN')
    let r = await userRow(s, u.id)
    const mins = (x: unknown) => Math.round((Date.parse(String(x)) - Date.now()) / 60_000)
    assert.equal(mins(r!.locked_until), 1)
    // While locked, even the right password is refused (this device never signed in) — and it isn't counted.
    await assert.rejects(login(s, '9876500013', 'Counter#2026'), (e) => code(e) === 'BAD_LOGIN')
    assert.equal(Number((await userRow(s, u.id))!.failed_logins), 5)
    // The next lock level (simulate the first lock having ended, as the counter keeps growing).
    await s.db.update('users', u.id, { locked_until: null, failed_logins: 9 })
    await assert.rejects(login(s, '9876500013', 'wrong-pass'), (e) => code(e) === 'BAD_LOGIN')
    r = await userRow(s, u.id)
    assert.equal(mins(r!.locked_until), 5)
    await s.db.update('users', u.id, { locked_until: null, failed_logins: 29 })
    await assert.rejects(login(s, '9876500013', 'wrong-pass'), (e) => code(e) === 'BAD_LOGIN', 'rate limit not hit (different minute keys are not needed: 3 tries)')
    assert.equal(mins((await userRow(s, u.id))!.locked_until), 15, 'capped at 15 minutes')
  } finally { s.close() }
})

/** Lock the account as if someone had just made 5 wrong guesses (keeps these tests under the per-login rate limit). */
const lock = (s: S, id: string) => s.db.update('users', id, { locked_until: new Date(Date.now() + 15 * 60_000).toISOString(), failed_logins: 5 })
const signIn = async (s: S, phone: string, password: string, device: string | null) => {
  s.setToken(null); s.setLoginDevice(device)
  try { return await s.call<{ token: string; deviceToken: string }>('auth.login', phone, password) } finally { s.setLoginDevice(null) }
}

test('Device token: issued by the server, skips a lock made by someone else, renewed on every sign-in', async () => {
  const s = await withShop()
  try {
    const u = await staff(s, '9876500014')
    const first = await signIn(s, '9876500014', 'Counter#2026', null)
    assert.match(first.deviceToken, /^[A-Za-z0-9_-]{43}$/, '32 random bytes')
    await lock(s, u.id)
    await assert.rejects(signIn(s, '9876500014', 'Counter#2026', null), (e) => code(e) === 'BAD_LOGIN', 'no token: waits')
    // The owner's browser (its token) still signs in — and gets a new token.
    const again = await signIn(s, '9876500014', 'Counter#2026', first.deviceToken)
    assert.notEqual(again.deviceToken, first.deviceToken)
    // The old token was dropped: a copy of it no longer skips a lock.
    await lock(s, u.id)
    await assert.rejects(signIn(s, '9876500014', 'Counter#2026', first.deviceToken), (e) => code(e) === 'BAD_LOGIN')
    await signIn(s, '9876500014', 'Counter#2026', again.deviceToken)
    // A token never skips the password.
    await assert.rejects(signIn(s, '9876500014', 'wrong-pass', again.deviceToken), (e) => code(e) === 'BAD_LOGIN')
  } finally { s.close() }
})

test('Device token: made-up, other people’s and the old tab id never skip a lock', async () => {
  const s = await withShop()
  try {
    const a = await staff(s, '9876500016')
    await staff(s, '9876500017')
    const other = await signIn(s, '9876500017', 'Counter#2026', null)
    await signIn(s, '9876500016', 'Counter#2026', null)
    await lock(s, a.id)
    await assert.rejects(signIn(s, '9876500016', 'Counter#2026', 'A'.repeat(43)), (e) => code(e) === 'BAD_LOGIN', 'made up')
    await assert.rejects(signIn(s, '9876500016', 'Counter#2026', other.deviceToken), (e) => code(e) === 'BAD_LOGIN', 'another user’s token')
    await assert.rejects(signIn(s, '9876500016', 'Counter#2026', 'not-a-token'), (e) => code(e) === 'BAD_LOGIN', 'wrong shape ignored')
    // The change-feed tab id (x-device) no longer counts at all.
    s.setDevice('owner-phone-1234')
    await assert.rejects(signIn(s, '9876500016', 'Counter#2026', null), (e) => code(e) === 'BAD_LOGIN')
    s.setDevice(null)
  } finally { s.close() }
})

test('Device token: void after a password change / reset, and after 5 wrong passwords sent with it', async () => {
  const s = await withShop()
  try {
    const u = await staff(s, '9876500018')
    const t1 = (await signIn(s, '9876500018', 'Counter#2026', null)).deviceToken
    // The owner resets this staff member's password → token_version changes → every device token is void.
    s.setToken(s.ownerToken)
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { id: u.id, name: 'Staff', phone: '9876500018', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'NewPass#2026' })
    await lock(s, u.id)
    await assert.rejects(signIn(s, '9876500018', 'NewPass#2026', t1), (e) => code(e) === 'BAD_LOGIN')
    // A fresh token, then 5 wrong passwords with it: it stops skipping locks.
    await s.db.update('users', u.id, { locked_until: null, failed_logins: 0 })
    const t2 = (await signIn(s, '9876500018', 'NewPass#2026', null)).deviceToken
    for (let i = 0; i < 5; i++) await assert.rejects(signIn(s, '9876500018', 'wrong-pass', t2), (e) => code(e) === 'BAD_LOGIN' || code(e) === 'BAD_LOGIN')
    await lock(s, u.id)
    await assert.rejects(signIn(s, '9876500018', 'NewPass#2026', t2), (e) => code(e) === 'BAD_LOGIN')
  } finally { s.close() }
})

test('Device token: at most 5 per account (the oldest is dropped)', async () => {
  const s = await withShop()
  try {
    const u = await staff(s, '9876500019')
    const tokens: string[] = []
    for (let i = 0; i < 6; i++) tokens.push((await signIn(s, '9876500019', 'Counter#2026', null)).deviceToken)
    await lock(s, u.id)
    await assert.rejects(signIn(s, '9876500019', 'Counter#2026', tokens[0]), (e) => code(e) === 'BAD_LOGIN', 'the 6th sign-in dropped the 1st')
    await signIn(s, '9876500019', 'Counter#2026', tokens[5])
  } finally { s.close() }
})

test('Admin sign-in gets and honours a device token the same way', async () => {
  const s = await withShop()
  try {
    s.setToken(null)
    const r = await s.call<{ deviceToken: string }>('admin.login', 'admin1', 'secret123')
    assert.match(r.deviceToken, /^[A-Za-z0-9_-]{43}$/)
    const p = await s.env.dbs.platform()
    const a = (await p.first('platform_admins', { username: 'admin1' }))!
    await p.update('platform_admins', a.ROWID, { locked_until: new Date(Date.now() + 15 * 60_000).toISOString() })
    await assert.rejects(s.call('admin.login', 'admin1', 'secret123'), (e) => code(e) === 'BAD_LOGIN')
    s.setLoginDevice(r.deviceToken)
    await s.call('admin.login', 'admin1', 'secret123')
    s.setLoginDevice(null)
  } finally { s.close() }
})

test('Admin sign-in: same protection; unknown names answer the same', async () => {
  const s = await withShop()
  try {
    s.setToken(null)
    await assert.rejects(s.call('admin.login', 'nobody', 'x'), (e) => code(e) === 'BAD_LOGIN')
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => s.call('admin.login', 'admin1', 'wrong-pass')))
    assert.ok(res.every((r) => r.status === 'rejected'))
    const a = await s.env.dbs.platform().then((p) => p.first('platform_admins', { username: 'admin1' }))
    assert.equal(Number(a!.failed_logins), 6, 'all 6 counted')
    assert.ok(a!.locked_until)
  } finally { s.close() }
})

test('Many sign-ins from one address are limited (all logins)', async () => {
  const s = await withShop()
  try {
    s.setToken(null)
    const res = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => s.call('auth.login', `98765${String(70000 + i)}`, 'x-password')))
    assert.equal(res.filter((r) => r.status === 'rejected' && code(r.reason) === 'RATE_LIMITED').length, 40 - 29, '30 a minute (one was the fixture sign-in)')
  } finally { s.close() }
})

test('New passwords: 8+ characters, not common, not the mobile number; existing short passwords still sign in', async () => {
  const s = await withShop()
  try {
    await assert.rejects(staff(s, '9876500015', 'abc123'), /at least 8/)
    await assert.rejects(staff(s, '9876500015', '12345678'), /too easy/)
    await assert.rejects(staff(s, '9876500015', '9876500015'), /mobile number or username/)
    const u = await staff(s, '9876500015', 'Kadai#2026')
    // A password set before the rule (6 characters) keeps working.
    await s.db.update('users', u.id, { password_hash: await hashPassword('old123') })
    await login(s, '9876500015', 'old123')
  } finally { s.close() }
})
