// H1: customers' order tracking can't be used to read other orders, and rate limits can't be dodged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { cleanIp, isPrivateIp, resolveClientIp } from '../src/core/clientIp'
import { MemoryKv } from '../src/core/kv'

const req = (headers: Record<string, string>, peer = '10.1.2.3') => ({ header: (n: string) => headers[n.toLowerCase()], socket: { remoteAddress: peer } })
const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'production', ...extra }) as NodeJS.ProcessEnv

test('Client address (Catalyst): a made-up X-Forwarded-For is never used; the gateway-added address is', () => {
  // The visitor sends "1.1.1.1"; Catalyst's gateway appends the real address 49.204.10.20; the peer is internal.
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '1.1.1.1, 49.204.10.20' }), prod()).ip, '49.204.10.20')
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '8.8.8.8,9.9.9.9 , 49.204.10.20, 10.0.0.5' }), prod()).ip, '49.204.10.20', 'internal hops skipped')
  // Extra proxies we run (TRUSTED_PROXIES) are skipped too.
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '1.1.1.1, 49.204.10.20, 203.0.113.9' }), prod({ TRUSTED_PROXIES: '203.0.113.0/24' })).ip, '49.204.10.20')
  // Junk in the header is ignored.
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': 'evil, <script>, 49.204.10.20' }), prod()).ip, '49.204.10.20')
  assert.equal(resolveClientIp(req({}, '49.204.10.20'), prod()).ip, '49.204.10.20', 'no header: the peer')
})

test('Client address (Cloudflare, off by default): CF-Connecting-IP only with our secret header', () => {
  const env = prod({ CLIENT_IP_SOURCE: 'cloudflare', CF_EDGE_SECRET: 'edge-secret-0123456789' })
  const h = { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '1.1.1.1, 172.70.1.1' }
  assert.equal(resolveClientIp(req({ ...h, 'x-edge-auth': 'edge-secret-0123456789' }), env).ip, '1.1.1.1')
  assert.equal(resolveClientIp(req({ ...h, 'x-edge-auth': 'wrong' }), env).ip, '172.70.1.1', 'without the secret the header is not trusted')
  assert.equal(resolveClientIp(req(h), prod()).ip, '172.70.1.1', 'Catalyst mode ignores CF-Connecting-IP')
  // Locally: the socket only.
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '1.1.1.1' }, '127.0.0.1'), { NODE_ENV: 'test' } as NodeJS.ProcessEnv).ip, '127.0.0.1')
  assert.equal(cleanIp('[::ffff:49.204.10.20]:443'), '49.204.10.20')
  assert.ok(isPrivateIp('100.64.1.1') && isPrivateIp('fd00::1') && !isPrivateIp('49.204.10.20'))
})

test('Atomic counter: calls at the same moment are all counted', async () => {
  const kv = new MemoryKv()
  const got = await Promise.all(Array.from({ length: 50 }, () => kv.incr('k', 1)))
  assert.deepEqual([...got].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1))
})

test('Tracking: by random code only; counter bills and other ids are not readable; old QR links work 2 days', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 20 })
    // A counter bill (not a QR order).
    const counter = { order: await s.call<{ id: string; number: string }>('orders.checkout', { type: 'takeaway', tableId: null, customerId: null, items: [{ id: 'tmp_1', productId: tea.id, name: 'x', variantId: null, variantName: null, addOns: [], qty: 1, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '' }], discount: 0, notes: '', source: 'pos' }, [{ method: 'cash', amount: 20 }]) }
    s.setToken(null)
    const placed = await s.call<{ orderId: string; number: string; trackCode: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: tea.id, variantId: null, addOnIds: [], qty: 2, notes: '' }], guest: { name: 'Anu', phone: '9811111111', address: '' }, notes: '' })
    assert.match(placed.trackCode, /^[A-Za-z0-9_-]{22}$/)
    const v = await s.call<{ number: string; total: number; code: string }>('public.order', s.businessId, placed.trackCode)
    assert.equal(v.number, placed.number)
    assert.equal(v.code, placed.trackCode)
    // Guessing: the counter bill's id, made-up ids and made-up codes all say "not found".
    await assert.rejects(s.call('public.order', s.businessId, counter.order.id), /Order not found/)
    await assert.rejects(s.call('public.order', s.businessId, String(Number(placed.orderId) + 50)), /Order not found/)
    await assert.rejects(s.call('public.order', s.businessId, 'A'.repeat(22)), /Order not found/)
    await assert.rejects(s.call('public.order', s.businessId, '../../etc'), /Order not found/)
    // A QR link made before codes (row id) still opens inside the tracking window.
    assert.equal((await s.call<{ number: string }>('public.order', s.businessId, placed.orderId)).number, placed.number)
    // "Track my order" by number: the counter bill gets a code (made now) — its row id is never handed out.
    const t = await s.call<{ orderId: string }>('public.track', s.businessId, counter.order.number)
    assert.match(t.orderId, /^[A-Za-z0-9_-]{22}$/)
    assert.notEqual(t.orderId, counter.order.id)
    assert.equal((await s.call<{ number: string }>('public.order', s.businessId, t.orderId)).number, counter.order.number)
    // The same number again → the same code.
    assert.equal((await s.call<{ orderId: string }>('public.track', s.businessId, counter.order.number)).orderId, t.orderId)
  } finally { s.close() }
})

test('Tracking lookups are rate-limited per address (calls at the same moment counted)', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { modules: { billing: true, qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    s.setToken(null)
    const tries = await Promise.allSettled(Array.from({ length: 140 }, () => s.call('public.order', s.businessId, 'B'.repeat(22))))
    const limited = tries.filter((r) => r.status === 'rejected' && /Too many tries/.test(String((r as PromiseRejectedResult).reason?.message))).length
    assert.equal(limited, 20, '120 a minute, the rest refused')
  } finally { s.close() }
})
