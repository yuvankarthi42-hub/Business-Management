import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { billWeight, cleanScale, parseScaleLine, SCALE_DEFAULTS } from '@/core/scale'
import type { Branch } from '@/core/types'

test('Scale lines: the weight in kg and whether it is steady, from the formats Indian scales send', () => {
  assert.deepEqual(parseScaleLine('ST,GS,+  0.500kg'), { kg: 0.5, stable: true })
  assert.deepEqual(parseScaleLine('US,GS,+  0.498kg'), { kg: 0.498, stable: false })
  assert.deepEqual(parseScaleLine('   0.500 kg'), { kg: 0.5, stable: null })
  assert.deepEqual(parseScaleLine('W:  500 g'), { kg: 0.5, stable: null })
  assert.deepEqual(parseScaleLine('\x02  1.250\x03'), { kg: 1.25, stable: null }, 'no unit = kg; STX / ETX ignored')
  assert.deepEqual(parseScaleLine('ST,NT,-0.020 kg'), { kg: -0.02, stable: true })
  assert.equal(parseScaleLine('ERR'), null)
  assert.equal(parseScaleLine(''), null)
  assert.equal(parseScaleLine('99999'), null, 'nonsense readings ignored')
})

test('Billed weight: tomato 500 g at ₹50/kg = ₹25; empty pan ignored; rounding', () => {
  const s = { ...SCALE_DEFAULTS }
  const kg = billWeight(0.5, s)
  assert.equal(kg, 0.5)
  assert.equal(Math.round(kg * 50 * 100) / 100, 25)
  assert.equal(billWeight(0.004, s), 0, 'below 10 g = empty pan')
  assert.equal(billWeight(-0.02, s), 0)
  assert.equal(billWeight(0.503, { minGrams: 10, roundGrams: 5 }), 0.505)
  assert.equal(billWeight(0.503, { minGrams: 10, roundGrams: 10 }), 0.5)
  assert.equal(billWeight(1.2345, { minGrams: 10, roundGrams: 0 }), 1.235)
})

test('cleanScale: known values only; unknown brand / speed fall back', () => {
  const c = cleanScale({ enabled: true, brand: 'bogus', baudRate: 1234, minGrams: -5, roundGrams: 7, extra: 1 })
  assert.deepEqual(c, { ...SCALE_DEFAULTS, enabled: true, minGrams: 0 })
  assert.equal(cleanScale({ brand: 'omace', baudRate: 2400 }).brand, 'omace')
  assert.equal(cleanScale({ brand: 'omace', baudRate: 2400 }).baudRate, 2400)
})

test('Server: each branch saves its own scale; cashier of the branch may; nobody else; old branches have none', async () => {
  const s = await withShop()
  try {
    type Me = { branches: Branch[] }
    const branchOf = async (id: string) => (await s.call<Me>('auth.me')).branches.find((b) => b.id === id)!
    assert.equal((await branchOf(s.mainBranch)).scale, undefined, 'no scale until set up')
    const town = await s.call<{ id: string }>('branches.save', { name: 'Town' })
    await s.call('branches.saveScale', s.mainBranch, { enabled: true, brand: 'essae', baudRate: 9600, junk: 1 })
    const main = await branchOf(s.mainBranch)
    assert.equal(main.scale?.enabled, true)
    assert.equal(main.scale?.brand, 'essae')
    assert.ok(!('junk' in main.scale!))
    assert.equal((await branchOf(town.id)).scale, undefined, 'other branch unchanged')
    // Only the fields sent change.
    await s.call('branches.saveScale', s.mainBranch, { roundGrams: 5 })
    assert.equal((await branchOf(s.mainBranch)).scale?.brand, 'essae')
    assert.equal((await branchOf(s.mainBranch)).scale?.roundGrams, 5)

    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Ravi', phone: '9876500002', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234', branchId: s.mainBranch, branchIds: [s.mainBranch] })
    await s.call('users.save', { name: 'Kumar', phone: '9876500003', roleId: roles.find((r) => r.name === 'Waiter')!.id, password: 'kumar123', branchId: s.mainBranch, branchIds: [s.mainBranch] })
    s.setToken((await s.call<{ token: string }>('auth.login', '9876500002', 'ravi1234')).token)
    await s.call('branches.saveScale', s.mainBranch, { autoAdd: false })
    await assert.rejects(s.call('branches.saveScale', town.id, { enabled: true }), /Branch not found/)
    s.setToken((await s.call<{ token: string }>('auth.login', '9876500003', 'kumar123')).token)
    await assert.rejects(s.call('branches.saveScale', s.mainBranch, { enabled: false }), /permission/)
    s.setToken(s.ownerToken)
    assert.equal((await branchOf(s.mainBranch)).scale?.autoAdd, false)
  } finally { s.close() }
})
