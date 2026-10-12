import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tablesOf } from '../src/db/scoped'
import { TABLES } from '../src/db/schema.gen'
import { startServer, TEST_DB } from './helpers'

test('setup, admin sign-in and guards', async () => {
  const s = await startServer()
  try {
    await assert.rejects(s.call('admin.setup', 'wrong-key', { name: 'A', username: 'admin1', password: 'secret123' }), /not allowed/)
    const made = await s.call<{ username: string }>('admin.setup', 'test-setup-key-1234567890', { name: 'Admin', username: 'admin1', password: 'secret123' })
    assert.equal(made.username, 'admin1')
    await assert.rejects(s.call('admin.setup', 'test-setup-key-1234567890', { name: 'B', username: 'admin2', password: 'secret123' }), /already done/)
    await assert.rejects(s.call('admin.me'), /sign-in required/)
    await assert.rejects(s.call('admin.login', 'admin1', 'nope'), /Wrong admin/)
    const r = await s.call<{ token: string; admin: { role: string } }>('admin.login', 'admin1', 'secret123')
    assert.equal(r.admin.role, 'super')
    s.setToken(r.token)
    const me = await s.call<{ username: string }>('admin.me')
    assert.equal(me.username, 'admin1')
    await assert.rejects(s.call('nope.nothing'), /Unknown action/)
    // An admin token is not a customer session.
    await assert.rejects(s.call('auth.me'), /sign in again/)
  } finally { s.close() }
})

test('schema check passes on a complete database', async () => {
  const s = await startServer()
  try {
    const res = await fetch(`${s.base}/schema-check`, { headers: { 'x-setup-key': 'test-setup-key-1234567890' } })
    const body = await res.json() as { data: { ok: boolean; tables: number } }
    assert.equal(body.data.ok, true)
    assert.equal(body.data.tables, TEST_DB === 'memory' ? Object.keys(TABLES).length : tablesOf('platform').length)
    assert.equal((await fetch(`${s.base}/schema-check`)).status, 403)
  } finally { s.close() }
})
