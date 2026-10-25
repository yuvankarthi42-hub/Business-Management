// Which database a request uses.
//   SingleDatabases   — everything in one database (Catalyst Data Store, the in-memory test store)
//   PerShopDatabases  — one platform database + one database per shop (Turso; local SQLite files in development)
// The rest of the code only asks for "the platform database" or "this shop's database".
import { ApiError } from '../core/errors'
import { latestVersion, migrate, migrateWhenReachable } from './migrate'
import * as E from '../../../server/catalyst/enums'
import { SqlError, type SqlDriver } from './sql/driver'
import { HranaDriver } from './sql/hrana'
import { TursoDb } from './turso'
import type { Db } from './types'

export interface Databases {
  /** true = every shop has its own database. */
  readonly perShop: boolean
  platform(): Promise<Db>
  /** The shop's own database (migrated to the newest schema on first use). */
  shop(businessId: string): Promise<Db>
  /** Makes the shop's database (product admin → create customer). No-op with a single database. */
  createShop(businessId: string): Promise<void>
  /** Removes the shop's database and everything in it. No-op with a single database (the cascade does it). */
  dropShop(businessId: string): Promise<void>
  /** Every database up to the newest migration (after a deploy that adds one). */
  migrateAll(): Promise<{ platform: string[]; shops: { businessId: string; applied?: string[]; error?: string }[] }>
}

export class SingleDatabases implements Databases {
  readonly perShop = false
  constructor(private db: Db) {}
  async platform() { return this.db }
  async shop() { return this.db }
  async createShop() {}
  async dropShop() {}
  async migrateAll() { return { platform: [], shops: [] } }
}

/** Creates, opens and removes databases (Turso Platform API, or local files). */
export interface Provisioner {
  platform(): Promise<SqlDriver>
  /**
   * Makes an empty database and returns its URL, and (Turso) an access token for just that database.
   * Must succeed when it already exists (a retry).
   */
  create(name: string): Promise<{ url: string; token?: string | null }>
  /** `token` = the database's own token; without one the provider's default token is used. */
  connect(url: string, token?: string | null): Promise<SqlDriver>
  drop(name: string, url: string | null): Promise<void>
}

const SHOP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/

export class PerShopDatabases implements Databases {
  readonly perShop = true
  private platformDb: Promise<Db> | null = null
  private shops = new Map<string, Promise<Db>>()
  constructor(private prov: Provisioner, private prefix = 'bp') {
    if (!/^[a-z0-9-]{1,20}$/.test(prefix)) throw new Error('TURSO_DB_PREFIX: lower-case letters, numbers and dashes')
  }

  platform(): Promise<Db> {
    this.platformDb ??= (async () => {
      const driver = await this.prov.platform()
      await migrate(driver, 'platform')
      return new TursoDb(driver)
    })().catch((e) => { this.platformDb = null; throw e })
    return this.platformDb
  }

  shop(businessId: string): Promise<Db> {
    const id = String(businessId)
    if (!/^\d{1,16}$/.test(id)) return Promise.reject(new ApiError('Shop not found', 404, 'NOT_FOUND'))
    let hit = this.shops.get(id)
    if (!hit) {
      hit = this.open(id).catch((e) => { this.shops.delete(id); throw e })
      this.shops.set(id, hit)
    }
    return hit
  }
  private async open(businessId: string): Promise<Db> {
    const p = await this.platform()
    const row = await p.first('shop_databases', { business_id: businessId })
    if (!row || !row.db_url) throw new ApiError('This shop has no data yet. Please contact support.', 404, 'NO_SHOP_DB')
    if (Number(row.status) !== E.ShopDbStatus.ready) throw new ApiError('This shop is being set up — please try again in a minute.', 503, 'SHOP_DB_NOT_READY')
    const driver = await this.prov.connect(String(row.db_url), row.db_token ? String(row.db_token) : null)
    if (row.schema_version !== latestVersion('shop')) {
      await migrate(driver, 'shop')
      await p.update('shop_databases', row.ROWID, { schema_version: latestVersion('shop') })
    }
    return new TursoDb(driver)
  }

  nameFor(businessId: string) {
    const name = `${this.prefix}-shop-${businessId}`
    if (!SHOP_NAME.test(name)) throw new Error('Bad database name')
    return name
  }

  async createShop(businessId: string) {
    const p = await this.platform()
    const name = this.nameFor(businessId)
    const existing = await p.first('shop_databases', { business_id: businessId })
    const row = existing ?? await p.insert('shop_databases', { business_id: businessId, db_name: name, status: E.ShopDbStatus.creating })
    let step: 'create' | 'tables' = 'create'
    try {
      const { url, token } = await this.prov.create(name)
      step = 'tables'
      await migrateWhenReachable(await this.prov.connect(url, token), 'shop')
      await p.update('shop_databases', row.ROWID, { db_url: url, db_token: token ?? null, status: E.ShopDbStatus.ready, schema_version: latestVersion('shop') })
    } catch (e) {
      console.error(`[createShop ${businessId}] ${step}`, e)
      await p.update('shop_databases', row.ROWID, { status: E.ShopDbStatus.failed }).catch(() => {})
      // Only the product admin sees this, and it never contains a token — it says which setting to check.
      throw new ApiError(`Couldn’t create the shop’s database — ${explainCreate(e, step)}`, 503, 'SHOP_DB_CREATE_FAILED')
    }
  }

  async dropShop(businessId: string) {
    const p = await this.platform()
    const row = await p.first('shop_databases', { business_id: businessId })
    this.shops.delete(String(businessId))
    if (!row) return
    await p.update('shop_databases', row.ROWID, { status: E.ShopDbStatus.deleting })
    await this.prov.drop(String(row.db_name), row.db_url ? String(row.db_url) : null)
    await p.delete('shop_databases', row.ROWID)
  }

  async migrateAll() {
    const p = await this.platform()
    const platform = await migrate(await this.prov.platform(), 'platform')
    const rows = await p.select('shop_databases', { where: { status: E.ShopDbStatus.ready } })
    const shops: { businessId: string; applied?: string[]; error?: string }[] = []
    for (const r of rows) {
      const businessId = String(r.business_id)
      try {
        const applied = await migrate(await this.prov.connect(String(r.db_url), r.db_token ? String(r.db_token) : null), 'shop')
        await p.update('shop_databases', r.ROWID, { schema_version: latestVersion('shop') })
        shops.push({ businessId, applied })
      } catch (e) { shops.push({ businessId, error: (e as Error).message }) }
    }
    return { platform, shops }
  }
}

/**
 * Turso: the platform database + one database per shop. New shop databases are made with the Turso Platform
 * API (TURSO_API_TOKEN), which also issues each one its own access token — so TURSO_AUTH_TOKEN only has to open
 * the platform database (a database token for it is enough; a group token works too).
 */
export class TursoProvisioner implements Provisioner {
  constructor(private cfg: { platformUrl: string; token: string; org: string; apiToken: string; group: string; location?: string }) {
    for (const k of ['platformUrl', 'token', 'org', 'apiToken', 'group'] as const) if (!cfg[k]) throw new Error(`Turso setting missing: ${k}`)
  }
  private api(path: string, init: RequestInit = {}) {
    return fetch(`https://api.turso.tech/v1/organizations/${encodeURIComponent(this.cfg.org)}${path}`, {
      ...init, headers: { authorization: `Bearer ${this.cfg.apiToken}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    })
  }
  async platform() { return new HranaDriver(this.cfg.platformUrl, this.cfg.token) }
  async connect(url: string, token?: string | null) { return new HranaDriver(url, token || this.cfg.token) }
  async create(name: string) {
    const res = await this.api('/databases', { method: 'POST', body: JSON.stringify({ name, group: this.cfg.group, ...(this.cfg.location ? { location: this.cfg.location } : {}) }) })
    let host: string | undefined
    if (res.ok) host = ((await res.json()) as { database?: { Hostname?: string } }).database?.Hostname
    else if (res.status === 409) {
      // Already made by an earlier try — use it.
      const got = await this.api(`/databases/${encodeURIComponent(name)}`)
      if (!got.ok) throw new Error(`Turso get database ${got.status}: ${(await got.text()).slice(0, 300)}`)
      host = ((await got.json()) as { database?: { Hostname?: string } }).database?.Hostname
    } else throw new Error(`Turso create database ${res.status}: ${(await res.text()).slice(0, 300)}`)
    if (!host) throw new Error('Turso did not return the database address')
    // An access token for just this database (full access, no expiry), kept encrypted in shop_databases.
    const tok = await this.api(`/databases/${encodeURIComponent(name)}/auth/tokens?expiration=never&authorization=full-access`, { method: 'POST' })
    if (!tok.ok) throw new Error(`Turso create database token ${tok.status}: ${(await tok.text()).slice(0, 300)}`)
    const jwt = ((await tok.json()) as { jwt?: string }).jwt
    if (!jwt) throw new Error('Turso did not return a database token')
    return { url: `libsql://${host}`, token: jwt }
  }
  async drop(name: string) {
    const res = await this.api(`/databases/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`Turso delete database ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
}

/** Reads the Turso settings from the function's environment variables. */
export function tursoFromEnv(env = process.env): PerShopDatabases {
  return new PerShopDatabases(new TursoProvisioner({
    platformUrl: env.TURSO_PLATFORM_URL ?? '', token: env.TURSO_AUTH_TOKEN ?? '', org: env.TURSO_ORG ?? '', apiToken: env.TURSO_API_TOKEN ?? '',
    group: env.TURSO_GROUP || 'default', location: env.TURSO_LOCATION || undefined,
  }), env.TURSO_DB_PREFIX || 'bp')
}

/** Why making a shop database failed, in words that point at the setting to fix. */
function explainCreate(e: unknown, step: 'create' | 'tables'): string {
  const msg = (e as Error)?.message ?? String(e)
  const status = /Turso (?:create|get) database (?:token )?(\d{3})/.exec(msg)?.[1]
  if (step === 'create') {
    // Turso's own reason (never contains the token), e.g. {"error":"token is not scoped to group default"}
    const said = (/\{"error":"([^"]{1,160})"/.exec(msg)?.[1] ?? '').trim()
    if (/scoped to group/i.test(said)) return `Turso says: ${said}. Set TURSO_GROUP to the group your API token is allowed for (and where the platform database is), or make an API token for that group.`
    if (status === '401' || status === '403') return `Turso refused the API token${said ? ` (${said})` : ''}. Check TURSO_API_TOKEN (Turso → Settings → API Tokens): it must exist, not be expired, and be allowed for the group in TURSO_GROUP.`
    if (status === '404') return 'Turso can’t find the organisation or group. Check TURSO_ORG and TURSO_GROUP.'
    if (status) return `Turso answered ${status}: ${msg.replace(/^.*?\d{3}:\s*/, '').slice(0, 160)}`
    if (/fetch failed|ENOTFOUND|ECONN|timeout|aborted/i.test(msg)) return 'Can’t reach the Turso API (api.turso.tech). Try again in a minute.'
    return msg.slice(0, 160)
  }
  if (e instanceof SqlError && e.kind === 'auth') return 'The new database refused its access token. Check that TURSO_API_TOKEN may create tokens (organisation-wide or for this group).'
  if (e instanceof SqlError && (e.kind === 'gone' || e.kind === 'network')) return 'The new database isn’t reachable yet. Try again in a minute.'
  return `Creating its tables failed: ${msg.slice(0, 160)}`
}
