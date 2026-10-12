// Change feed: shows other devices' changes without re-reading everything on a timer.
// Every ~30 s — only while this tab is on screen and someone used it in the last 5 minutes — asks the server
// what changed since the last time, and drops just the cached reads those changes affect (the same rules
// as for this device's own writes, policy.ts). Nothing is stored in the browser.
import { invalidate, notify, setTtlScale } from './cache'
import { auth, rpc } from './http'
import { invalidatesFor } from './policy'

const INTERVAL = 30_000
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

let started = false
export function startSync() {
  if (started || typeof window === 'undefined') return
  started = true
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, () => { lastUse = Date.now() }, { passive: true })
  // Coming back to the tab: catch up at once.
  document.addEventListener('visibilitychange', () => { if (visible() && Date.now() - lastPoll > 5000) { lastUse = Date.now(); void poll() } })
  setInterval(() => {
    if (running || off || !visible() || Date.now() - lastUse > IDLE_AFTER) return
    if (Date.now() - lastPoll >= INTERVAL) void poll()
  }, 5000)
}
