// Change feed for the other devices of a shop (one database per shop only).
// Every committed write adds a change_log row with the action's name (app.ts / Ctx.tx). A device asks
// "what changed since <id>" every ~30 s while it is on screen and re-reads only what those actions change
// (the app's cache policy already knows that for its own writes). Its own changes are left out (x-device).
import { define, userRead } from '../core/registry'

const MAX = 200

define('sync', {
  /** since = null: just starting (returns the newest id). since = n: what changed after id n (0 = from the start). */
  changes: userRead(async (c, since?: number | null) => {
    if (!c.dbs.perShop || !c.db.sql) return { supported: false }
    const epoch = c.epoch
    const from = since == null ? -1 : Number(since)
    if (!Number.isSafeInteger(from) || from < 0) {
      const [r] = await c.db.sql('SELECT COALESCE(MAX("id"), 0) AS "id" FROM "change_log"')
      return { supported: true, latest: Number(r?.id ?? 0), changes: [], epoch }
    }
    const rows = await c.db.sql('SELECT "id", "tag", "branch_id", "origin" FROM "change_log" WHERE "id" > ? ORDER BY "id" LIMIT ?', [from, MAX + 1])
    if (!rows.length) {
      // A smaller newest id means the feed was started again (database restored): re-read everything.
      const [r] = await c.db.sql('SELECT COALESCE(MAX("id"), 0) AS "id" FROM "change_log"')
      const latest = Number(r?.id ?? 0)
      return latest < from ? { supported: true, latest, changes: [], reset: true, epoch } : { supported: true, latest: from, changes: [], epoch }
    }
    // Too many to list: the device simply re-reads everything.
    if (rows.length > MAX) return { supported: true, latest: Number(rows[rows.length - 1].id), changes: [], reset: true, epoch }
    const scope = new Set(c.scope())
    const names = new Set<string>()
    for (const r of rows) {
      if (c.origin && r.origin === c.origin) continue
      if (r.branch_id != null && !scope.has(String(r.branch_id))) continue
      names.add(String(r.tag))
    }
    return { supported: true, latest: Number(rows[rows.length - 1].id), changes: [...names], epoch }
  }),
})
