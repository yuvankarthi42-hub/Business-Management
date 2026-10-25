import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { withShop } from './fixtures'
import type { FakePush } from './helpers'
import { encryptPayload, isPushEndpoint } from '../src/core/webpush'

type P = { id: string }
type View = { number: string; qrStatus: string | null; kitchen: string | null; status: string; cached: boolean; checkedAt: string }

test('order tracking: cached status (no database read until something changes), track by order number, rate limit', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true, qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const dosa = await s.call<P>('products.save', { name: 'Dosa', price: 60, sendToKitchen: true })
    s.setToken(null)
    const placed = await s.call<{ orderId: string; number: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: dosa.id, variantId: null, addOnIds: [], qty: 1, notes: '' }], guest: { name: 'Anu', phone: '9811122233', address: '' }, notes: '' })

    // First look reads the database; asking again while nothing changed is answered from the cache.
    const v1 = await s.call<View>('public.order', s.businessId, placed.orderId)
    assert.deepEqual([v1.qrStatus, v1.cached], ['pending', false])
    const v2 = await s.call<View>('public.order', s.businessId, placed.orderId)
    assert.equal(v2.cached, true, 'unchanged → no database read')
    assert.equal(JSON.stringify(v2).includes('9811122233'), false, 'never shows the customer’s phone')

    // Staff accept → the next look reads the new status once.
    s.setToken(s.ownerToken)
    await s.call('qr.accept', placed.orderId)
    s.setToken(null)
    const v3 = await s.call<View>('public.order', s.businessId, placed.orderId)
    assert.deepEqual([v3.qrStatus, v3.cached], ['accepted', false])
    assert.equal((await s.call<View>('public.order', s.businessId, placed.orderId)).cached, true)

    // Track my order: by number, with or without the prefix.
    const digits = placed.number.replace(/\D/g, '')
    assert.equal((await s.call<{ orderId: string }>('public.track', s.businessId, placed.number)).orderId, placed.orderId)
    assert.equal((await s.call<{ orderId: string }>('public.track', s.businessId, ` ${digits} `)).orderId, placed.orderId)
    await assert.rejects(s.call('public.track', s.businessId, '999999'), /No order with that number/)
    await assert.rejects(s.call('public.track', s.businessId, ''), /Enter your order number/)
    // At most 10 tries a minute from one address.
    let limited = false
    for (let i = 0; i < 12 && !limited; i++) await s.call('public.track', s.businessId, '1').catch((e: Error & { code?: string }) => { if (e.code === 'RATE_LIMITED') limited = true })
    assert.ok(limited, 'too many tries are refused')
    await assert.rejects(s.call('public.order', s.businessId, '999999'), /Order not found/)
  } finally { s.close() }
})

test('notify me: a push when the order is confirmed and ready; unsubscribed when done; bad subscriptions refused', async () => {
  const s = await withShop()
  try {
    const push = s.env.push as FakePush
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true, qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const dosa = await s.call<P>('products.save', { name: 'Dosa', price: 60, sendToKitchen: true })
    s.setToken(null)
    assert.equal((await s.call<{ publicKey: string }>('public.pushKey')).publicKey, push.publicKey)
    const placed = await s.call<{ orderId: string; number: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: dosa.id, variantId: null, addOnIds: [], qty: 1, notes: '' }], guest: { name: 'Anu', phone: '9811122233', address: '' }, notes: '' })
    const ua = createECDH('prime256v1'); ua.generateKeys()
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
    await assert.rejects(s.call('public.subscribePush', s.businessId, placed.orderId, { ...sub, endpoint: 'http://169.254.169.254/latest' }), /can’t receive notifications/)
    assert.deepEqual(await s.call('public.subscribePush', s.businessId, placed.orderId, sub), { ok: true, stage: 'sent' })
    assert.equal(push.sent.length, 0)

    s.setToken(s.ownerToken)
    await s.call('qr.accept', placed.orderId)
    assert.equal(push.sent.length, 1)
    assert.match(String(push.sent[0].payload.title), new RegExp(`Order ${placed.number.replace('#', '\\#')} confirmed`))
    assert.equal(push.sent[0].target.endpoint, sub.endpoint)

    // Preparing: no message (only the big steps). Ready: a message.
    const [kot] = await s.call<{ id: string }[]>('kitchen.list')
    await s.call('kitchen.setStatus', kot.id, 'preparing')
    assert.equal(push.sent.length, 1)
    await s.call('kitchen.setStatus', kot.id, 'ready')
    assert.equal(push.sent.length, 2)
    assert.match(String(push.sent[1].payload.title), /is ready/)
    // The same status again sends nothing.
    await s.call('kitchen.setStatus', kot.id, 'ready')
    assert.equal(push.sent.length, 2)
    // Done: the subscription is removed.
    await s.call('kitchen.setStatus', kot.id, 'completed')
    assert.equal(await s.db.count('push_subscriptions', { order_id: placed.orderId }), 0)
  } finally { s.close() }
})

test('web push message is encrypted so only that browser can read it (RFC 8291)', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys()
  const auth = randomBytes(16)
  const body = encryptPayload({ p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, '{"title":"Order #1042 is ready"}')
  // Decrypt as the browser would.
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen)
  const shared = ua.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  assert.equal(plain.subarray(0, plain.length - 1).toString(), '{"title":"Order #1042 is ready"}')
  assert.equal(plain[plain.length - 1], 2)
  assert.ok(isPushEndpoint('https://web.push.apple.com/abc') && !isPushEndpoint('https://evil.example.com/x'))
})
