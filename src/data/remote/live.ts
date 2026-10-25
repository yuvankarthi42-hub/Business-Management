// Live updates for staff screens (Catalyst backend): one stream per tab from the event hub, instead of asking
// the server every 30 s whether anything changed.
//  • Off unless the server has a hub (events.ticket returns a url) — then everything works as before.
//  • Each event names the action another device finished; the same reads are refreshed as for this device's own
//    writes, except lists that take the changed orders / tickets in place (no extra server call).
//  • A gap in the change numbers, a reconnect or a "resync" → ONE catch-up read of the change feed (only what
//    was missed). While the stream is down for more than 20 s, the old 30 s change feed runs again.
//  • Sign-out, password change, removed access: the hub closes the stream; a new ticket is refused.
import { applyLive, invalidate, notify, setLiveBoost, setTtlScale } from './cache'
import { auth, deviceId, rpc } from './http'
import type { LiveRecords } from './livePatch'
import { invalidatesFor } from './policy'
import { catchUp, feedPosition, noteChangeId, setLive } from './sync'

interface Ticket { url: string | null; ticket: string | null; feed: boolean; ttl?: number }
interface LiveEvent { kind: 'change' | 'session'; name?: string; cid?: number | null; own?: boolean; skip?: boolean; records?: LiveRecords }

let started = false
let ctl: AbortController | null = null
let lastId: string | null = null
let feed = false
let backoff = 1000
let fallbackTimer: ReturnType<typeof setTimeout> | null = null
let forUser: string | null = null
let cached: { user: string; t: Ticket; until: number } | null = null

const resolveUrl = (u: string) => { try { return new URL(u, location.href).href.replace(/\/$/, '') } catch { return u } }

export function startLive() {
  if (started || typeof window === 'undefined') return
  started = true
  void connect()
  // Coming online again: reconnect at once instead of waiting for the backoff.
  window.addEventListener('online', () => { if (!ctl) { backoff = 1000; void connect() } })
}

/** Stops the stream (sign-out, support view ended). */
export function stopLive() { ctl?.abort(); ctl = null; lastId = null; forUser = null; cached = null; setLive(false); setLiveBoost(false); setTtlScale(1) }
/** Signed in (again, or as someone else): a fresh stream for this user. */
export function restartLive() { stopLive(); backoff = 1000; if (connecting) again = true; else if (started) void connect() }

function down() {
  ctl = null
  // Short blips don't switch the old feed back on; a longer outage does (until the stream is back).
  if (!fallbackTimer) fallbackTimer = setTimeout(() => { fallbackTimer = null; if (!ctl) { setLive(false); setLiveBoost(false) } }, 20_000)
}
function retry() {
  const wait = backoff
  backoff = Math.min(backoff * 2, 30_000)
  setTimeout(() => { if (!ctl && auth.user) void connect() }, wait + Math.random() * 500)
}

let connecting = false
let again = false // signed in again while a stream was being opened: open one for the new sign-in after it
/** One stream per tab, even when start-up and sign-in ask at the same moment (the guard covers opening only). */
async function connect() {
  if (connecting || ctl || !auth.user) return
  connecting = true
  let opened: { res: Response; c: AbortController } | null = null
  try { opened = await openStream() } finally { connecting = false }
  if (again) { again = false; if (opened) opened.c.abort(); ctl = null; void connect(); return }
  if (!opened) return
  const { res, c } = opened
  try { await read(res.body!, c) } catch { /* stream ended */ }
  if (ctl === c) { down(); retry() }
}

async function openStream(): Promise<{ res: Response; c: AbortController } | null> {
  const user = auth.user!
  if (forUser !== user) { forUser = user; lastId = null } // another sign-in: start fresh
  // Reconnects reuse the ticket while it is valid (no API call); a refused or expired one gets a new one.
  let t: Ticket
  if (cached && cached.user === user && Date.now() < cached.until) t = cached.t
  else {
    try { t = (await rpc<Ticket>('events.ticket', [], 'user')).data } catch { retry(); return null }
    cached = { user, t, until: Date.now() + Math.max(0, (t.ttl ?? 3600) - 120) * 1000 }
  }
  if (!t.url || !t.ticket) { setLive(false); return null } // no hub on this server: the change feed stays as it was
  if (auth.user !== user) return null
  feed = t.feed
  const c = new AbortController()
  ctl = c
  let res: Response
  try {
    res = await fetch(`${resolveUrl(t.url)}/stream`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ ticket: t.ticket, device: deviceId, since: lastId }), signal: c.signal, credentials: 'omit', cache: 'no-store' })
  } catch { if (ctl === c) { down(); retry() } return null }
  if (!res.ok || !res.body) {
    if (res.status === 401) { cached = null; if (ctl === c) { ctl = null; retry() } return null } // ticket refused: a fresh one next time (the API re-checks the user)
    if (ctl === c) { down(); retry() }
    return null
  }
  return { res, c }
}

async function read(body: ReadableStream<Uint8Array>, c: AbortController) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done || c.signal.aborted) return
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      let event = 'message', data = '', id: string | null = null
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
        else if (line.startsWith('id:')) id = line.slice(3).trim()
      }
      await handle(event, data, id, c)
    }
  }
}

async function handle(event: string, data: string, id: string | null, c: AbortController) {
  // Signed out or switched user in this tab: this stream is not theirs any more.
  if (auth.user !== forUser) { c.abort(); if (ctl === c) ctl = null; setLive(false); return }
  if (event === 'hello') {
    backoff = 1000
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null }
    setLive(true)
    // Events keep the order / kitchen / QR / table / payment reads correct: those are trusted for longer (cache.ts).
    setLiveBoost(true)
    // First start: the change feed only needs its starting position (one small read).
    if (feed && feedPosition() === null) await catchUp()
    return
  }
  if (event === 'resync') { await resync(); return }
  if (event === 'reauth') { c.abort(); ctl = null; cached = null; invalidate(['me']); notify(); backoff = 1000; void connect(); return }
  if (id) lastId = id
  let ev: LiveEvent
  try { ev = JSON.parse(data) } catch { return }
  if (ev.kind === 'session') { invalidate(['me']); notify(); return }
  if (ev.kind !== 'change') return
  // A missed event (hub hiccup): catch up once from the change feed, before taking this one.
  const pos = feedPosition()
  if (feed && typeof ev.cid === 'number' && pos !== null && ev.cid > pos + 1) await catchUp()
  if (typeof ev.cid === 'number') noteChangeId(ev.cid)
  if (ev.own || ev.skip || !ev.name) return
  applyLive(invalidatesFor(ev.name, []), ev.records)
  notify()
}

/** The hub can't fill the gap (restarted, or too long away): the feed once, or re-read everything once. */
async function resync() {
  if (feed && feedPosition() !== null) await catchUp()
  else { invalidate('all'); notify() }
}
