// Runs the migration files (backend/migrations/<kind>/NNNN_*.sql, bundled in migrations.gen.ts) that a
// database hasn't had yet. Safe to call from many function instances at once: the files run inside one
// BEGIN IMMEDIATE transaction, which re-checks schema_migrations after taking the lock.
import { MIGRATIONS } from './migrations.gen'
import { SqlError, type SqlDriver, type SqlRunner } from './sql/driver'

export type DbKind = keyof typeof MIGRATIONS
export const latestVersion = (kind: DbKind) => MIGRATIONS[kind][MIGRATIONS[kind].length - 1].version

async function applied(r: SqlRunner): Promise<Set<string>> {
  try {
    const [res] = await r.run([{ sql: 'SELECT "version" FROM "schema_migrations"' }])
    return new Set(res.rows.map((x) => String(x[0])))
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return new Set()
    throw e
  }
}

/** Returns the versions it applied (empty when the database was already up to date). */
export async function migrate(driver: SqlDriver, kind: DbKind): Promise<string[]> {
  const files = MIGRATIONS[kind]
  if (files.every((m) => /^\d{4}_[a-z0-9_]+$/.test(m.version)) === false) throw new Error('Bad migration file name')
  const before = await applied(driver)
  if (files.every((m) => before.has(m.version))) return []
  const tx = await driver.begin()
  try {
    const now = await applied(tx)
    const done: string[] = []
    for (const m of files) {
      if (now.has(m.version)) continue
      await tx.script(m.sql)
      await tx.run([{ sql: 'INSERT INTO "schema_migrations" ("version") VALUES (?)', args: [m.version] }])
      done.push(m.version)
    }
    await tx.commit()
    return done
  } catch (e) {
    await tx.rollback()
    throw e
  }
}

/** A database that was just created can take a few seconds to answer — try for up to `ms`. */
export async function migrateWhenReachable(driver: SqlDriver, kind: DbKind, ms = 30_000) {
  const until = Date.now() + ms
  for (let wait = 300; ; wait = Math.min(wait * 2, 4000)) {
    try { return await migrate(driver, kind) } catch (e) {
      const retry = e instanceof SqlError && (e.kind === 'network' || e.kind === 'busy' || e.kind === 'gone')
      if (!retry || Date.now() + wait > until) throw e
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}
