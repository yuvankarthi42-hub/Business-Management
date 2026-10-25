// Local SQLite databases (sql.js) with the same layout as production: a platform database and one per shop.
// dir = a folder (local development: backend/.local/sqlite/*.sqlite) or undefined (tests: in memory).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'sql.js'
import { PerShopDatabases, type Provisioner } from './databases'
import { SqlJsDriver, sqlJs } from './sql/sqljs'

export class LocalProvisioner implements Provisioner {
  /** Open databases by name (the tests look at their stats). */
  readonly open = new Map<string, SqlJsDriver>()
  constructor(private dir?: string) { if (dir) mkdirSync(dir, { recursive: true }) }

  private async driver(name: string): Promise<SqlJsDriver> {
    const hit = this.open.get(name)
    if (hit) return hit
    const SQL = await sqlJs()
    const file = this.dir ? join(this.dir, `${name}.sqlite`) : null
    const db: Database = file && existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database()
    // export() re-opens the database, which resets the foreign_keys pragma.
    const save = file ? (d: Database) => { writeFileSync(file, Buffer.from(d.export())); d.exec('PRAGMA foreign_keys = ON') } : undefined
    const drv = new SqlJsDriver(db, save)
    this.open.set(name, drv)
    return drv
  }
  platform() { return this.driver('platform') }
  async create(name: string) { await this.driver(name); return { url: `local:${name}`, token: null } }
  async connect(url: string) {
    const m = /^local:([a-z0-9-]+)$/.exec(url)
    if (!m) throw new Error(`Not a local database: ${url}`)
    return this.driver(m[1])
  }
  async drop(name: string) {
    this.open.delete(name)
    if (this.dir) rmSync(join(this.dir, `${name}.sqlite`), { force: true })
  }
}

export const localDatabases = (dir?: string, prov = new LocalProvisioner(dir)) => new PerShopDatabases(prov, 'local')
