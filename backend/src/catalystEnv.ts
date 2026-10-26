// What the Catalyst functions (api, daily) run on. Chosen by the function's environment variables:
//   TURSO_PLATFORM_URL set → Turso: one platform database + one database per shop (recommended)
//   otherwise              → the Catalyst Data Store, everything in one database (the first version)
// Files are always in Catalyst Stratus.
import type { Env } from './core/context'
import { DbEpochs, KvEpochs } from './core/epochs'
import { StratusFiles } from './core/files'
import { CatalystKv, MemoryKv } from './core/kv'
import { DbKv } from './core/dbKv'
import { pushFromEnv, type PushSender } from './core/webpush'
import { sinkFromEnv, type EventSink } from './events/publish'
import { CatalystDb, type CatalystAppLike } from './db/catalyst'
import { SingleDatabases, tursoFromEnv, type Databases } from './db/databases'

export const usesTurso = () => !!process.env.TURSO_PLATFORM_URL

// Turso connections, the session cache and the epochs live as long as the function instance (reused
// between requests while it is warm); nothing in them is request-specific.
let turso: { dbs: Databases; kv: MemoryKv; epochs: DbEpochs; shared: DbKv } | null = null
let push: PushSender | null | undefined
let events: EventSink | null | undefined

export function catalystEnv(app: unknown): Env {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = app as any
  const files = new StratusFiles(any.stratus().bucket(process.env.STRATUS_BUCKET || 'billpoodum-media'), process.env.STRATUS_PUBLIC_URL || '')
  if (push === undefined) push = pushFromEnv()
  if (events === undefined) events = sinkFromEnv()
  if (usesTurso()) {
    // Shared cache (menu / report copies, version stamps, tracking, rate limits) in a Turso table: the same on every
    // instance, and a read costs a Turso row instead of a paid Catalyst Cache request.
    if (!turso) { const dbs = tursoFromEnv(); turso = { dbs, kv: new MemoryKv(5000), epochs: new DbEpochs(), shared: new DbKv(() => dbs.platform()) } }
    return { ...turso, files, push, events }
  }
  // Catalyst Data Store setup: Catalyst Cache, as before.
  const shared = new CatalystKv(any.cache().segment())
  return { dbs: new SingleDatabases(new CatalystDb(app as CatalystAppLike)), kv: shared, files, epochs: new KvEpochs(shared), shared, push, events }
}
