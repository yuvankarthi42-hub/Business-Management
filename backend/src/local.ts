// Local development server: same API and the same database layout as production (a platform database +
// one per shop), on real SQLite files in backend/.local/sqlite/ (sql.js — nothing to install).
//   cd backend && npm run dev        → http://localhost:8787   (the web app proxies /server/api to it)
// LOCAL_DB=memory uses the in-memory single-database store instead (saved to .local/db.json), like Catalyst.
// First run creates a product admin from LOCAL_ADMIN_USER / LOCAL_ADMIN_PASSWORD (see .env.local.example).
import express from 'express'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app'
import type { Env } from './core/context'
import { DbEpochs, KvEpochs } from './core/epochs'
import { LocalFiles } from './core/files'
import { MemoryKv } from './core/kv'
import { pushFromEnv } from './core/webpush'
import { Hub, hubRoutes } from './events/hub'
import { LocalSink } from './events/publish'
import { SingleDatabases } from './db/databases'
import { localDatabases } from './db/local'
import { MemoryDb } from './db/memory'
import { ensureFirstAdmin } from './modules/admin/auth'

// backend/.env.local (not committed): LOCAL_ADMIN_USER, LOCAL_ADMIN_PASSWORD, AUTH_SECRET, SETUP_KEY…
const envFile = join(__dirname, '..', '.env.local')
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const dir = join(__dirname, '..', '.local')
mkdirSync(join(dir, 'uploads'), { recursive: true })
const port = Number(process.env.PORT ?? 8787)
const kv = new MemoryKv()
const files = new LocalFiles(join(dir, 'uploads'), `/server/api/uploads`)
// Live updates: the event hub runs inside the local server (production: its own AppSail service).
const hub = new Hub()
process.env.EVENTS_PUBLIC_URL ??= '/server/events'
const events = new LocalSink(hub)
const env: Env = process.env.LOCAL_DB === 'memory'
  ? { dbs: new SingleDatabases(new MemoryDb(join(dir, 'db.json'))), kv, files, epochs: new KvEpochs(kv), push: pushFromEnv(), events }
  : { dbs: localDatabases(join(dir, 'sqlite')), kv, files, epochs: new DbEpochs(), push: pushFromEnv(), events }

const server = express()
server.use('/server/api/uploads', express.static(join(dir, 'uploads'), { maxAge: '7d' }))
server.use('/server/events', hubRoutes(hub))
server.use('/server/api', createApp(() => env))

env.dbs.platform().then(ensureFirstAdmin).then((made) => {
  if (made) console.log(`Created product admin "${made}" (password from LOCAL_ADMIN_PASSWORD).`)
  server.listen(port, () => console.log(`Kadai Kalanjiyam API (local, ${process.env.LOCAL_DB === 'memory' ? 'in-memory' : 'SQLite, one database per shop'}) → http://localhost:${port}/server/api`))
}).catch((e) => { console.error(e); process.exit(1) })
