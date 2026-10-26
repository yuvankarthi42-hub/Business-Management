// The shared cache on the Turso setup: one small table in the platform database ("kv_cache"), instead of
// Catalyst Cache. Every API instance sees the same values (like Catalyst Cache), but a read is one Turso row
// (practically free) instead of a paid Catalyst Cache request.
// Like CatalystKv, a failing call never fails the request — the code then simply reads the real data.
import type { Db } from '../db/types'
import type { Kv } from './kv'

export class DbKv implements Kv {
  constructor(private platform: () => Promise<Db>) {}
  async get(k: string) {
    try {
      const db = await this.platform()
      const rows = await db.sql!('SELECT "value", "expires_at" FROM "kv_cache" WHERE "key" = ?', [k])
      const r = rows[0]
      if (!r || Number(r.expires_at) < Date.now()) return null
      return String(r.value)
    } catch { return null }
  }
  async set(k: string, v: string, ttlHours = 1) {
    try {
      const db = await this.platform()
      await db.sql!('INSERT INTO "kv_cache" ("key", "value", "expires_at") VALUES (?, ?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value", "expires_at" = excluded."expires_at"',
        [k, v, Date.now() + Math.round(ttlHours * 3_600_000)])
      // Now and then drop expired rows (uses the expires_at index; a few rows at a time).
      if (Math.random() < 0.01) await db.sql!('DELETE FROM "kv_cache" WHERE "key" IN (SELECT "key" FROM "kv_cache" WHERE "expires_at" < ? LIMIT 500)', [Date.now()])
    } catch { /* the cache is optional */ }
  }
  async del(k: string) {
    try { await (await this.platform()).sql!('DELETE FROM "kv_cache" WHERE "key" = ?', [k]) } catch { /* the cache is optional */ }
  }
}
