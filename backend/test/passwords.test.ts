import { test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { checkPassword, DEFAULT_ITERATIONS, hashPassword, needsRehash } from '../src/core/passwords'
import { withShop } from './fixtures'
import { TEST_DB } from './helpers'

const cpu = async (fn: () => Promise<unknown>) => { const a = process.cpuUsage(); await fn(); const d = process.cpuUsage(a); return (d.user + d.system) / 1000 }
const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('PBKDF2-SHA256: right and wrong passwords, a new salt every time, about 4 ms of CPU', async () => {
  await withEnv({ PASSWORD_PEPPER: undefined, PASSWORD_ITERATIONS: undefined }, async () => {
    const h1 = await hashPassword('shop1234'), h2 = await hashPassword('shop1234')
    assert.match(h1, new RegExp(`^pbkdf2-sha256\\$${DEFAULT_ITERATIONS}\\$n\\$[\\w-]{22}\\$[\\w-]{43}$`))
    assert.notEqual(h1, h2, 'random salt')
    assert.equal(await checkPassword('shop1234', h1), true)
    assert.equal(await checkPassword('shop1235', h1), false)
    assert.equal(await checkPassword('', h1), false)
    assert.equal(await checkPassword('shop1234', 'garbage'), false)
    assert.equal(await checkPassword('shop1234', null), false)
    assert.equal(needsRehash(h1), false)
    await checkPassword('shop1234', h1) // warm up
    const ms = Math.min(await cpu(() => checkPassword('shop1234', h1)), await cpu(() => checkPassword('shop1234', h1)))
    assert.ok(ms < 8, `check took ${ms.toFixed(1)} ms of CPU`)
  })
})

test('pepper and iterations: old hashes keep working and are flagged for an upgrade', async () => {
  const plain = await withEnvValue({ PASSWORD_PEPPER: undefined }, () => hashPassword('shop1234'))
  await withEnv({ PASSWORD_PEPPER: 'a-test-pepper-0123456789-abcdefghij' }, async () => {
    assert.equal(await checkPassword('shop1234', plain), true, 'made before the pepper was set')
    assert.equal(needsRehash(plain), true)
    const peppered = await hashPassword('shop1234')
    assert.match(peppered, /\$p\$/)
    assert.equal(await checkPassword('shop1234', peppered), true)
    assert.equal(needsRehash(peppered), false)
    await withEnv({ PASSWORD_PEPPER: undefined }, async () => assert.equal(await checkPassword('shop1234', peppered), false, 'pepper removed: refused, never guessed'))
    await withEnv({ PASSWORD_PEPPER: 'a-different-pepper-xxxxxxxxxxxxxxxxx' }, async () => assert.equal(await checkPassword('shop1234', peppered), false))
  })
  await withEnv({ PASSWORD_PEPPER: undefined, PASSWORD_ITERATIONS: '40000' }, async () => {
    assert.equal(await checkPassword('shop1234', plain), true, 'fewer iterations still check')
    assert.equal(needsRehash(plain), true)
    assert.match(await hashPassword('x'), /\$40000\$/)
  })
  await withEnv({ PASSWORD_ITERATIONS: '5' }, async () => assert.match(await hashPassword('x'), new RegExp(`\\$${DEFAULT_ITERATIONS}\\$`), 'too low → default'))
  // Older bcrypt hashes.
  const old = await bcrypt.hash('shop1234', 4)
  assert.equal(await checkPassword('shop1234', old), true)
  assert.equal(await checkPassword('nope', old), false)
  assert.equal(needsRehash(old), true)
})
async function withEnvValue<T>(env: Record<string, string | undefined>, fn: () => Promise<T>) { let out!: T; await withEnv(env, async () => { out = await fn() }); return out }

test('sign-in: a bcrypt password works once more and is stored as PBKDF2; lockout unchanged', async () => {
  const s = await withShop()
  try {
    const owner = await s.call<{ user: { id: string } }>('auth.me')
    const stored = async () => String((await s.db.get('users', owner.user.id))?.password_hash)
    assert.match(await stored(), /^pbkdf2-sha256\$/, 'new logins are PBKDF2')
    // An account from before: bcrypt hash.
    await s.db.update('users', owner.user.id, { password_hash: await bcrypt.hash('shop1234', 4) })
    s.setToken(null)
    await s.call('auth.login', 'lakshmi', 'shop1234')
    assert.match(await stored(), /^pbkdf2-sha256\$/, 'upgraded at sign-in')
    const t = (await s.call<{ token: string }>('auth.login', 'lakshmi', 'shop1234')).token
    assert.ok(t)
    // Wrong password: same message; 5 wrong tries lock the account.
    for (let i = 0; i < 4; i++) await assert.rejects(s.call('auth.login', 'lakshmi', 'wrong-pass'), /Wrong mobile number or password/)
    await assert.rejects(s.call('auth.login', 'lakshmi', 'wrong-pass'), /Wrong mobile number or password/)
    await assert.rejects(s.call('auth.login', 'lakshmi', 'shop1234'), /Wrong mobile number or password/ /* locked: the same reply (L7) */)
    await assert.rejects(s.call('auth.login', 'nobody-here', 'shop1234'), /Wrong mobile number or password/)
    // Admin sign-in upgrades too.
    const [adm] = await s.env.dbs.platform().then((db) => db.select('platform_admins', { limit: 1 }))
    await (await s.env.dbs.platform()).update('platform_admins', adm.ROWID, { password_hash: await bcrypt.hash('secret123', 4) })
    await s.call('admin.login', 'admin1', 'secret123')
    assert.match(String((await (await s.env.dbs.platform()).get('platform_admins', adm.ROWID))?.password_hash), /^pbkdf2-sha256\$/)
  } finally { s.close() }
})

// hrana: the fake Turso server runs in this same process, so its database CPU would be counted here too
// (on Cloudflare + Turso the database's CPU is not part of the Worker's limit).
test('the password APIs stay inside 10 ms of CPU', { skip: TEST_DB === 'hrana' }, async () => {
  const s = await withShop()
  try {
    s.setToken(null)
    const login = () => s.call('auth.login', 'lakshmi', 'shop1234')
    await login()
    const ms = Math.min(await cpu(login), await cpu(login), await cpu(login))
    assert.ok(ms < 10, `auth.login ${ms.toFixed(1)} ms`)
  } finally { s.close() }
})
