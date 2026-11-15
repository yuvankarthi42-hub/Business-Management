// What the Cloudflare Worker runs on (the Cloudflare setup): Turso (one platform database + one per shop, as on
// Catalyst), the shared cache in a Turso table, R2 for files, and — when LIVE_URL and the SHOP_HUB binding are set —
// the live-update hub (WebSockets, worker/hub.ts) instead of the change feed's timer.
import type { Env } from '../core/context'
import { DbEpochs } from '../core/epochs'
import { MemoryKv } from '../core/kv'
import { DbKv } from '../core/dbKv'
import { ApiError } from '../core/errors'
import { pushFromEnv } from '../core/webpush'
import { tursoFromEnv } from '../db/databases'
import type { EventSink } from '../events/publish'
import type { HubEvent } from '../events/hub'
import { R2Files } from './r2Files'
import type { DurableObjectNamespaceLike, WorkerEnv } from './types'

/** A request's events, to each shop's hub (one call per shop; after the changes were saved). */
export class HubSink implements EventSink {
  constructor(private ns: DurableObjectNamespaceLike) {}
  async publish(events: HubEvent[]) {
    const byShop = new Map<string, HubEvent[]>()
    for (const ev of events) if (ev?.shop) byShop.set(ev.shop, [...(byShop.get(ev.shop) ?? []), ev])
    await Promise.all([...byShop].map(async ([shop, list]) => {
      const r = await this.ns.get(this.ns.idFromName(shop)).fetch('https://hub/publish', { method: 'POST', body: JSON.stringify(list), headers: { 'content-type': 'application/json' } })
      if (!r.ok && r.status !== 204) throw new Error(`hub ${r.status}`)
    }))
  }
}

// Kept for the isolate's life (reused between requests while it is warm); nothing in it is request-specific.
let made: { bindings: WorkerEnv; env: Env } | null = null

/** Tests only: environments handed in for given bindings (several test servers can run in one process). */
const forTests = new WeakMap<WorkerEnv, Env>()

export function cloudflareEnv(bindings: WorkerEnv): Env {
  const t = forTests.get(bindings)
  if (t) return t
  if (made && made.bindings === bindings) return made.env
  if (!process.env.TURSO_PLATFORM_URL) throw new ApiError('Server is not configured (TURSO_PLATFORM_URL)', 500, 'CONFIG')
  if (!bindings.MEDIA) throw new ApiError('Server is not configured (R2 bucket binding MEDIA)', 500, 'CONFIG')
  if (!process.env.R2_PUBLIC_URL) throw new ApiError('Server is not configured (R2_PUBLIC_URL)', 500, 'CONFIG')
  const files = new R2Files(bindings.MEDIA, process.env.R2_PUBLIC_URL, bindings.MEDIA_PRIVATE ?? null)
  const dbs = tursoFromEnv()
  const liveUrl = process.env.LIVE_URL && bindings.SHOP_HUB ? process.env.LIVE_URL : null
  const env: Env = {
    dbs, kv: new MemoryKv(5000), epochs: new DbEpochs(), shared: new DbKv(() => dbs.platform()), files, push: pushFromEnv(),
    events: liveUrl && bindings.SHOP_HUB ? new HubSink(bindings.SHOP_HUB) : null, liveUrl,
  }
  made = { bindings, env }
  return env
}

/** Tests only: the environment the Worker uses for these bindings (instead of building one from real Cloudflare ones). */
export function useEnvForTests(bindings: WorkerEnv, env: Env) { forTests.set(bindings, env) }
