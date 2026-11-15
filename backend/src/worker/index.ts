// Cloudflare Worker entry (the Cloudflare setup). The same API as Catalyst: every request goes to http/core.ts.
// Only what is Cloudflare's own is here: reading the request, the WebSocket entry of the live-update hub, the hourly
// cron and the settings. The Catalyst setup (index.ts, cron.ts, catalystEnv.ts) does not use this file.
//
//   fetch      /rpc/…, /media/p/…, /health, /migrate, /schema-check, /ip-check  → http/core.ts
//              /live/ws      staff screens (WebSocket; the ticket as the 2nd sub-protocol, checked here first)
//              /live/public  QR menu, TV board, order tracking (WebSocket; shop / order only)
//   scheduled  hourly: one batch of the daily jobs (modules/admin/renewals.ts — a lease lets one run at a time,
//              each shop is marked done only after its work succeeded, a stopped run is finished by the next one;
//              reminders go once a day). A failed hour is simply picked up by the next hour.
import { Ctx } from '../core/context'
import { createHandler, type HttpResponse } from '../http/core'
import { assertAccount } from '../core/account'
import { verifyToken } from '../core/tokens'
import { validDevice, validPublic, validTicket } from '../events/hub'
import { runDailyBatch } from '../modules/admin/renewals'
import { cloudflareEnv } from './env'
import { LIVE_PROTOCOL, type SocketInfo } from './hub'
import type { ExecutionContextLike, ScheduledEventLike, WorkerEnv } from './types'

export { ShopHub } from './hub'

const MAX_BODY = 8 * 1024 * 1024 // as on Catalyst (express.json / express.text limit)

/** Text settings (wrangler vars and secrets) into process.env once, so the shared code reads them as on Catalyst. */
let booted = false
function boot(bindings: WorkerEnv) {
  if (booted) return
  for (const [k, v] of Object.entries(bindings)) if (typeof v === 'string' && process.env[k] === undefined) process.env[k] = v
  process.env.NODE_ENV ||= 'production' // unset or empty → production (never the development secrets)
  // A Worker is reached only through Cloudflare's edge: the visitor's address is CF-Connecting-IP (core/clientIp.ts).
  process.env.CLIENT_IP_SOURCE = 'worker'
  booted = true
}

const gzip = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())

// One handler per bindings object (Cloudflare hands the same one to every request of an isolate).
const cores = new WeakMap<WorkerEnv, ReturnType<typeof createHandler>>()
const handlerFor = (bindings: WorkerEnv) => {
  let core = cores.get(bindings)
  if (!core) { core = createHandler({ envFor: () => cloudflareEnv(bindings), gzip }); cores.set(bindings, core) }
  return core
}

const toResponse = (r: HttpResponse) => new Response(r.kind === 'empty' ? null : (r.body as BodyInit | null), { status: r.status, headers: r.headers })
const plain = (status: number, text: string, headers: Record<string, string> = {}) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers } })

/** The API's own address part (e.g. "/server/api", as the app calls it on Catalyst) is dropped. */
function apiPath(pathname: string): string {
  const prefix = String(process.env.API_PREFIX ?? '/server/api').replace(/\/$/, '')
  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) return pathname.slice(prefix.length) || '/'
  return pathname
}

/** The body as the Express host reads it: JSON, or text/plain holding JSON; over 8 MB refused. */
async function readBody(request: Request): Promise<{ body: unknown } | { error: Response }> {
  if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') return { body: {} }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return { error: plain(413, 'Payload too large') }
  const text = await request.text()
  if (text.length > MAX_BODY) return { error: plain(413, 'Payload too large') }
  const type = (request.headers.get('content-type') ?? '').toLowerCase()
  if (type.includes('application/json')) {
    if (!text) return { body: {} }
    try { return { body: JSON.parse(text) } } catch { return { error: plain(400, 'Bad request') } }
  }
  if (type.startsWith('text/plain')) { try { return { body: JSON.parse(text) } } catch { return { body: {} } } }
  return { body: {} }
}

/** A live-update connection: checked here (ticket signature, expiry, account), then handed to the shop's hub. */
async function live(request: Request, url: URL, path: string, bindings: WorkerEnv): Promise<Response> {
  if (!bindings.SHOP_HUB || !process.env.LIVE_URL) return plain(404, 'Not found')
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return plain(426, 'WebSocket only', { Upgrade: 'websocket' })
  // This server must belong to its database's account before it lets anyone listen (core/account.ts).
  await assertAccount(await cloudflareEnv(bindings).dbs.platform())
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (protocols[0] !== LIVE_PROTOCOL) return plain(400, 'Bad request')
  let info: SocketInfo
  if (path === '/live/ws') {
    const claims = verifyToken<Record<string, unknown>>(protocols[1] ?? '')
    // Missing, changed, expired or another account's ticket: refused before any hub is reached (the app asks again).
    if (!validTicket(claims)) return plain(401, 'Unauthorized')
    info = { shop: String(claims.bid), ticket: claims, orderId: null, device: validDevice(url.searchParams.get('device')) }
  } else if (path === '/live/public') {
    const shop = url.searchParams.get('shop'), order = url.searchParams.get('order')
    if (!validPublic(shop, order)) return plain(400, 'Bad request')
    info = { shop: String(shop), ticket: null, orderId: order || null, device: null }
  } else return plain(404, 'Not found')
  const since = url.searchParams.get('since')
  const to = new Request(`https://hub/connect${since ? `?since=${encodeURIComponent(since)}` : ''}`, { headers: { upgrade: 'websocket', 'x-hub-listener': JSON.stringify(info) } })
  return bindings.SHOP_HUB.get(bindings.SHOP_HUB.idFromName(info.shop)).fetch(to)
}

export default {
  async fetch(request: Request, bindings: WorkerEnv): Promise<Response> {
    boot(bindings)
    try {
      const url = new URL(request.url)
      const path = apiPath(url.pathname)
      if (path.startsWith('/live/')) return await live(request, url, path, bindings)
      const read = await readBody(request)
      if ('error' in read) return read.error
      const r = await handlerFor(bindings).handle({
        method: request.method, path, query: Object.fromEntries(url.searchParams), header: (n) => request.headers.get(n) ?? undefined,
        body: read.body, peer: null, raw: request,
      })
      return r ? toResponse(r) : plain(404, 'Not found')
    } catch (e) {
      console.error('[worker]', e)
      return new Response(JSON.stringify({ error: { message: 'Something went wrong on the server. Please try again.', code: 'SERVER_ERROR' } }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })
    }
  },

  async scheduled(_event: ScheduledEventLike, bindings: WorkerEnv, ctx: ExecutionContextLike) {
    boot(bindings)
    ctx.waitUntil(runCron(bindings))
  },
}

/** One hourly run. Overlapping or repeated runs are safe: runDailyBatch takes a lease and skips work already done. */
export async function runCron(bindings: WorkerEnv) {
  try {
    const env = cloudflareEnv(bindings)
    const platform = await env.dbs.platform()
    await assertAccount(platform)
    const r = await runDailyBatch(new Ctx(env, platform, null))
    console.log(`Daily jobs batch: ${JSON.stringify(r)}`)
    return r
  } catch (e) {
    // Nothing half-done is lost: the shops of this batch stay "not done" and the next hour's run takes them.
    console.error('Daily jobs batch failed (the next hourly run continues it)', e)
    return null
  }
}
