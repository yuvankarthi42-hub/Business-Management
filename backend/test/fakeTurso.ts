// A small stand-in for Turso's HTTP API ("Hrana over HTTP", POST <db>/v2/pipeline), backed by real SQLite
// (sql.js), so the tests run the production HranaDriver end to end: batons (interactive transactions),
// batch steps with conditions, sequences, errors and the bearer token. TEST_DB=hrana runs every test on it.
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { Provisioner } from '../src/db/databases'
import { SqlError, type SqlTx, type SqlValue } from '../src/db/sql/driver'
import { HranaDriver } from '../src/db/sql/hrana'
import { SqlJsDriver, sqlJs } from '../src/db/sql/sqljs'

type HValue = { type: 'null' } | { type: 'integer'; value: string } | { type: 'float'; value: number } | { type: 'text'; value: string }
const TOKEN = 'fake-turso-token'

const dec = (v: HValue): SqlValue => (v.type === 'null' ? null : v.type === 'integer' ? Number(v.value) : v.type === 'float' ? v.value : v.value)
const enc = (v: SqlValue): HValue => (v === null ? { type: 'null' } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }) : { type: 'text', value: v })

interface Stream { db: string; tx: SqlTx | null }

export async function startFakeTurso() {
  const SQL = await sqlJs()
  const dbs = new Map<string, SqlJsDriver>()
  const streams = new Map<string, Stream>()
  const body = (req: IncomingMessage) => new Promise<string>((res) => { let s = ''; req.on('data', (d) => { s += d }); req.on('end', () => res(s)) })

  async function execute(st: Stream, stmt: { sql: string; args?: HValue[] }) {
    const drv = dbs.get(st.db)!
    const sql = stmt.sql.trim()
    if (/^BEGIN/i.test(sql)) { if (st.tx) throw new SqlError('other', 'cannot start a transaction within a transaction'); st.tx = await drv.begin(); return empty() }
    if (/^COMMIT/i.test(sql)) { if (!st.tx) throw new SqlError('other', 'no transaction'); const t = st.tx; st.tx = null; await t.commit(); return empty() }
    if (/^ROLLBACK/i.test(sql)) { if (st.tx) { const t = st.tx; st.tx = null; await t.rollback() } return empty() }
    if (/^PRAGMA foreign_keys/i.test(sql)) return empty()
    const [r] = await (st.tx ?? drv).run([{ sql, args: (stmt.args ?? []).map(dec) }])
    return { cols: r.columns.map((name) => ({ name, decltype: null })), rows: r.rows.map((row) => row.map(enc)), affected_row_count: r.changes, last_insert_rowid: r.lastId == null ? null : String(r.lastId) }
  }
  const empty = () => ({ cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null })
  const errOf = (e: unknown) => ({ message: (e as Error).message, code: 'SQLITE_ERROR' })

  const server = createServer(async (req, res) => {
    const m = /^\/db\/([a-z0-9-]+)\/v2\/pipeline$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) { res.writeHead(404).end('not found'); return }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end('unauthorized'); return }
    if (!dbs.has(m[1])) { res.writeHead(404).end('database not found'); return }
    const { baton, requests } = JSON.parse(await body(req)) as { baton: string | null; requests: { type: string; stmt?: { sql: string; args?: HValue[] }; sql?: string; batch?: { steps: { stmt: { sql: string; args?: HValue[] }; condition?: Cond }[] } }[] }
    let st: Stream | undefined = baton ? streams.get(baton) : { db: m[1], tx: null }
    if (!st) { res.writeHead(400).end('stream expired'); return }
    if (baton) streams.delete(baton)
    const results: unknown[] = []
    let closed = false
    for (const r of requests) {
      try {
        if (r.type === 'close') { if (st.tx) { await st.tx.rollback(); st.tx = null } closed = true; results.push({ type: 'ok', response: { type: 'close' } }) }
        else if (r.type === 'execute') results.push({ type: 'ok', response: { type: 'execute', result: await execute(st, r.stmt!) } })
        else if (r.type === 'sequence') { await (st.tx ?? dbs.get(st.db)!).script(r.sql!); results.push({ type: 'ok', response: { type: 'sequence' } }) }
        else if (r.type === 'batch') {
          const okSteps: boolean[] = [], step_results: unknown[] = [], step_errors: unknown[] = []
          const holds = (c?: Cond): boolean => !c || (c.type === 'ok' ? okSteps[c.step!] === true : c.type === 'not' ? !holds(c.cond) : false)
          for (const s of r.batch!.steps) {
            if (!holds(s.condition)) { okSteps.push(false); step_results.push(null); step_errors.push(null); continue }
            try { step_results.push(await execute(st, s.stmt)); step_errors.push(null); okSteps.push(true) }
            catch (e) { step_results.push(null); step_errors.push(errOf(e)); okSteps.push(false) }
          }
          results.push({ type: 'ok', response: { type: 'batch', result: { step_results, step_errors } } })
        } else results.push({ type: 'error', error: { message: `unknown request ${r.type}` } })
      } catch (e) { results.push({ type: 'error', error: errOf(e) }) }
    }
    let next: string | null = null
    if (!closed) { next = randomBytes(8).toString('hex'); streams.set(next, st); st = undefined }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ baton: next, base_url: null, results }))
  })
  server.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/db`
  const make = (name: string) => { if (!dbs.has(name)) dbs.set(name, new SqlJsDriver(new SQL.Database())) }
  make('platform')

  const provisioner: Provisioner = {
    platform: async () => new HranaDriver(`${base}/platform`, TOKEN),
    create: async (name) => { make(name); return `${base}/${name}` },
    connect: async (url) => new HranaDriver(url, TOKEN),
    drop: async (name) => { dbs.delete(name) },
  }
  return { provisioner, close: () => server.close(), drivers: dbs }
}

type Cond = { type: 'ok' | 'not'; step?: number; cond?: Cond }
