import { test } from 'node:test'
import assert from 'node:assert/strict'
import { testEnv, PER_SHOP } from './helpers'
import { DbKv } from '../src/core/dbKv'

test('Turso shared cache (kv_cache table): set, get, overwrite, expiry, delete — never throws', { skip: !PER_SHOP }, async () => {
  const env = await testEnv()
  try {
    const kv = new DbKv(() => env.dbs.platform())
    assert.equal(await kv.get('a'), null)
    await kv.set('a', 'one', 1)
    assert.equal(await kv.get('a'), 'one')
    await kv.set('a', 'two', 1)
    assert.equal(await kv.get('a'), 'two', 'overwrite')
    await kv.set('old', 'x', -1) // already expired
    assert.equal(await kv.get('old'), null, 'expired values are not returned')
    await kv.del('a')
    assert.equal(await kv.get('a'), null)
    // A broken database never fails the request — the code just reads the real data.
    const broken = new DbKv(async () => { throw new Error('down') })
    assert.equal(await broken.get('a'), null)
    await broken.set('a', 'b')
    await broken.del('a')
  } finally { env.stop() }
})
