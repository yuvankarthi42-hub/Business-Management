// Audit fixes: F-2 (kitchen / QR order displays keep updating when nobody touches them), F-6 (only people who may
// create a campaign can change it or mark it sent), F-7 (the QR codes' web address is http(s) only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { isDisplayScreen, feedInterval } from '../../src/data/remote/feedTiming'
import { qrBaseUrlOk, qrSettings } from '../../src/core/config'
import type { Business } from '../../src/core/types'

const code = (e: unknown) => (e as { code?: string }).code

test('F-2: the kitchen, QR orders and customer orders screens keep asking when idle; other screens do not', () => {
  for (const p of ['/kitchen', '/qr-orders', '/customer-orders', '/kitchen?full=1']) assert.equal(isDisplayScreen(p), true, p)
  for (const p of ['/billing', '/dashboard', '/reports', '/tables', '/kitchenette', '/settings']) assert.equal(isDisplayScreen(p), false, p)
  // Their timing is unchanged (30 s).
  assert.equal(feedInterval('/kitchen'), 30_000)
  assert.equal(feedInterval('/dashboard'), 60_000)
})

test('F-6: kitchen staff can’t change a campaign or mark it sent; the owner still can', async () => {
  const s = await withShop()
  try {
    const prod = await s.call<{ id: string }>('products.save', { name: 'Milk', price: 25 })
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Revathi', phone: '9811100001' })
    const made = await s.call<{ id: string }>('campaigns.create', { message: 'Diwali sweets 10% off', productIds: [prod.id] })
    const role = await s.call<{ id: string }>('roles.save', { name: 'Kitchen only', permissions: ['kitchen.view'] })
    await s.call('users.save', { name: 'Murugan', phone: '9876500061', roleId: role.id, password: 'Kitchen#2026', branchIds: [s.mainBranch] })
    s.setToken(null)
    s.setToken((await s.call<{ token: string }>('auth.login', '9876500061', 'Kitchen#2026')).token)
    await assert.rejects(s.call('campaigns.update', made.id, 'Changed by kitchen staff', []), (e) => code(e) === 'FORBIDDEN')
    await assert.rejects(s.call('campaigns.markSent', made.id, cust.id), (e) => code(e) === 'FORBIDDEN')
    s.setToken(s.ownerToken)
    await s.call('campaigns.update', made.id, 'Diwali sweets 15% off', [prod.id])
    await s.call('campaigns.markSent', made.id, cust.id)
    const [c] = await s.call<{ message: string; sends: unknown[] }[]>('campaigns.today')
    assert.equal(c.message, 'Diwali sweets 15% off')
    assert.equal(c.sends.length, 1)
  } finally { s.close() }
})

test('F-7: the QR address must be empty or http(s)://; only the known QR fields are saved', async () => {
  const s = await withShop()
  try {
    const qr = (baseUrl: unknown, extra: Record<string, unknown> = {}) => s.call('business.update', { qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl, ...extra } })
    for (const bad of ['javascript:alert(document.domain)//', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x.in', 'http://a b.in', `https://${'x'.repeat(200)}.in`, 42])
      await assert.rejects(qr(bad), /web address starting with http/, String(bad))
    await assert.rejects(qr('', { autoAccept: 'yes' }), /auto-accept/)
    await assert.rejects(qr('', { orderTypes: ['counter'] }), /order types/)
    // Still accepted: empty (the app's own address), the local-network address, a domain.
    for (const ok of ['', 'http://10.89.33.221:5173', 'https://shop.example.in/app']) await qr(ok)
    // Unknown fields are not stored.
    await qr('https://shop.example.in', { evil: '<script>' })
    const me = await s.call<{ business: { qr?: Record<string, unknown> } }>('auth.me')
    assert.equal(me.business.qr?.baseUrl, 'https://shop.example.in')
    assert.equal(me.business.qr && 'evil' in me.business.qr, false)
  } finally { s.close() }
})

test('F-7: a bad address saved before the fix is never used', () => {
  const b = (baseUrl: string) => ({ qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl }, billing: { orderTypes: ['counter', 'takeaway'] } }) as unknown as Pick<Business, 'qr' | 'billing'>
  assert.equal(qrSettings(b('javascript:alert(1)//')).baseUrl, '') // the app's own address (none in Node)
  assert.equal(qrSettings(b('http://10.89.33.221:5173')).baseUrl, 'http://10.89.33.221:5173')
  assert.equal(qrSettings(b('')).baseUrl, '')
  assert.equal(qrBaseUrlOk('https://x.in'), true)
  assert.equal(qrBaseUrlOk('javascript:x'), false)
})
