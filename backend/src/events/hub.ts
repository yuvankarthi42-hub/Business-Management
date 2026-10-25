// Event hub: keeps one live stream (Server-Sent Events) per open screen and forwards the API's events to the
// screens allowed to see them. It never touches a database:
//   • staff screens connect with a short ticket signed by the API (events.ticket) — shop, user, branches, rights;
//   • public screens (QR menu, TV board, order tracking) get only "menu changed" and "this order changed";
//   • the API posts events here after a write is saved (POST /publish with EVENTS_SECRET).
// Each shop keeps its last 300 events, so a screen that reconnects gets what it missed; older gaps → "resync"
// (the screen then asks the change feed once). Runs as ONE instance (Catalyst AppSail, min = max = 1 instance).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Response, Router } from 'express'
import express from 'express'
import { verifyToken } from '../core/tokens'

/** What the API publishes. */
export interface HubEvent {
  shop: string
  /** Branch the change belongs to (null = the whole shop, e.g. settings). */
  branch: string | null
  /** 'change' (an action finished), 'session' (users / roles / settings changed), 'menu', 'order' (customer view). */
  kind: 'change' | 'session' | 'menu' | 'order'
  /** The action name for 'change' (orders.checkout…), so the screen refreshes exactly what it refreshes today. */
  name?: string
  /** The tab that made the change (it already has the result). */
  origin?: string | null
  /** The changed records, so lists update without asking the server again (staff screens with the right to see them). */
  records?: { orders?: unknown[]; kots?: unknown[] }
  /** 'order' events: which order (public screens follow one order). */
  orderId?: string
  /** The change feed row (one database per shop): a screen that sees a gap asks the change feed once. */
  cid?: number | null
}

/** The ticket the API signs for a staff screen. */
export interface Ticket { t: 'ev'; bid: string; uid: string; br: string[] | 'all'; rec: boolean }

interface Client {
  res: Response
  shop: string
  /** Staff: the ticket. Public: null. */
  ticket: Ticket | null
  /** Public: the order this screen follows (or null for menu / TV). */
  orderId: string | null
  /** Staff: the tab's device id (its own changes aren't sent back). */
  device: string | null
  ip: string
}

const RING = 300
const BOOT = randomBytes(6).toString('hex')

export class Hub {
  private clients = new Set<Client>()
  private seq = new Map<string, number>()
  private ring = new Map<string, { seq: number; ev: HubEvent }[]>()
  readonly boot = BOOT
  private beat: NodeJS.Timeout | null = null

  constructor(private maxPerIp = 30) {
    // Keeps idle connections open through proxies (a comment line; no data, no database).
    this.beat = setInterval(() => { for (const c of this.clients) this.write(c, ': ping\n\n') }, 25_000)
    this.beat.unref?.()
  }
  stop() { if (this.beat) clearInterval(this.beat); for (const c of this.clients) c.res.end(); this.clients.clear() }
  get size() { return this.clients.size }

  publish(list: HubEvent[]) {
    for (const ev of list) {
      if (!ev || typeof ev.shop !== 'string' || !ev.shop) continue
      const n = (this.seq.get(ev.shop) ?? 0) + 1
      this.seq.set(ev.shop, n)
      const ring = this.ring.get(ev.shop) ?? []
      ring.push({ seq: n, ev })
      if (ring.length > RING) ring.splice(0, ring.length - RING)
      this.ring.set(ev.shop, ring)
      for (const c of this.clients) if (c.shop === ev.shop) this.send(c, n, ev)
      // Access changed: staff screens of that shop reconnect with a fresh ticket (the API re-checks the user).
      if (ev.kind === 'session') for (const c of [...this.clients]) if (c.shop === ev.shop && c.ticket) { this.write(c, `event: reauth\ndata: {}\n\n`); c.res.end(); this.clients.delete(c) }
    }
  }

  /** The event as this screen may see it, or null when it isn't for this screen. */
  view(c: Client, ev: HubEvent): Record<string, unknown> | null {
    if (!c.ticket) {
      if (ev.kind === 'menu') return { kind: 'menu' }
      if (ev.kind === 'order' && c.orderId && ev.orderId === c.orderId) return { kind: 'order', orderId: ev.orderId }
      return null
    }
    if (ev.kind === 'order' || ev.kind === 'menu') return null
    if (ev.kind === 'session') return { kind: 'session' }
    const t = c.ticket
    // Another branch: only the row number (no data), so this screen's sequence has no false gap.
    if (ev.branch && t.br !== 'all' && !t.br.includes(ev.branch)) return { kind: 'change', skip: true, cid: ev.cid ?? null }
    if (ev.origin && c.device && ev.origin === c.device) return { kind: 'change', own: true, cid: ev.cid ?? null }
    return { kind: 'change', name: ev.name, branch: ev.branch, cid: ev.cid ?? null, ...(t.rec && ev.records ? { records: ev.records } : {}) }
  }

  private send(c: Client, seq: number, ev: HubEvent) {
    const v = this.view(c, ev)
    if (v) this.write(c, `id: ${this.boot}.${seq}\ndata: ${JSON.stringify(v)}\n\n`)
  }
  private write(c: Client, s: string) { try { c.res.write(s) } catch { this.clients.delete(c) } }

  /** Opens a stream. `since` = the last "<boot>.<seq>" this screen got: missed events are sent first. */
  open(res: Response, opts: { shop: string; ticket: Ticket | null; orderId: string | null; device: string | null; since: string | null; ip: string }) {
    const sameIp = [...this.clients].filter((x) => x.ip === opts.ip).length
    if (sameIp >= this.maxPerIp) { res.status(429).json({ error: { message: 'Too many connections', code: 'RATE_LIMITED' } }); return }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const c: Client = { res, shop: opts.shop, ticket: opts.ticket, orderId: opts.orderId, device: opts.device, ip: opts.ip }
    this.clients.add(c)
    // A staff ticket expires: end the stream, so the screen gets a new one (the API checks the user again).
    const exp = opts.ticket ? Number((opts.ticket as Ticket & { exp?: number }).exp ?? 0) * 1000 - Date.now() : 0
    const timer = exp > 0 ? setTimeout(() => { this.write(c, `event: reauth\ndata: {}\n\n`); c.res.end(); this.clients.delete(c) }, Math.min(exp, 2 ** 31 - 1)) : null
    timer?.unref?.()
    res.on('close', () => { if (timer) clearTimeout(timer); this.clients.delete(c) })
    this.write(c, `retry: 3000\nevent: hello\ndata: ${JSON.stringify({ boot: this.boot, seq: this.seq.get(opts.shop) ?? 0 })}\n\n`)
    // Catch up: only what this screen missed, if we still have it; otherwise ask it to resync once.
    const m = /^([0-9a-f]+)\.(\d+)$/.exec(opts.since ?? '')
    if (m) {
      const last = Number(m[2])
      const ring = this.ring.get(opts.shop) ?? []
      const first = ring[0]?.seq ?? (this.seq.get(opts.shop) ?? 0) + 1
      if (m[1] !== this.boot || last + 1 < first) this.write(c, `event: resync\ndata: {}\n\n`)
      else for (const x of ring) if (x.seq > last) this.send(c, x.seq, x.ev)
    }
  }
}

const ID = /^[A-Za-z0-9_-]{1,40}$/

/** The hub's HTTP routes: POST /stream (staff, ticket in the body), POST /public, POST /publish (API only). */
export function hubRoutes(hub: Hub): Router {
  const r = express.Router()
  r.use(express.json({ limit: '2mb' }))
  // Cross-site "simple" requests (text/plain) so browsers send them without a CORS pre-check.
  r.use(express.text({ type: 'text/plain', limit: '64kb' }))
  r.use((req, res, next) => {
    if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body) } catch { req.body = {} } }
    const o = req.header('origin')
    const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
    if (o && allowed.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin') }
    next()
  })
  r.get('/health', (_req, res) => { res.json({ ok: true, boot: hub.boot, clients: hub.size }) })
  r.post('/stream', (req, res) => {
    const b = req.body ?? {}
    const t = verifyToken<Ticket & Record<string, unknown>>(String(b.ticket ?? ''))
    if (!t || t.t !== 'ev' || !ID.test(String(t.bid))) { res.status(401).json({ error: { message: 'Please sign in again', code: 'UNAUTHORIZED' } }); return }
    hub.open(res, { shop: String(t.bid), ticket: t, orderId: null, device: ID.test(String(b.device ?? '')) ? String(b.device) : null, since: typeof b.since === 'string' ? b.since : null, ip: req.ip ?? '' })
  })
  r.post('/public', (req, res) => {
    const b = req.body ?? {}
    if (!ID.test(String(b.shop ?? '')) || (b.order != null && !ID.test(String(b.order)))) { res.status(400).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); return }
    hub.open(res, { shop: String(b.shop), ticket: null, orderId: b.order ? String(b.order) : null, device: null, since: typeof b.since === 'string' ? b.since : null, ip: req.ip ?? '' })
  })
  r.post('/publish', (req, res) => {
    const want = process.env.EVENTS_SECRET ?? ''
    const got = req.header('x-events-secret') ?? ''
    if (want.length < 16 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) { res.status(403).json({ error: { message: 'Not allowed', code: 'FORBIDDEN' } }); return }
    hub.publish(Array.isArray(req.body?.events) ? req.body.events : [])
    res.json({ ok: true })
  })
  return r
}
