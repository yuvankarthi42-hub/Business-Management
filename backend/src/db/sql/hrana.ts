// Turso over HTTPS — the "Hrana over HTTP" pipeline protocol (POST <db>/v2/pipeline), with plain fetch.
// Every pipeline without a baton runs on a fresh connection, so each one starts with PRAGMA foreign_keys = ON.
// An interactive transaction keeps its connection with the baton the server returns.
import { countRequest } from '../../core/meter'
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
/** How long to keep retrying when another writer holds the lock (same as TursoDb.transaction). */
const BUSY_RETRY_MS = Number(process.env.DB_BUSY_RETRY_MS ?? 8000)

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
      countRequest()
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

  /**
   * An interactive write transaction. BEGIN is not sent on its own: it goes with the first statements in one request
   * (a batch where every statement runs only if BEGIN took the write lock — so nothing runs outside it), and the
   * last writes go with COMMIT (commitWith). A transaction that never ran a statement opens nothing at all.
   * "Busy" (another device holds the lock) is waited for and retried here, before anything has run, as before.
   */
  async begin(): Promise<SqlTx> {
    let baton: string | null = null, base = this.base, done = false, started = false
    const send = async (requests: HRequest[]) => {
      if (done) throw new SqlError('other', 'Transaction already finished')
      const r = await this.pipeline(requests, baton, base)
      baton = r.baton; base = r.base
      return r.results
    }
    const stepsOf = (stmts: Stmt[], onlyIf: (k: number) => unknown) => stmts.map((st, k) => ({ stmt: { sql: st.sql, args: (st.args ?? []).map(toH) }, condition: onlyIf(k) }))
    type Out = { ok: HStmtResult } | { error: { message: string; code?: string } }
    /** BEGIN IMMEDIATE + these statements in one request; returns each statement's result or error. */
    const start = async (stmts: Stmt[]): Promise<Out[]> => {
      const steps = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }, ...stepsOf(stmts, () => ({ type: 'ok', step: 0 }))]
      const t0 = Date.now()
      for (let attempt = 0; ; attempt++) {
        const r = await this.pipeline([FK_ON, { type: 'batch', batch: { steps } }], null, this.base, true)
        const res = r.results[1]
        if (!res || res.type === 'error') {
          if (r.baton) await this.pipeline([{ type: 'close' }], r.baton, r.base).catch(() => {})
          throw sqlError(res?.type === 'error' ? res.error.message : 'No answer to BEGIN', res?.type === 'error' ? res.error.code : undefined)
        }
        const br = res.response.result as { step_results: (HStmtResult | null)[]; step_errors: ({ message: string; code?: string } | null)[] }
        const begunErr = br.step_errors[0]
        if (begunErr) {
          // The lock wasn't taken, so nothing ran: close this connection; wait and try again while it is busy.
          if (r.baton) await this.pipeline([{ type: 'close' }], r.baton, r.base).catch(() => {})
          const e = sqlError(begunErr.message, begunErr.code)
          if (e.kind === 'busy' && Date.now() - t0 < BUSY_RETRY_MS) { await sleep(Math.min(400, 25 * 2 ** attempt) * (0.5 + Math.random())); continue }
          throw e
        }
        baton = r.baton; base = r.base; started = true
        return stmts.map((_, k) => (br.step_errors[k + 1] ? { error: br.step_errors[k + 1]! } : { ok: br.step_results[k + 1]! }))
      }
    }
    /** These statements (each on its own, like separate calls): their results or errors. */
    const exec1 = async (stmts: Stmt[]): Promise<Out[]> => {
      if (!started) return start(stmts)
      if (!stmts.length) return []
      return (await send(stmts.map(exec))).map((r) => (r.type === 'error' ? { error: r.error } : { ok: r.response.result as HStmtResult }))
    }
    const firstError = (outs: Out[]) => { const bad = outs.find((o): o is { error: { message: string; code?: string } } => 'error' in o); return bad ? sqlError(bad.error.message, bad.error.code) : null }
    const finish = async (sql: 'COMMIT' | 'ROLLBACK') => {
      if (done) return
      if (!started) { done = true; return } // nothing ran: nothing to commit or undo
      const results = await send([{ type: 'execute', stmt: { sql } }, { type: 'close' }])
      done = true
      if (results[0]?.type === 'error') throw sqlError(results[0].error.message, results[0].error.code)
    }
    return {
      run: async (stmts) => { const outs = await exec1(stmts); const e = firstError(outs); if (e) throw e; return outs.map((o) => result((o as { ok: HStmtResult }).ok)) },
      runGroups: async (groups) => {
        const outs = await exec1(groups.flat())
        let at = 0
        return groups.map((g) => { const mine = outs.slice(at, at + g.length); at += g.length; return firstError(mine) ?? mine.map((o) => result((o as { ok: HStmtResult }).ok)) })
      },
      script: async (sql) => { if (!started) await start([]); const [r] = await send([{ type: 'sequence', sql }]); if (r?.type === 'error') throw sqlError(r.error.message, r.error.code) },
      commit: () => finish('COMMIT'),
      commitWith: async (stmts) => {
        if (done) throw new SqlError('other', 'Transaction already finished')
        // Each statement only if the one before worked; COMMIT only if all did; else ROLLBACK — one request.
        const own = stmts.map((st) => ({ stmt: { sql: st.sql, args: (st.args ?? []).map(toH) } }))
        const steps: { stmt: { sql: string; args?: HValue[] }; condition?: unknown }[] = []
        const offset = started ? 0 : 1
        if (!started) steps.push({ stmt: { sql: 'BEGIN IMMEDIATE' } })
        own.forEach((st, k) => steps.push({ ...st, ...(k + offset > 0 ? { condition: { type: 'ok', step: k + offset - 1 } } : {}) }))
        const last = steps.length - 1
        steps.push({ stmt: { sql: 'COMMIT' }, ...(last >= 0 ? { condition: { type: 'ok', step: last } } : {}) })
        steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: last + 1 } } })
        const t0 = Date.now()
        for (let attempt = 0; ; attempt++) {
          const r = started ? { results: await send([{ type: 'batch', batch: { steps } }, { type: 'close' }]) } : await this.pipeline([FK_ON, { type: 'batch', batch: { steps } }, { type: 'close' }], null, this.base) /* never re-sent after a network error: it may have committed */
          const res = r.results[started ? 0 : 1]
          done = true
          if (!res || res.type === 'error') throw sqlError(res?.type === 'error' ? res.error.message : 'No answer to COMMIT', res?.type === 'error' ? res.error.code : undefined)
          const br = res.response.result as { step_results: (HStmtResult | null)[]; step_errors: ({ message: string; code?: string } | null)[] }
          if (!started && br.step_errors[0]) {
            const e = sqlError(br.step_errors[0].message, br.step_errors[0].code)
            if (e.kind === 'busy' && Date.now() - t0 < BUSY_RETRY_MS) { done = false; await sleep(Math.min(400, 25 * 2 ** attempt) * (0.5 + Math.random())); continue }
            throw e
          }
          const err = br.step_errors.slice(offset, offset + own.length + 1).find((x) => x)
          if (err) throw sqlError(err.message, err.code)
          return br.step_results.slice(offset, offset + own.length).map((x) => result(x!))
        }
      },
      rollback: () => finish('ROLLBACK').catch(() => { done = true }),
    }
  }

}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
