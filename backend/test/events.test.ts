import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { withShop } from './fixtures'
import { PER_SHOP } from './helpers'
import { Hub, hubRoutes, type HubEvent } from '../src/events/hub'
import type { Db } from '../src/db/types'
import { signToken } from '../src/core/tokens'

type P = { id: string }
type Ev = { event: string; id: string | null; data: Record<string, unknown> }

/** The hub of the test server, served over HTTP (as on AppSail). */
function serveHub(hub: Hub) {
  const app = express()
  app.use('/', hubRoutes(hub))
  const server = app.listen(0)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

/** Opens a stream and collects its events. */
async function openStream(url: string, path: '/stream' | '/public', body: Record<string, unknown>) {
  const ctl = new AbortController()
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), signal: ctl.signal })
  const events: Ev[] = []
  let ended = false
  if (res.ok && res.body) {
    void (async () => {
      const reader = res.body!.getReader(), dec = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2)
            let event = 'message', data = '', id: string | null = null
            for (const l of block.split('\n')) { if (l.startsWith('event:')) event = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); else if (l.startsWith('id:')) id = l.slice(3).trim() }
            if (data) events.push({ event, id, data: JSON.parse(data) })
          }
        }
      } catch { /* aborted */ }
      ended = true
    })()
  }
  const until = async (fn: () => boolean, ms = 2000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); return fn() }
  return { status: res.status, events, close: () => ctl.abort(), until, get ended() { return ended } }
}

/** Counts database calls of the test shop (to prove "no database read"). */
function countQueries(env: { dbs: { shop: (id: string) => Promise<Db> } }) {
  const count = { n: 0 }
  const orig = env.dbs.shop.bind(env.dbs)
  env.dbs.shop = async (id: string) => {
    const db = await orig(id)
    return new Proxy(db, { get(t, k, r) { const v = Reflect.get(t, k, r); return typeof v === 'function' && ['select', 'first', 'get', 'count', 'aggregate', 'sql', 'sqlMany'].includes(String(k)) ? (...a: unknown[]) => { count.n++; return (v as (...x: unknown[]) => unknown).apply(t, a) } : v } })
  }
  return count
}

test('live events: ticket, shop isolation, records for other devices, own device, failed write, public privacy, reconnect', async () => {
  process.env.EVENTS_PUBLIC_URL = '/server/events'
  const a = await withShop()
  const b = await withShop()
  const hubA = (a.env as { hub?: Hub }).hub!
  const http = serveHub(hubA)
  try {
    await a.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true, qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const tea = await a.call<P>('products.save', { name: 'Tea', price: 20, sendToKitchen: true })
    const t = await a.call<{ url: string; ticket: string; feed: boolean }>('events.ticket')
    assert.equal(t.url, '/server/events')
    assert.ok(t.ticket)

    // Not signed: refused. A tampered ticket: refused.
    assert.equal((await openStream(http.url, '/stream', { ticket: 'x.y.z' })).status, 401)
    assert.equal((await openStream(http.url, '/stream', { ticket: t.ticket.slice(0, -2) + 'aa' })).status, 401)

    const kitchen = await openStream(http.url, '/stream', { ticket: t.ticket, device: 'kitchen-screen-1' })
    assert.ok(await kitchen.until(() => kitchen.events.some((e) => e.event === 'hello')))
    const pub = await openStream(http.url, '/public', { shop: a.businessId })

    // A bill from the counter (another device): the kitchen gets the action and the order + ticket inside it.
    a.setDevice('counter-device-1')
    const line = { id: 'n1', productId: tea.id, name: '', variantId: null, variantName: null, addOns: [], qty: 2, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 }
    const saved = await a.call<{ order: { id: string } }>('orders.save', { type: 'takeaway', tableId: null, customerId: null, items: [line], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    assert.ok(await kitchen.until(() => kitchen.events.some((e) => e.data.name === 'orders.save')))
    const ev = kitchen.events.find((e) => e.data.name === 'orders.save')!
    const rec = ev.data.records as { orders: { id: string }[]; kots: { orderId: string; status: string }[] }
    assert.equal(rec.orders[0].id, saved.order.id)
    assert.equal(rec.kots[0].orderId, saved.order.id)
    assert.match(String(ev.id), /^[0-9a-f]+\.\d+$/)
    // One database per shop (Turso) has the change feed; the Catalyst Data Store doesn't (screens reload on a gap).
    if (PER_SHOP) assert.equal(typeof ev.data.cid, 'number', 'carries the change feed number (gap detection)')

    // The device that made the change gets only the number (it already has the result).
    const own = await openStream(http.url, '/stream', { ticket: t.ticket, device: 'counter-device-1' })
    await own.until(() => own.events.some((e) => e.event === 'hello'))
    await a.call('kitchen.setStatus', rec.kots[0] ? (await a.call<{ id: string }[]>('kitchen.list'))[0].id : '', 'preparing')
    assert.ok(await own.until(() => own.events.some((e) => e.data.own === true)))
    assert.equal(own.events.some((e) => e.data.records), false)
    assert.ok(await kitchen.until(() => kitchen.events.some((e) => e.data.name === 'kitchen.setStatus' && (e.data.records as { kots: { status: string }[] }).kots[0].status === 'preparing')))

    // A failed write publishes nothing.
    const before = kitchen.events.length
    await assert.rejects(a.call('kitchen.setStatus', '999999', 'ready'))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(kitchen.events.length, before)

    // Another shop's changes never reach this shop's screens.
    await b.call('products.save', { name: 'Other shop item', price: 5 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(kitchen.events.some((e) => JSON.stringify(e.data).includes('Other shop item')), false)

    // Public screens: "menu changed" only — never orders, names or records.
    await a.call('products.save', { id: tea.id, name: 'Tea', price: 22, sendToKitchen: true })
    assert.ok(await pub.until(() => pub.events.some((e) => e.data.kind === 'menu')))
    assert.equal(pub.events.some((e) => e.data.records || e.data.name || e.data.kind === 'change'), false)

    // Reconnect: what was missed is sent again (only that); an unknown position → resync.
    const last = kitchen.events.filter((e) => e.id).at(-1)!.id
    kitchen.close()
    await a.call('kitchen.setStatus', (await a.call<{ id: string }[]>('kitchen.list'))[0].id, 'ready')
    const back = await openStream(http.url, '/stream', { ticket: t.ticket, device: 'kitchen-screen-1', since: last })
    assert.ok(await back.until(() => back.events.some((e) => e.data.name === 'kitchen.setStatus')))
    assert.equal(back.events.filter((e) => e.data.name === 'orders.save').length, 0, 'only the missed event')
    const lost = await openStream(http.url, '/stream', { ticket: t.ticket, since: 'deadbeef.3' })
    assert.ok(await lost.until(() => lost.events.some((e) => e.event === 'resync')))

    // Users / roles change → the shop's staff streams are closed and must reconnect with a new ticket.
    const roles = await a.call<{ id: string; name: string }[]>('roles.list')
    await a.call('users.save', { name: 'Ravi', phone: '9800000701', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    assert.ok(await back.until(() => back.ended), 'stream closed for re-check')
    assert.equal(pub.ended, false, 'public screens stay connected')
    for (const s of [own, back, lost, pub]) s.close()

    // No hub configured: no ticket (screens keep the change feed) and writes work as before.
    const sink = a.env.events
    a.env.events = null
    assert.equal((await a.call<{ url: string | null }>('events.ticket')).url, null)
    await a.call('products.save', { name: 'Coffee', price: 30 })
    a.env.events = sink
  } finally { http.close(); a.close(); b.close() }
})

test('hub rules: branch filter, rights, replay buffer, publish secret', async () => {
  const hub = new Hub()
  try {
    const client = (br: string[] | 'all', rec: boolean) => ({ res: {} as never, shop: 's1', ticket: { t: 'ev' as const, bid: 's1', uid: 'u', br, rec }, orderId: null, device: null, ip: '' })
    const ev: HubEvent = { kind: 'change', shop: 's1', branch: 'b2', name: 'orders.save', cid: 5, records: { orders: [{ id: 'o1' }] } }
    // Another branch: only the number, no data.
    assert.deepEqual(hub.view(client(['b1'], true), ev), { kind: 'change', skip: true, cid: 5 })
    assert.equal((hub.view(client(['b1', 'b2'], true), ev) as { records?: unknown }).records !== undefined, true)
    // No right to see orders: the action name only (the screen re-reads what it is allowed to read).
    assert.equal((hub.view(client('all', false), ev) as { records?: unknown }).records, undefined)
    // Public screens: their order only.
    const pubC = { res: {} as never, shop: 's1', ticket: null, orderId: 'o1', device: null, ip: '' }
    assert.deepEqual(hub.view(pubC, { kind: 'order', shop: 's1', branch: null, orderId: 'o1' }), { kind: 'order', orderId: 'o1' })
    assert.equal(hub.view(pubC, { kind: 'order', shop: 's1', branch: null, orderId: 'o2' }), null)
    assert.equal(hub.view(pubC, ev), null)
  } finally { hub.stop() }
  // Publishing needs the secret.
  process.env.EVENTS_SECRET = 'test-events-secret-123456'
  const h2 = new Hub()
  const http = serveHub(h2)
  try {
    const post = (secret: string) => fetch(`${http.url}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-events-secret': secret }, body: JSON.stringify({ events: [] }) })
    assert.equal((await post('wrong-secret-xxxxxxxxxx')).status, 403)
    assert.equal((await post('test-events-secret-123456')).status, 200)
  } finally { http.close(); h2.stop() }
})

test('fewer database reads: QR menu from the cache until it changes; sign-in check one cheap read; revoked access at once', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, qrOrdering: true, products: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
    const q = countQueries(s.env as never)
    const owner = s.ownerToken
    s.setToken(null)
    const m1 = await s.call<{ products: { name: string; price: number }[] }>('public.menu', s.businessId, null, null)
    const afterFirst = q.n
    const m2 = await s.call<{ products: unknown[] }>('public.menu', s.businessId, null, null)
    if (PER_SHOP) assert.equal(q.n, afterFirst, 'second scan: no database read')
    assert.equal(m2.products.length, m1.products.length)
    // A price change shows on the next scan.
    s.setToken(owner)
    await s.call('products.save', { id: tea.id, name: 'Tea', price: 25 })
    s.setToken(null)
    assert.equal((await s.call<{ products: { price: number }[] }>('public.menu', s.businessId, null, null)).products[0].price, 25)

    // Signed-in calls: the sign-in check is one row in the shop's database (practically free on Turso) — the same
    // small cost on every call, and never a paid cache request.
    s.setToken(owner)
    await s.call('roles.list')
    const n0 = q.n
    await s.call('auth.me')
    const one = q.n - n0
    await s.call('auth.me')
    if (PER_SHOP) assert.equal(q.n - n0 - one, one, 'each signed-in call costs the same small read')

    // Taking a user's login away still works at once (the cached value is replaced on every change).
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    const u = await s.call<{ id: string }>('users.save', { name: 'Ravi', phone: '9800000801', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const ravi = (await s.call<{ token: string }>('auth.login', '9800000801', 'ravi1234')).token
    s.setToken(ravi); await s.call('auth.me')
    s.setToken(owner)
    await s.call('users.save', { id: u.id, name: 'Ravi', phone: '9800000801', roleId: roles.find((r) => r.name === 'Cashier')!.id, active: false })
    s.setToken(ravi)
    await assert.rejects(s.call('auth.me'), /sign in again/)
  } finally { s.close() }
})

test('WhatsApp messages: only what the screen needs (kind / since / limit)', async () => {
  const s = await withShop()
  try {
    const all = await s.call<unknown[]>('whatsapp.messages', 50)
    assert.ok(Array.isArray(all))
    const offers = await s.call<{ kind: string }[]>('whatsapp.messages', { kind: 'offer', since: new Date(Date.now() - 86_400_000).toISOString(), limit: 10 })
    assert.ok(offers.every((m) => m.kind === 'offer'))
  } finally { s.close() }
})

test('no staff screen open: events skip reading the changed orders (fewer database reads); with one: records included', async () => {
  process.env.EVENTS_PUBLIC_URL = '/server/events'
  const s = await withShop()
  const hub = (s.env as { hub?: Hub }).hub!
  const http = serveHub(hub)
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true, products: true } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20, sendToKitchen: true })
    const line = { id: 'n1', productId: tea.id, name: '', variantId: null, variantName: null, addOns: [], qty: 1, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 }
    // A listener with a hand-made ticket (no events.ticket call → the shop has no "screens open" mark).
    const me = await s.call<{ user: { id: string } }>('auth.me')
    const quiet = await openStream(http.url, '/stream', { ticket: signToken({ t: 'ev', bid: s.businessId, uid: me.user.id, br: 'all', rec: true }, 600) })
    await quiet.until(() => quiet.events.some((e) => e.event === 'hello'))
    s.setDevice('counter-device-2')
    await s.call('orders.save', { type: 'takeaway', tableId: null, customerId: null, items: [line], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    assert.ok(await quiet.until(() => quiet.events.some((e) => e.data.name === 'orders.save')))
    assert.equal(quiet.events.find((e) => e.data.name === 'orders.save')!.data.records, undefined, 'no records read without open screens')
    // A real screen (asks for a ticket) → records come with the events.
    const t = await s.call<{ ticket: string }>('events.ticket')
    const screen = await openStream(http.url, '/stream', { ticket: t.ticket })
    await screen.until(() => screen.events.some((e) => e.event === 'hello'))
    await s.call('orders.save', { type: 'takeaway', tableId: null, customerId: null, items: [{ ...line, id: 'n2' }], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    assert.ok(await screen.until(() => screen.events.some((e) => e.data.name === 'orders.save' && !!e.data.records)))
    quiet.close(); screen.close()
  } finally { http.close(); s.close() }
})

