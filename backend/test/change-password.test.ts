import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { signToken } from '../src/core/tokens'

test('auth.changePassword: signs other devices out, keeps the QR menu copy; two steps with a proof; the old one-call way unchanged', async () => {
  const s = await withShop()
  const shared = (s.env as unknown as { shared: { get(k: string): Promise<string | null> } }).shared
  const menuVersion = () => shared.get(`menuv:${s.businessId}`)
  try {
    // Another device of the owner, and a staff login.
    const other = (await s.call<{ token: string }>('auth.login', 'lakshmi', 'shop1234')).token
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Ravi', phone: '9800000901', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const staff = (await s.call<{ token: string }>('auth.login', '9800000901', 'ravi1234')).token
    const owner = s.ownerToken

    // The old one-call way: wrong current password refused; right one works.
    await assert.rejects(s.call('auth.changePassword', 'nope', 'newpass1'), /Current password is wrong/)
    await s.call('auth.me') // the menu version exists now
    const v0 = await menuVersion()
    const r1 = await s.call<{ token: string }>('auth.changePassword', 'shop1234', 'newpass1')
    assert.equal(await menuVersion(), v0, 'a password change does not refresh the customers’ QR menu')
    for (const t of [owner, other]) { s.setToken(t); await assert.rejects(s.call('auth.me'), /sign in again/i, 'old devices are signed out') }
    s.setToken(r1.token); assert.ok(await s.call('auth.me'))
    s.setToken(staff); assert.ok(await s.call('auth.me'), 'other users stay signed in')

    // Two steps: a proof, then the change (the current password isn't needed again).
    s.setToken(r1.token)
    await assert.rejects(s.call('auth.checkPassword', 'shop1234'), /Current password is wrong/)
    const { proof } = await s.call<{ proof: string }>('auth.checkPassword', 'newpass1')
    const r2 = await s.call<{ token: string }>('auth.changePassword', '', 'newpass2', { proof })
    s.setToken(r2.token)
    // The same proof again: the password (token version) changed since → not accepted; the current password is checked.
    await assert.rejects(s.call('auth.changePassword', '', 'newpass3', { proof }), /Current password is wrong/)
    // Another user's proof is not accepted for this user.
    s.setToken(staff)
    const staffProof = (await s.call<{ proof: string }>('auth.checkPassword', 'ravi1234')).proof
    s.setToken(r2.token)
    await assert.rejects(s.call('auth.changePassword', '', 'newpass3', { proof: staffProof }), /Current password is wrong/)
    // An expired proof is not accepted.
    const me = await s.call<{ user: { id: string } }>('auth.me')
    const expired = signToken({ t: 'pw', uid: me.user.id, bid: s.businessId, tv: 3 }, -10)
    await assert.rejects(s.call('auth.changePassword', '', 'newpass3', { proof: expired }), /Current password is wrong/)
    // A proof never works as a sign-in.
    s.setToken(proof); await assert.rejects(s.call('auth.me'), /sign in again/i)
    // The new password signs in; the earlier ones don't.
    s.setToken(null)
    assert.ok((await s.call<{ token: string }>('auth.login', 'lakshmi', 'newpass2')).token)
    await assert.rejects(s.call('auth.login', 'lakshmi', 'newpass1'))
    // A staff edit (other sign-in change) still refreshes the QR menu copy, as before.
    s.setToken((await s.call<{ token: string }>('auth.login', 'lakshmi', 'newpass2')).token)
    const v1 = await menuVersion()
    const users = await s.call<{ id: string; name: string }[]>('users.list')
    const ravi = users.find((u) => u.name === 'Ravi')!
    await s.call('users.save', { ...ravi, roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi5678' })
    assert.notEqual(await menuVersion(), v1)
  } finally { s.close() }
})
