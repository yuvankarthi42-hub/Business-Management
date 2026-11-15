// The Cloudflare setup (src/worker): the same API answers as on Catalyst (Express), its R2 private files, the
// visitor-address rule, the live-update hub (WebSocket entry, Durable Object, hibernation) and the hourly cron.
// Runs in Node with stand-ins for Cloudflare's bindings; the real runtime is checked with `wrangler dev`.
process.env.NODE_ENV = 'test'
process.env.SETUP_KEY = 'test-setup-key-1234567890'
process.env.LIVE_URL = 'wss://api.test/server/api/live'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import worker, { runCron, ShopHub } from '../src/worker/index'
import { useEnvForTests, HubSink } from '../src/worker/env'
import { R2Files } from '../src/worker/r2Files'
import { mediaLink } from '../src/core/media'
import { signToken } from '../src/core/tokens'
import type { HubSocket, R2BucketLike, WorkerEnv } from '../src/worker/types'

class FakeBucket implements R2BucketLike {
  data = new Map<string, Uint8Array>()
  async put(key: string, body: ArrayBuffer | ArrayBufferView | string) { this.data.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(ArrayBuffer.isView(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body)) }
  async get(key: string) { const b = this.data.get(key); return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer } : null }
  async delete(key: string) { this.data.delete(key) }
}

/** A Durable Object namespace whose stub records what the Worker sent it. */
function fakeHubNs() {
  const sent: { name: string; url: string; headers: Record<string, string>; body: string | null }[] = []
  return {
    sent,
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (input: string | Request, init?: RequestInit) => {
        const r = typeof input === 'string' ? new Request(input, init) : input
        sent.push({ name: String(id), url: r.url, headers: Object.fromEntries([...(r.headers as unknown as Iterable<[string, string]>)]), body: r.method === 'POST' ? await r.text() : null })
        return new Response(null, { status: 204 })
      },
    }),
  }
}

const call = (bindings: WorkerEnv, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  worker.fetch(new Request(`https://api.test/server/api${path}`, init), bindings)
const rpc = async (bindings: WorkerEnv, name: string, args: unknown[], headers: Record<string, string> = {}) => {
  const r = await call(bindings, `/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ args }) })
  return { status: r.status, type: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options'), body: await r.json() as { data?: unknown; error?: { code: string } } }
}

test('Worker: the same answers as the Express host (health, sign-in, reads, writes, errors, text/plain bodies)', async () => {
  const s = await withShop()
  try {
    const bindings: WorkerEnv = {}
    useEnvForTests(bindings, s.env)
    const health = await call(bindings, '/health')
    assert.equal(health.status, 200)
    assert.equal((await health.json() as { ok: boolean }).ok, true)
    // Signed-in read: identical data through both hosts.
    const auth = { authorization: `Bearer ${s.ownerToken}` }
    const viaWorker = await rpc(bindings, 'categories.list', [], auth)
    assert.equal(viaWorker.status, 200); assert.equal(viaWorker.type, 'application/json; charset=utf-8'); assert.equal(viaWorker.nosniff, 'nosniff')
    assert.deepEqual(viaWorker.body.data, await s.call('categories.list'))
    // A write through the Worker is seen through Express.
    const saved = await rpc(bindings, 'customers.save', [{ name: 'Worker Ravi', phone: '9876500011' }], auth)
    assert.equal(saved.status, 200)
    assert.ok((await s.call<{ name: string }[]>('customers.search', 'Worker')).some((c) => c.name === 'Worker Ravi'))
    // Errors keep their status and code.
    assert.equal((await rpc(bindings, 'categories.list', [])).status, 401)
    assert.equal((await rpc(bindings, 'nope.nothing', [])).body.error?.code, 'NOT_FOUND')
    // "Simple" cross-site request: text/plain JSON with the headers inside.
    const r = await call(bindings, '/rpc/categories.list', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ args: [], h: auth }) })
    assert.equal(r.status, 200)
    // Bad JSON → 400; over 8 MB → 413; an unknown address → 404.
    assert.equal((await call(bindings, '/rpc/categories.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400)
    assert.equal((await call(bindings, '/rpc/categories.list', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024) }, body: '{}' })).status, 413)
    assert.equal((await call(bindings, '/nothing-here')).status, 404)
  } finally { s.close() }
})

test('Worker: the visitor address is CF-Connecting-IP only (X-Forwarded-For can’t be chosen by the visitor)', async () => {
  const s = await withShop()
  try {
    const bindings: WorkerEnv = {}
    useEnvForTests(bindings, s.env)
    const r = await call(bindings, '/ip-check', { headers: { 'x-setup-key': 'test-setup-key-1234567890', 'cf-connecting-ip': '49.204.10.20', 'x-forwarded-for': '1.1.1.1' } })
    const d = (await r.json() as { data: { ip: string; via: string } }).data
    assert.equal(d.ip, '49.204.10.20'); assert.equal(d.via, 'cf-connecting-ip')
    assert.equal((await call(bindings, '/ip-check', { headers: { 'cf-connecting-ip': '49.204.10.20' } })).status, 403, 'setup key needed')
  } finally { s.close() }
})

test('R2: private files only through a valid signed link; never public; refused without the private bucket', async () => {
  const pub = new FakeBucket(), priv = new FakeBucket()
  const files = new R2Files(pub, 'https://media.test', priv)
  await files.putPrivate('p/support/1/shot.webp', Buffer.from('secret-bytes'), 'image/webp')
  assert.equal(pub.data.size, 0, 'nothing in the public bucket')
  assert.equal(files.url('x/y.webp'), 'https://media.test/x/y.webp')
  const s = await withShop()
  try {
    const bindings: WorkerEnv = {}
    useEnvForTests(bindings, { ...s.env, files })
    const link = mediaLink('p/support/1/shot.webp')
    const ok = await call(bindings, `/${link}`)
    assert.equal(ok.status, 200); assert.equal(await ok.text(), 'secret-bytes'); assert.equal(ok.headers.get('cache-control'), 'private, max-age=1800')
    // Expired (signed for a time already past), changed signature, another key: the same 404, not cached.
    const old = mediaLink('p/support/1/shot.webp', Date.now() - 3 * 3600_000)
    for (const bad of [old, link.replace(/s=[^&]+/, 's=AAAAAAAAAAAAAAAAAAAAAA'), link.replace('shot', 'other')]) {
      const r = await call(bindings, `/${bad}`)
      assert.equal(r.status, 404, bad); assert.equal(r.headers.get('cache-control'), 'no-store')
    }
  } finally { s.close() }
  await assert.rejects(new R2Files(pub, 'https://media.test', null).putPrivate('p/a/b.webp', Buffer.from('x'), 'image/webp'), /Private file storage is not set up/)
})

test('Live hub entry: ticket checked before any hub is reached; staff and public screens go to their shop’s hub', async () => {
  const s = await withShop()
  try {
    const ns = fakeHubNs()
    const bindings: WorkerEnv = { SHOP_HUB: ns }
    useEnvForTests(bindings, s.env)
    const ws = (path: string, protocol: string) => call(bindings, path, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocol } })
    assert.equal((await call(bindings, '/live/ws')).status, 426, 'WebSocket only')
    assert.equal((await ws('/live/ws', 'other')).status, 400)
    assert.equal((await ws('/live/ws', 'kk-live, not-a-ticket')).status, 401)
    assert.equal((await ws('/live/ws', `kk-live, ${s.ownerToken}`)).status, 401, 'a sign-in token is not a live ticket')
    const ticket = signToken({ t: 'ev', bid: s.businessId, uid: '1', br: 'all', rec: true }, 3600)
    await ws('/live/ws?device=tab_123456&since=abc.4', `kk-live, ${ticket}`)
    const sent = ns.sent.at(-1)!
    assert.equal(sent.name, s.businessId); assert.match(sent.url, /\/connect\?since=abc\.4$/)
    const info = JSON.parse(sent.headers['x-hub-listener'])
    assert.equal(info.shop, s.businessId); assert.equal(info.device, 'tab_123456'); assert.equal(info.ticket.t, 'ev')
    assert.ok(!sent.url.includes(ticket), 'the ticket never goes in an address')
    await ws(`/live/public?shop=${s.businessId}&order=42`, 'kk-live')
    assert.deepEqual({ ...JSON.parse(ns.sent.at(-1)!.headers['x-hub-listener']), ticket: null }, { shop: s.businessId, ticket: null, orderId: '42', device: null })
    assert.equal((await ws('/live/public?shop=bad%20id', 'kk-live')).status, 400)
    // Events from a saved write go to that shop's hub only.
    await new HubSink(ns).publish([{ kind: 'menu', shop: 'a1', branch: null }, { kind: 'menu', shop: 'b2', branch: null }, { kind: 'change', shop: 'a1', branch: null, name: 'orders.checkout' }])
    const pubs = ns.sent.filter((x) => x.url.endsWith('/publish'))
    assert.deepEqual(pubs.map((x) => [x.name, (JSON.parse(x.body!) as unknown[]).length]).sort(), [['a1', 2], ['b2', 1]])
  } finally { s.close() }
})

test('Hub (Durable Object): sends what each screen may see, survives hibernation, closes an expired ticket', async () => {
  class Sock implements HubSocket {
    out: string[] = []; closed: number | null = null; att: unknown = null
    send(m: string) { if (this.closed !== null) throw new Error('closed'); this.out.push(m) }
    close(code?: number) { this.closed = code ?? 1000 }
    serializeAttachment(v: unknown) { this.att = structuredClone(v) }
    deserializeAttachment() { return this.att }
  }
  const sockets: Sock[] = []
  const state = { acceptWebSocket: (ws: HubSocket) => { sockets.push(ws as Sock) }, getWebSockets: () => sockets.filter((x) => x.closed === null) }
  ;(globalThis as Record<string, unknown>).WebSocketPair = class { 0 = {} as WebSocket; 1 = new Sock() }
  const RealResponse = globalThis.Response
  // Node's Response can't carry status 101: stand in for the runtime's.
  ;(globalThis as Record<string, unknown>).Response = class extends RealResponse { constructor(b: BodyInit | null, init?: ResponseInit) { super(b, init?.status === 101 ? { ...init, status: 200 } : init) } }
  try {
    const connect = (hub: ShopHub, info: object) => hub.fetch(new Request('https://hub/connect', { headers: { upgrade: 'websocket', 'x-hub-listener': JSON.stringify(info) } }))
    const publish = (hub: ShopHub, list: object[]) => hub.fetch(new Request('https://hub/publish', { method: 'POST', body: JSON.stringify(list) }))
    const hub = new ShopHub(state, {})
    await connect(hub, { shop: 's1', ticket: { t: 'ev', bid: 's1', uid: '1', br: ['b1'], rec: false }, orderId: null, device: 'tab_a' })
    await connect(hub, { shop: 's1', ticket: null, orderId: '9', device: null })
    const [staff, pub] = sockets
    assert.equal(JSON.parse(staff.out[0]).event, 'hello')
    await publish(hub, [{ kind: 'change', shop: 's1', branch: 'b1', name: 'orders.checkout', cid: 5 }, { kind: 'change', shop: 's1', branch: 'b2', name: 'orders.checkout', cid: 6 }, { kind: 'order', shop: 's1', branch: null, orderId: '9' }])
    const staffMsgs = staff.out.slice(1).map((m) => JSON.parse(m).data)
    assert.deepEqual(staffMsgs.map((d) => d.name ?? (d.skip ? 'skip' : '?')), ['orders.checkout', 'skip'], 'another branch: only its number')
    assert.deepEqual(pub.out.slice(1).map((m) => JSON.parse(m).data), [{ kind: 'order', orderId: '9' }], 'public screen: only its order, no data')
    // Woken after hibernation: a new object, the same open sockets — they still get events.
    const woken = new ShopHub(state, {})
    await publish(woken, [{ kind: 'change', shop: 's1', branch: 'b1', name: 'products.save', cid: 7 }])
    assert.equal(JSON.parse(staff.out.at(-1)!).data.name, 'products.save')
    // An expired ticket: the screen is told to get a new one and the socket is closed.
    await connect(woken, { shop: 's1', ticket: { t: 'ev', bid: 's1', uid: '2', br: 'all', rec: false, exp: 1 }, orderId: null, device: null })
    await publish(woken, [{ kind: 'change', shop: 's1', branch: 'b1', name: 'x', cid: 8 }])
    const expired = sockets[2]
    assert.equal(JSON.parse(expired.out.at(-1)!).event, 'reauth'); assert.equal(expired.closed, 4401)
    woken.webSocketMessage(staff, 'ping'); assert.equal(staff.out.at(-1), 'pong')
  } finally { (globalThis as Record<string, unknown>).Response = RealResponse }
})

test('Cron: overlapping hourly runs do the work once (the lease); a repeat run the same day does nothing more', async () => {
  const s = await withShop()
  try {
    const bindings: WorkerEnv = {}
    useEnvForTests(bindings, s.env)
    const [a, b] = await Promise.all([runCron(bindings), runCron(bindings)])
    assert.ok(a && b)
    assert.equal([a, b].filter((r) => r!.busy).length >= 1 || (a!.shops + b!.shops) <= 1, true, 'never both working on the same shops')
    const again = await runCron(bindings)
    assert.equal(again!.shops, 0, 'today’s round is done: nothing repeated')
  } finally { s.close() }
})
