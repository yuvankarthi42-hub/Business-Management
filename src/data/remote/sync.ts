// Change feed: shows other devices' changes without re-reading everything on a timer.
// With the event hub (live.ts) connected it doesn't run on a timer at all — only to catch up after a gap.
// Every ~30 s — only while this tab is on screen and someone used it in the last 5 minutes — asks the server
// what changed since the last time, and drops just the cached reads those changes affect (the same rules
// as for this device's own writes, policy.ts). Nothing is stored in the browser.
import { invalidate, notify, setTtlScale } from './cache'
import { auth, rpc } from './http'
import { invalidatesFor } from './policy'
import { feedInterval } from './feedTiming'
import { startLive } from './live'

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
/** The app's route: "#/kitchen" (Slate) or "/kitchen" (under the app's base path). */
const currentPath = () => (typeof location === 'undefined' ? '' : location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname.slice(BASE.length) || '/')
const intervalNow = () => feedInterval(currentPath())
const IDLE_AFTER = 5 * 60_000

interface Feed { supported: boolean; latest?: number; changes?: string[]; reset?: boolean; epoch?: string | null }

let since: number | null = null // null = not started: the first answer only gives the newest id
let epoch: string | null = null
let token: string | null = null
let lastPoll = 0
let lastUse = Date.now()
let running = false
let off = false

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

async function poll() {
  const t = auth.user
  if (!t || off) return
  if (t !== token) { token = t; since = null; epoch = null } // signed in again (or as someone else)
  running = true
  try {
    const { data } = await rpc<Feed>('sync.changes', [since], 'user')
    if (!data.supported) { off = true; setTtlScale(1); return }
    setTtlScale(4)
    let tags: string[] = []
    if (data.reset) tags = ['all']
    else for (const name of data.changes ?? []) tags.push(...invalidatesFor(name))
    if (since !== null && epoch !== null && data.epoch && data.epoch !== epoch) tags.push('me') // subscription, users, settings…
    since = data.latest ?? since
    epoch = data.epoch ?? epoch
    if (tags.length) { invalidate(tags.includes('all') ? 'all' : [...new Set(tags)]); notify() }
  } catch {
    setTtlScale(1) // offline or signed out: fall back to the normal times
  } finally { running = false; lastPoll = Date.now() }
}

// ---- Live updates (live.ts) ----
// While the event hub stream is connected, this feed does not run on a timer: it is asked once only when the
// stream reports a gap (a missed event), after a reconnect, or when the hub asks for a resync.
let live = false
export function setLive(on: boolean) { live = on; if (!on) lastUse = Date.now() }
/** Change ids seen in live events keep the feed position current, so a catch-up returns only what was missed. */
export function noteChangeId(id: number) { if (since !== null && id > since) since = id }
export const feedPosition = () => since
/** The start-up call already told us where the feed is: no separate first read. */
export function setFeedStart(f: { supported?: boolean; latest?: number; epoch?: string | null } | null | undefined) {
  if (!f) return
  if (f.supported === false) { off = true; return }
  if (since === null && typeof f.latest === 'number') { since = f.latest; epoch = f.epoch ?? epoch; token = auth.user; setTtlScale(4) }
}
/** One catch-up read (never two at once). */
export async function catchUp() { if (!running) await poll() }

let started = false
export function startSync() {
  if (started || typeof window === 'undefined') return
  started = true
  startLive()
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, () => { lastUse = Date.now() }, { passive: true })
  // Coming back to the tab: catch up at once.
  document.addEventListener('visibilitychange', () => { if (!live && visible() && Date.now() - lastPoll > 5000) { lastUse = Date.now(); void poll() } })
  setInterval(() => {
    if (live || running || off || !visible() || Date.now() - lastUse > IDLE_AFTER) return
    if (Date.now() - lastPoll >= intervalNow()) void poll()
  }, 5000)
}
