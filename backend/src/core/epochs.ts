// "Epochs" make cached sign-in sessions stale at once: every change to a shop's users, roles, branches,
// settings, subscription or features raises the shop's epoch, and the session cache key includes it.
//   KvEpochs  — in the cache (Catalyst Cache): one database for everything.
//   DbEpochs  — in each shop's database (sync_epochs) + the platform's 'epoch' setting for everyone at
//               once (feature flags, prices). The global one is re-read every 30 s per function instance.
import type { Ctx } from './context'
import type { Kv } from './kv'
import { getPlatformSetting, putPlatformSetting } from '../domain/util'

export interface Epochs {
  get(c: Ctx, businessId: string): Promise<string>
  bump(c: Ctx, businessId: string | 'global'): Promise<void>
}

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export class KvEpochs implements Epochs {
  constructor(private kv: Kv) {}
  async get(_c: Ctx, bid: string) { return `${(await this.kv.get(`epoch:${bid}`)) ?? '0'}.${(await this.kv.get('epoch:global')) ?? '0'}` }
  async bump(_c: Ctx, bid: string) { await this.kv.set(bid === 'global' ? 'epoch:global' : `epoch:${bid}`, stamp(), 48) }
}

const GLOBAL_TTL_MS = 30_000

export class DbEpochs implements Epochs {
  private global: { value: string; at: number } | null = null
  private async globalEpoch(c: Ctx) {
    if (this.global && Date.now() - this.global.at < GLOBAL_TTL_MS) return this.global.value
    const v = await getPlatformSetting<{ v?: string }>(c.platform, 'epoch', {})
    this.global = { value: v.v ?? '0', at: Date.now() }
    return this.global.value
  }
  async get(c: Ctx, bid: string) {
    const db = await c.shopDb(bid)
    const [rows, g] = await Promise.all([db.sql!('SELECT "epoch" FROM "sync_epochs" WHERE "business_id" = ?', [Number(bid)]), this.globalEpoch(c)])
    return `${rows[0]?.epoch ?? 0}.${g}`
  }
  async bump(c: Ctx, bid: string) {
    if (bid === 'global') {
      await putPlatformSetting(c.platform, 'epoch', { v: stamp() })
      this.global = null
      return
    }
    const db = await c.shopDb(bid)
    await db.sql!('INSERT INTO "sync_epochs" ("business_id", "epoch") VALUES (?, 1) ON CONFLICT ("business_id") DO UPDATE SET "epoch" = "epoch" + 1, "updated_at" = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')', [Number(bid)])
  }
}
