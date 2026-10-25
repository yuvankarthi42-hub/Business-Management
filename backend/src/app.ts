// The HTTP layer. One route: POST /rpc/<namespace>.<method> with { args: [...] } → { data } or { error }.
// Auth, branch access, read-only / support-view rules and permissions are all checked here, before any
// handler runs — so changing a request in the browser can never reach another business or branch.
import express, { type Request, type Response } from 'express'
import { Ctx, type Env } from './core/context'
import { ApiError } from './core/errors'
import { handler, handlerNames, type Handler } from './core/registry'
import { verifyToken } from './core/tokens'
import { DuplicateError } from './db/types'
import { loadSession, type AdminClaims, type UserClaims } from './domain/session'
import { loadAdmin } from './modules/admin/auth'
import './modules'
import { checkSchema } from './modules/admin/schema'
import { touchActivity } from './domain/directory'
import { afterOrderWrite } from './domain/tracking'
import { bumpMenu } from './domain/menuCache'
import { bumpReports } from './domain/reportCache'
import { bumpCustomerStats } from './domain/statsCache'
import { flushEvents, orderIdsFor, recordsFor } from './events/publish'
import type { HubEvent } from './events/hub'
import { ALL_BRANCHES } from './core/context'

/** Writes that can change a customer's totals (dues, purchases, last visit). */
const CUSTOMER_WRITES = /^(orders|payments|returns|customers|points|public)\./

/** Writes that only add or move today's work (never change a finished day's report). Everything else bumps it. */
const TODAY_ONLY = /^(orders\.(save|checkout|sendToKitchen|setFulfilment|transferTable|mergeTables)|kitchen\.|qr\.|tables\.|public\.|events\.|auth\.|sync\.)/

/** Actions that change what a QR menu / TV board shows (its cached copy is refreshed). */
const MENU_WRITES = /^(products|categories|specials|tables|branches|business|stock|purchases|returns)\./
const menuChanged = (name: string, c: Ctx) => MENU_WRITES.test(name) || !!c.effects.stock?.length

/** After a saved write: tell open screens (event hub). Only when the hub is set up; never fails the request. */
async function sendEvents(c: Ctx, h: Handler, name: string, args: unknown[], data: unknown) {
  const list: HubEvent[] = c.takeEvents()
  if (h.write && h.access !== 'admin' && !h.quiet && c.hasShop && c.shopId) {
    const shop = c.shopId
    const branch = c.session && c.session.branchId !== ALL_BRANCHES ? c.session.branchId : null
    // The changed orders / tickets are read only when staff screens of this shop are open (they'd use them).
    const screens = !!(await c.shared.get(`live:${shop}`))
    const records = screens ? await recordsFor(c, name, args, data).catch((e) => { console.error(`[${name}] event records`, e); return undefined }) : undefined
    list.push({ kind: 'change', shop, branch: records?.orders[0]?.branchId ?? branch, name, origin: c.origin, cid: c.changeId, ...(records ? { records } : {}) })
    // Customers following these orders (tracking page): "your order changed" (no data — they ask the cache).
    if (TRACKING_WRITES.test(name)) {
      if (records) for (const o of records.orders) list.push({ kind: 'order', shop, branch: o.branchId, orderId: o.id })
      else if (await c.shared.get(`trk:open:${shop}`)) {
        for (const id of await orderIdsFor(c, name, args, data).catch(() => [] as string[])) list.push({ kind: 'order', shop, branch: null, orderId: id })
      }
    }
    if (menuChanged(name, c)) list.push({ kind: 'menu', shop, branch: null })
  }
  await flushEvents(c, list)
}

/** Actions that can change what a customer's tracking screen shows. */
const TRACKING_WRITES = /^(orders|payments|kitchen|qr|tables|returns)\./

export type { Env }
export const API_VERSION = '1.0.0'

export function createApp(envFor: (req: Request) => Env) {
  const app = express()
  app.disable('x-powered-by')
  // The app can be hosted on another domain (Catalyst Slate). Only the addresses in ALLOWED_ORIGINS may call the API.
  // Each address also allows its twin in the other Catalyst data centre (.in ⇄ .com), so one entry covers both.
  // (Safe to allow: requests carry the sign-in token in the body, never cookies.)
  const listed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
  const twin = (o: string) => o.replace(/\.(onslate|catalystserverless|catalystappsail|zohostratus)\.(in|com)$/, (_m, d: string, t: string) => `.${d}.${t === 'in' ? 'com' : 'in'}`)
  const origins = [...new Set([...listed, ...listed.map(twin)])]
  app.use((req, res, next) => {
    const o = req.header('origin')
    if (o && origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-branch, x-request-id, x-device')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Max-Age', '86400')
    }
    if (req.method === 'OPTIONS') { res.status(o && origins.includes(o) ? 204 : 403).end(); return }
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

  app.get(['/health', '/'], (_req, res) => { res.json({ ok: true, version: API_VERSION, handlers: handlerNames().length }) })

  // First-time setup only: GET /schema-check with header x-setup-key = SETUP_KEY → which tables / columns are missing.
  app.get('/schema-check', async (req, res) => {
    const want = process.env.SETUP_KEY
    if (!want || want.length < 16 || req.header('x-setup-key') !== want) { res.status(403).json({ error: { message: 'Not allowed', code: 'FORBIDDEN' } }); return }
    try { res.json({ data: await checkSchema(envFor(req)) }) }
    catch (e) { res.status(500).json({ error: { message: (e as Error).message, code: 'SERVER_ERROR' } }) }
  })

  // After a deploy that adds a migration: POST /migrate with header x-setup-key → every database up to date.
  // (Shop databases are also brought up to date on their first request, so this is optional.)
  app.post('/migrate', async (req, res) => {
    const want = process.env.SETUP_KEY
    if (!want || want.length < 16 || req.header('x-setup-key') !== want) { res.status(403).json({ error: { message: 'Not allowed', code: 'FORBIDDEN' } }); return }
    try { res.json({ data: await envFor(req).dbs.migrateAll() }) }
    catch (e) { res.status(500).json({ error: { message: (e as Error).message, code: 'SERVER_ERROR' } }) }
  })

  app.post('/rpc/:name', async (req: Request, res: Response) => {
    const name = req.params.name
    const h = handler(name)
    if (!h) { res.status(404).json({ error: { message: `Unknown action ${name}`, code: 'NOT_FOUND' } }); return }
    try {
      const env = envFor(req)
      const meta = (req.body && typeof req.body.h === 'object' && req.body.h) || {}
      const hdr = (name: string) => req.header(name) ?? (typeof meta[name] === 'string' ? (meta[name] as string) : undefined)
      const c = new Ctx(env, await env.dbs.platform(), (hdr('x-request-id') ?? '').slice(0, 40) || null)
      const device = (hdr('x-device') ?? '').trim()
      c.origin = /^[A-Za-z0-9_-]{6,40}$/.test(device) ? device : null
      c.ip = String(req.header('x-forwarded-for') ?? req.ip ?? '').split(',')[0].trim().slice(0, 64)
      const token = (hdr('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const claims = verifyToken<Record<string, unknown>>(token)
      if (h.access === 'user') {
        if (!claims || claims.t !== 'u') throw new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
        await openShop(c, String(claims.bid))
        c.session = await loadSession(c, claims as unknown as UserClaims, hdr('x-branch') ?? undefined)
        if (!c.session) throw new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
        if (h.write) c.assertWritable({ readOnlyOk: h.readOnlyOk })
        else if (c.session.business.status === 'deactivated' && !c.session.support) throw new ApiError('This account has been deactivated. Please contact the product admin.', 403, 'DEACTIVATED')
        if (h.perm) c.requirePerm(h.perm)
      } else if (h.access === 'admin') {
        if (!claims || claims.t !== 'a') throw new ApiError('Product admin sign-in required', 401, 'UNAUTHORIZED')
        c.admin = await loadAdmin(c, claims as unknown as AdminClaims)
        if (!c.admin) throw new ApiError('Product admin sign-in required', 401, 'UNAUTHORIZED')
        c.requireAdmin(h.adminPerm)
      } else if (claims?.t === 'u') {
        // Public actions (QR menu) may still know the signed-in user, but never need one.
        try {
          await openShop(c, String(claims.bid))
          c.session = await loadSession(c, claims as unknown as UserClaims, hdr('x-branch') ?? undefined)
        } catch { c.session = null }
      }
      const args = Array.isArray(req.body?.args) ? req.body.args : []
      if (h.write && h.access !== 'admin' && !h.quiet) c.changeName = name
      let data: unknown
      try { data = await run(c, h, args) } catch (e) { await c.finish(false); throw e }
      await c.finish(true)
      if (h.write && h.access !== 'admin' && c.hasShop) {
        // Writes without a transaction still tell the other devices (one extra small write).
        await c.logChange().catch((e) => console.error(`[${name}] change feed`, e))
        // Customers' tracking screens: their cached status is stale now; send "Notify me" pushes.
        if (TRACKING_WRITES.test(name)) await afterOrderWrite(c).catch((e) => console.error(`[${name}] tracking`, e))
        // Customers' cached totals: bills, payments, returns, points and customer edits change them.
        if (CUSTOMER_WRITES.test(name) && c.shopId) await bumpCustomerStats(c, c.shopId).catch((e) => console.error(`[${name}] stats cache`, e))
        // Cached reports of finished days: anything but today's new sales may change them.
        if (!TODAY_ONLY.test(name) && c.shopId) await bumpReports(c, c.shopId).catch((e) => console.error(`[${name}] report cache`, e))
        // QR menu / TV board copies are stale now (catalogue, settings, or stock changed by a bill).
        if (menuChanged(name, c) && c.shopId) await bumpMenu(c, c.shopId).catch((e) => console.error(`[${name}] menu cache`, e))
        if (c.session) await touchActivity(c)
      }
      if (c.events) await sendEvents(c, h, name, args, data)
      res.json({ data: data === undefined ? null : data, ...(Object.keys(c.effects).length ? { effects: c.effects } : {}) })
    } catch (e) {
      if (e instanceof ApiError) { res.status(e.status).json({ error: { message: e.message, code: e.code } }); return }
      if (e instanceof DuplicateError) { res.status(409).json({ error: { message: 'This already exists — it may have been saved on another device. Refresh and check.', code: 'DUPLICATE' } }); return }
      console.error(`[${name}]`, e)
      res.status(500).json({ error: { message: 'Something went wrong on the server. Please try again.', code: 'SERVER_ERROR' } })
    }
  })

  return app
}

/** The handler, inside the transaction its `tx` option asks for. */
function run(c: Ctx, h: Handler, args: unknown[]) {
  const mode = h.tx ?? (h.write && h.access !== 'public' ? 'auto' : 'none')
  if (!h.write || mode !== 'auto') return h.run(c, ...args)
  return h.access === 'admin' ? c.platformTx(() => h.run(c, ...args)) : c.tx(() => h.run(c, ...args))
}

/** A token for a shop whose database is gone (customer deleted) means: sign in again. */
async function openShop(c: Ctx, businessId: string) {
  try { await c.useShop(businessId) } catch (e) {
    if (e instanceof ApiError && (e.code === 'NO_SHOP_DB' || e.code === 'NOT_FOUND')) throw new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
    throw e
  }
}
