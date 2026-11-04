// Live-update hub: forwards the API's events to the open screens allowed to see them. It knows nothing about the
// connection (WebSocket on Cloudflare, an in-memory list in the tests) and never touches a database:
//   • staff screens connect with a short ticket signed by the API (events.ticket) — shop, user, branches, rights;
//   • public screens (QR menu, TV board, order tracking) get only "menu changed" and "this order changed".
// Each shop keeps its last 300 events, so a screen that reconnects gets what it missed; older gaps → "resync"
// (the screen then asks the change feed once).
// Catalyst has no hub: screens use the change feed (sync.changes) there.

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
export interface Ticket { t: 'ev'; bid: string; uid: string; br: string[] | 'all'; rec: boolean; exp?: number }

/** One message to a screen: `event` (hello / resync / reauth / message), its position `id`, and `data`. */
export interface HubMessage { event: 'hello' | 'resync' | 'reauth' | 'message'; id?: string; data: Record<string, unknown> }

/** One open screen, as the connection hands it to the hub. */
export interface Listener {
  shop: string
  /** Staff: the ticket. Public: null. */
  ticket: Ticket | null
  /** Public: the order this screen follows (or null for menu / TV). */
  orderId: string | null
  /** Staff: the tab's device id (its own changes aren't sent back). */
  device: string | null
  /** Sends one message over this screen's connection. */
  send(m: HubMessage): void
  /** Ends this screen's connection (it reconnects and, for staff, asks for a new ticket). */
  close(): void
}

const RING = 300
const ID = /^[A-Za-z0-9_-]{1,40}$/
const newBoot = () => Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

/** The event as this screen may see it, or null when it isn't for this screen. */
export function viewFor(l: Pick<Listener, 'ticket' | 'orderId' | 'device'>, ev: HubEvent): Record<string, unknown> | null {
  if (!l.ticket) {
    if (ev.kind === 'menu') return { kind: 'menu' }
    if (ev.kind === 'order' && l.orderId && ev.orderId === l.orderId) return { kind: 'order', orderId: ev.orderId }
    return null
  }
  if (ev.kind === 'order' || ev.kind === 'menu') return null
  if (ev.kind === 'session') return { kind: 'session' }
  const t = l.ticket
  // Another branch: only the row number (no data), so this screen's sequence has no false gap.
  if (ev.branch && t.br !== 'all' && !t.br.includes(ev.branch)) return { kind: 'change', skip: true, cid: ev.cid ?? null }
  if (ev.origin && l.device && ev.origin === l.device) return { kind: 'change', own: true, cid: ev.cid ?? null }
  return { kind: 'change', name: ev.name, branch: ev.branch, cid: ev.cid ?? null, ...(t.rec && ev.records ? { records: ev.records } : {}) }
}

/** A staff ticket is a signed 'ev' token for one shop; a public screen names a shop (and maybe one order). */
export const validTicket = (t: Record<string, unknown> | null): t is Ticket & Record<string, unknown> => !!t && t.t === 'ev' && ID.test(String(t.bid))
export const validPublic = (shop: unknown, order: unknown) => ID.test(String(shop ?? '')) && (order == null || ID.test(String(order)))
export const validDevice = (d: unknown) => (ID.test(String(d ?? '')) ? String(d) : null)

export class Hub {
  private listeners = new Set<Listener>()
  private seq = new Map<string, number>()
  private ring = new Map<string, { seq: number; ev: HubEvent }[]>()
  readonly boot: string

  constructor(boot = newBoot()) { this.boot = boot }
  get size() { return this.listeners.size }

  publish(list: HubEvent[], now = Date.now()) {
    for (const ev of list) {
      if (!ev || typeof ev.shop !== 'string' || !ev.shop) continue
      const n = (this.seq.get(ev.shop) ?? 0) + 1
      this.seq.set(ev.shop, n)
      const ring = this.ring.get(ev.shop) ?? []
      ring.push({ seq: n, ev })
      if (ring.length > RING) ring.splice(0, ring.length - RING)
      this.ring.set(ev.shop, ring)
      for (const l of [...this.listeners]) {
        if (l.shop !== ev.shop) continue
        // A staff ticket that ran out: this screen asks the API for a new one (the user is checked again).
        if (l.ticket?.exp && l.ticket.exp * 1000 <= now) { this.reauth(l); continue }
        this.send(l, n, ev)
      }
      // Access changed: staff screens of that shop reconnect with a fresh ticket (the API re-checks the user).
      if (ev.kind === 'session') for (const l of [...this.listeners]) if (l.shop === ev.shop && l.ticket) this.reauth(l)
    }
  }

  /** A screen connected. `since` = the last "<boot>.<seq>" it got: what it missed is sent first. */
  add(l: Listener, since: string | null) {
    this.listeners.add(l)
    l.send({ event: 'hello', data: { boot: this.boot, seq: this.seq.get(l.shop) ?? 0 } })
    // Catch up: only what this screen missed, if we still have it; otherwise ask it to resync once.
    const m = /^([0-9a-f]+)\.(\d+)$/.exec(since ?? '')
    if (m) {
      const last = Number(m[2])
      const ring = this.ring.get(l.shop) ?? []
      const first = ring[0]?.seq ?? (this.seq.get(l.shop) ?? 0) + 1
      if (m[1] !== this.boot || last + 1 < first) l.send({ event: 'resync', data: {} })
      else for (const x of ring) if (x.seq > last) this.send(l, x.seq, x.ev)
    }
  }
  /** A screen's connection ended. */
  remove(l: Listener) { this.listeners.delete(l) }

  private reauth(l: Listener) {
    try { l.send({ event: 'reauth', data: {} }) } catch { /* gone */ }
    this.listeners.delete(l)
    try { l.close() } catch { /* gone */ }
  }
  private send(l: Listener, seq: number, ev: HubEvent) {
    const v = viewFor(l, ev)
    if (!v) return
    try { l.send({ event: 'message', id: `${this.boot}.${seq}`, data: v }) } catch { this.listeners.delete(l) }
  }
}
