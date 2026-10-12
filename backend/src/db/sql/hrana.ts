// Turso over HTTPS — the "Hrana over HTTP" pipeline protocol (POST <db>/v2/pipeline), with plain fetch.
// Every pipeline without a baton runs on a fresh connection, so each one starts with PRAGMA foreign_keys = ON.
// An interactive transaction keeps its connection with the baton the server returns.
import { sqlError, SqlError, type SqlDriver, type SqlResult, type SqlTx, type SqlValue, type Stmt } from './driver'

type HValue = { type: 'null' } | { type: 'integer'; value: string } | { type: 'float'; value: number } | { type: 'text'; value: string } | { type: 'blob'; base64: string }
interface HStmtResult { cols: { name: string | null }[]; rows: HValue[][]; affected_row_count: number; last_insert_rowid: string | null }
type HRequest =
  | { type: 'execute'; stmt: { sql: string; args?: HValue[]; want_rows?: boolean } }
  | { type: 'batch'; batch: { steps: { stmt: { sql: string; args?: HValue[] }; condition?: unknown }[] } }
  | { type: 'sequence'; sql: string }
  | { type: 'close' }
type HResult = { type: 'ok'; response: { type: string; result?: HStmtResult | { step_results: (HStmtResult | null)[]; step_errors: ({ message: string; code?: string } | null)[] } } } | { type: 'error'; error: { message: string; code?: string } }

const FK_ON: HRequest = { type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON' } }
const TIMEOUT_MS = 15_000

function toH(v: SqlValue): HValue {
  if (v === null || v === undefined) return { type: 'null' }
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }
  return { type: 'text', value: String(v) }
}
function fromH(v: HValue): SqlValue {
  switch (v.type) {
    case 'null': return null
    case 'integer': return Number(v.value)
    case 'float': return v.value
    case 'text': return v.value
    default: throw new SqlError('other', 'Binary values are not used')
  }
}
const exec = (s: Stmt): HRequest => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args ?? []).map(toH), want_rows: true } })
function result(r: HStmtResult): SqlResult {
  return { columns: r.cols.map((c) => c.name ?? ''), rows: r.rows.map((row) => row.map(fromH)), changes: r.affected_row_count, lastId: r.last_insert_rowid == null ? null : Number(r.last_insert_rowid) }
}

export class HranaDriver implements SqlDriver {
  private base: string
  constructor(url: string, private token: string) {
    this.base = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(this.base)) throw new Error('Turso URL must start with libsql:// or https://')
  }

  /** One HTTP request. Retries only when nothing can have run (connection refused / 5xx before a baton) and `safe`. */
  async pipeline(requests: HRequest[], baton: string | null, base = this.base, safe = false): Promise<{ results: HResult[]; baton: string | null; base: string }> {
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await fetch(`${base}/v2/pipeline`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ baton, requests }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (e) {
        if (safe && attempt < 2) { await sleep(150 * (attempt + 1)); continue }
        throw new SqlError('network', `Database not reachable: ${(e as Error).message}`)
      }
      if (res.status === 401 || res.status === 403) throw new SqlError('auth', 'Database token was refused (check TURSO_AUTH_TOKEN)')
      if (res.status === 404) throw new SqlError('gone', 'Database not found (deleted, or not created yet)')
      if ((res.status >= 500 || res.status === 429) && safe && attempt < 2) { await sleep(200 * (attempt + 1)); continue }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300)
        if (/locked|BUSY/i.test(text)) throw new SqlError('busy', text)
        throw new SqlError(res.status >= 500 ? 'network' : 'other', `Database error ${res.status}: ${text}`)
      }
      const body = await res.json() as { baton: string | null; base_url: string | null; results: HResult[] }
      return { results: body.results, baton: body.baton, base: body.base_url ? body.base_url.replace(/\/+$/, '') : base }
    }
  }

  private static ok(r: HResult): HStmtResult {
    if (r.type === 'error') throw sqlError(r.error.message, r.error.code)
    return r.response.result as HStmtResult
  }

  async run(stmts: Stmt[]): Promise<SqlResult[]> {
    if (!stmts.length) return []
    const readOnly = stmts.every((s) => /^\s*(SELECT|PRAGMA|WITH)\b/i.test(s.sql))
    const { results } = await this.pipeline([FK_ON, ...stmts.map(exec), { type: 'close' }], null, this.base, readOnly)
    return results.slice(1, 1 + stmts.length).map((r) => result(HranaDriver.ok(r)))
  }

  async script(sql: string) {
    const { results } = await this.pipeline([FK_ON, { type: 'sequence', sql }, { type: 'close' }], null)
    const r = results[1]
    if (r?.type === 'error') throw sqlError(r.error.message, r.error.code)
  }

  /** BEGIN IMMEDIATE; each statement only if the one before worked; COMMIT; else ROLLBACK — one request. */
  async batch(stmts: Stmt[]): Promise<SqlResult[]> {
    if (!stmts.length) return []
    const steps: { stmt: { sql: string; args?: HValue[] }; condition?: unknown }[] = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }]
    stmts.forEach((s, i) => steps.push({ stmt: { sql: s.sql, args: (s.args ?? []).map(toH) }, condition: { type: 'ok', step: i } }))
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: stmts.length } })
    steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: stmts.length + 1 } } })
    const { results } = await this.pipeline([FK_ON, { type: 'batch', batch: { steps } }, { type: 'close' }], null)
    const r = results[1]
    if (r.type === 'error') throw sqlError(r.error.message, r.error.code)
    const br = r.response.result as { step_results: (HStmtResult | null)[]; step_errors: ({ message: string; code?: string } | null)[] }
    const err = br.step_errors.find((e) => e)
    if (err) throw sqlError(err.message, err.code)
    return br.step_results.slice(1, 1 + stmts.length).map((x) => result(x!))
  }

  async begin(): Promise<SqlTx> {
    const first = await this.pipeline([FK_ON, { type: 'execute', stmt: { sql: 'BEGIN IMMEDIATE' } }], null, this.base, true)
    const begun = first.results[1]
    if (begun?.type === 'error') {
      if (first.baton) await this.pipeline([{ type: 'close' }], first.baton, first.base).catch(() => {})
      throw sqlError(begun.error.message, begun.error.code)
    }
    let baton = first.baton, base = first.base, done = false
    const send = async (requests: HRequest[]) => {
      if (done) throw new SqlError('other', 'Transaction already finished')
      const r = await this.pipeline(requests, baton, base)
      baton = r.baton; base = r.base
      return r.results
    }
    const finish = async (sql: 'COMMIT' | 'ROLLBACK') => {
      if (done) return
      const results = await send([{ type: 'execute', stmt: { sql } }, { type: 'close' }])
      done = true
      if (results[0]?.type === 'error') throw sqlError(results[0].error.message, results[0].error.code)
    }
    return {
      run: async (stmts) => (stmts.length ? (await send(stmts.map(exec))).map((r) => result(HranaDriver.ok(r))) : []),
      script: async (sql) => { const [r] = await send([{ type: 'sequence', sql }]); if (r?.type === 'error') throw sqlError(r.error.message, r.error.code) },
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK').catch(() => { done = true }),
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
