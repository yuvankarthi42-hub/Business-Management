// The Express host (Catalyst Advanced I/O, the local dev server, the tests): turns an Express request into the
// framework-free HttpRequest that http/core.ts answers, and writes the answer back exactly as before — the same
// body parsers and limits, nosniff / CORS on every answer (also on parser errors), res.send for JSON (same type,
// length and ETag), res.end for files. Express's own "not found" for any other address.
import express, { type NextFunction, type Request, type Response } from 'express'
import { gzipSync } from 'node:zlib'
import type { Env } from './core/context'
import { API_VERSION, createHandler, type HttpRequest, type HttpResponse } from './http/core'

export type { Env }
export { API_VERSION }

const gzip = (text: string) => gzipSync(text, { level: 6 })

export function createApp(envFor: (req: Request) => Env) {
  const core = createHandler({ envFor: (r) => envFor(r.raw as Request), gzip })
  const toHttp = (req: Request): HttpRequest => ({
    method: req.method, path: req.path, query: req.query as Record<string, unknown>, header: (n) => req.header(n),
    body: req.body, peer: req.socket?.remoteAddress ?? null, raw: req,
  })
  const write = (res: Response, r: HttpResponse) => {
    res.status(r.status)
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
    if (r.kind === 'empty' || r.body === null) { res.end(); return }
    const body = typeof r.body === 'string' ? r.body : Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength)
    if (r.kind === 'end') res.end(body)
    else res.send(body)
  }

  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const http = toHttp(req)
    for (const [k, v] of Object.entries(core.commonHeaders(http))) res.setHeader(k, v)
    if (req.method === 'OPTIONS') { write(res, core.preflight(http)); return }
    next()
  })
  app.use(express.json({ limit: '8mb' }))
  // "Simple" cross-site requests (no CORS pre-check, which the Catalyst gateway answers without CORS headers):
  // text/plain body {"args":[…],"h":{"authorization","x-branch","x-request-id","x-device"}}.
  app.use(express.text({ type: 'text/plain', limit: '8mb' }))
  app.use((req, _res, next) => {
    if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body) } catch { req.body = {} } }
    next()
  })
  app.use((req: Request, res: Response, next: NextFunction) => {
    core.handle(toHttp(req)).then((r) => { if (r) write(res, r); else next() }, next)
  })
  return app
}
