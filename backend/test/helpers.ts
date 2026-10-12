// Test harness: the real Express app on a random port with fresh databases.
//   TEST_DB=sqlite (default) — real SQLite (sql.js), one platform database + one per shop, like Turso
//   TEST_DB=memory           — the in-memory single-database store, like the Catalyst Data Store
// `npm test` runs every test in both.
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app'
import { Ctx, type Env } from '../src/core/context'
import { DbEpochs, KvEpochs } from '../src/core/epochs'
import { LocalFiles } from '../src/core/files'
import { MemoryKv } from '../src/core/kv'
import { PerShopDatabases, SingleDatabases } from '../src/db/databases'
import { startFakeTurso } from './fakeTurso'
import { LocalProvisioner, localDatabases } from '../src/db/local'
import { MemoryDb } from '../src/db/memory'
import { PLATFORM_TABLES, type TableName } from '../src/db/schema.gen'
import type { Db, Where } from '../src/db/types'

export const TEST_DB = process.env.TEST_DB === 'memory' ? 'memory' : process.env.TEST_DB === 'hrana' ? 'hrana' : 'sqlite'
/** One database per shop (sqlite: in-process; hrana: over HTTP with the production Turso driver). */
export const PER_SHOP = TEST_DB !== 'memory'

export async function testEnv(): Promise<Env & { prov: LocalProvisioner | null; stop: () => void }> {
  const kv = new MemoryKv()
  const files = new LocalFiles('/tmp/bp-test-uploads', '/uploads')
  if (TEST_DB === 'memory') return { dbs: new SingleDatabases(new MemoryDb()), kv, files, epochs: new KvEpochs(kv), prov: null, stop: () => {} }
  if (TEST_DB === 'hrana') {
    const fake = await startFakeTurso()
    return { dbs: new PerShopDatabases(fake.provisioner, 'test'), kv, files, epochs: new DbEpochs(), prov: null, stop: fake.close }
  }
  const prov = new LocalProvisioner()
  return { dbs: localDatabases(undefined, prov), kv, files, epochs: new DbEpochs(), prov, stop: () => {} }
}

/**
 * For checks in the tests: one handle that sends each table to its database — platform tables to the platform
 * database, the rest to the test shop's. Shared tables go to the platform when the row is a platform one.
 */
function router(env: Env, shopId: () => string | null): Db {
  const isPlatform = (t: TableName, hint?: Where | Record<string, unknown>) =>
    PLATFORM_TABLES.includes(t) || (!!hint && (hint.business_id === null || String(hint.uniq_key ?? '').startsWith('platform')))
  const pick = async (t: TableName, hint?: Where | Record<string, unknown>) => {
    if (isPlatform(t, hint)) return env.dbs.platform()
    const id = shopId()
    if (!id) throw new Error('No test shop yet')
    return env.dbs.shop(id)
  }
  return {
    transaction: async () => { throw new Error('not in tests') },
    aggregate: async (t, o) => (await pick(t, o.where)).aggregate(t, o),
    select: async (t, o) => (await pick(t, o?.where)).select(t, o),
    first: async (t, w, o) => (await pick(t, w)).first(t, w, o),
    get: async (t, id) => (await pick(t)).get(t, id),
    count: async (t, w) => (await pick(t, w)).count(t, w),
    insert: async (t, r) => (await pick(t, r)).insert(t, r),
    insertMany: async (t, r) => (await pick(t, r[0])).insertMany(t, r),
    update: async (t, id, p) => (await pick(t)).update(t, id, p),
    updateMany: async (t, r) => (await pick(t)).updateMany(t, r),
    updateIfVersion: async (t, id, v, p) => (await pick(t)).updateIfVersion(t, id, v, p),
    delete: async (t, id) => (await pick(t)).delete(t, id),
    deleteMany: async (t, ids) => (await pick(t)).deleteMany(t, ids),
  }
}

export async function startServer() {
  process.env.SETUP_KEY = 'test-setup-key-1234567890'
  const env = await testEnv()
  const server = createApp(() => env).listen(0)
  const port = (server.address() as AddressInfo).port
  let token: string | null = null
  let branch: string | null = null
  let shop: string | null = null
  let device: string | null = null
  async function call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${port}/rpc/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(branch ? { 'x-branch': branch } : {}), ...(device ? { 'x-device': device } : {}) },
      body: JSON.stringify({ args }),
    })
    const body = await res.json() as { data?: T; error?: { message: string; code: string } }
    if (body.error) { const e = new Error(body.error.message) as Error & { code: string; status: number }; e.code = body.error.code; e.status = res.status; throw e }
    return body.data as T
  }
  /** Makes cached sessions stale, as the API does after a change (for rows the test edits directly). */
  async function bump(businessId: string | 'global') {
    const c = new Ctx(env, await env.dbs.platform(), null)
    await env.epochs.bump(c, businessId)
  }
  return {
    db: router(env, () => shop), env, call, bump, close: () => { server.close(); env.stop() }, base: `http://127.0.0.1:${port}`,
    setToken: (t: string | null) => { token = t }, setBranch: (b: string | null) => { branch = b }, setDevice: (d: string | null) => { device = d },
    /** Which shop `db` reads for shop tables. */
    useShop: (id: string | null) => { shop = id },
  }
}
