// Separate setups never mix (core/account.ts): a token or file link of another account is refused, and a server
// pointed at another account's platform database refuses every request. Without ACCOUNT_ID: exactly as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { signToken, verifyToken } from '../src/core/tokens'
import { checkMediaLink, mediaLink } from '../src/core/media'

const withAccount = <T>(id: string | undefined, fn: () => T): T => {
  const was = process.env.ACCOUNT_ID
  if (id === undefined) delete process.env.ACCOUNT_ID; else process.env.ACCOUNT_ID = id
  try { return fn() } finally { if (was === undefined) delete process.env.ACCOUNT_ID; else process.env.ACCOUNT_ID = was }
}

test('Tokens and file links: another account’s are refused; unmarked ones (before ACCOUNT_ID was set) still work', () => {
  const a = withAccount('cat-1', () => signToken({ t: 'u', uid: '1', bid: '2' }, 3600))
  const plain = withAccount(undefined, () => signToken({ t: 'u', uid: '1', bid: '2' }, 3600))
  assert.equal(withAccount('cat-1', () => verifyToken<{ acc: string }>(a))?.acc, 'cat-1')
  assert.equal(withAccount('cf-1', () => verifyToken(a)), null, 'another account')
  assert.equal(withAccount(undefined, () => verifyToken(a)), null, 'a marked token on a server without ACCOUNT_ID')
  assert.ok(withAccount('cat-1', () => verifyToken(plain)), 'signed here before ACCOUNT_ID was set')
  assert.ok(withAccount(undefined, () => verifyToken(plain)), 'no ACCOUNT_ID anywhere: as before')
  assert.equal(withAccount(undefined, () => 'acc' in (verifyToken(plain) ?? {})), false, 'nothing added without ACCOUNT_ID')
  const key = 'p/support/1/a.webp'
  const link = withAccount('cat-1', () => mediaLink(key))
  const [, e, s] = /e=(\d+)&s=([^&]+)/.exec(link)!
  assert.equal(withAccount('cat-1', () => checkMediaLink(key, e, s)), true)
  assert.equal(withAccount('cf-1', () => checkMediaLink(key, e, s)), false)
  assert.equal(withAccount(undefined, () => checkMediaLink(key, e, s)), false)
  assert.throws(() => withAccount('Bad Id!', () => signToken({ t: 'u' }, 60)), /ACCOUNT_ID/)
})

test('A server whose ACCOUNT_ID differs from its platform database’s label refuses every request', async () => {
  const s = await withShop()
  try {
    // No ACCOUNT_ID (Catalyst today): no label read or written.
    await s.call('categories.list')
    assert.equal(await (await s.env.dbs.platform()).first('platform_settings', { setting_key: 'account' }), null)
    // First use with an id labels the database; the same id keeps working (new tokens carry it).
    process.env.ACCOUNT_ID = 'cat-1'
    await s.call('categories.list')
    const row = await (await s.env.dbs.platform()).first('platform_settings', { setting_key: 'account' })
    assert.deepEqual(JSON.parse(String(row?.value_json)), { id: 'cat-1' })
    const login = await s.call<{ token: string }>('auth.login', 'lakshmi', 'shop1234')
    s.setToken(login.token)
    await s.call('categories.list')
    // The other account's server on this database: refused, nothing served.
    process.env.ACCOUNT_ID = 'cf-1'
    await assert.rejects(s.call('categories.list'), (e) => (e as { code?: string }).code === 'CONFIG')
    await assert.rejects(s.call('auth.login', 'lakshmi', 'shop1234'), (e) => (e as { code?: string }).code === 'CONFIG')
    const mig = await fetch(`${s.base}/migrate`, { method: 'POST', headers: { 'x-setup-key': 'test-setup-key-1234567890' } })
    assert.equal(mig.status, 500, 'no migrating another account’s databases')
    process.env.ACCOUNT_ID = 'cat-1'
    await s.call('categories.list')
  } finally { delete process.env.ACCOUNT_ID; s.close() }
})
