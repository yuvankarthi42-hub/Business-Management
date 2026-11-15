// The HTTP layer, with no web framework in it: the same code answers on Catalyst (through Express, app.ts) and on
// Cloudflare (a Worker, worker/index.ts). One route does the work: POST /rpc/<namespace>.<method> with
// { args: [...] } → { data } or { error }. Auth, branch access, read-only / support-view rules and permissions are
// all checked here, before any handler runs — so changing a request in the browser can never reach another
// business or branch. Each host only turns its own request into an HttpRequest and the HttpResponse back.
import { Ctx, type Env, type SupportClaim } from '../core/context'
import { GZIP_ACTIONS, jsonTextReply, type Gzip } from '../core/gzipReply'
import { adminCan } from '@/core/adminRoles'
import type { AdminRole } from '@/core/types'
import { E, nameOf, str } from '../domain/util'
import { ApiError } from '../core/errors'
import { resolveClientIp, setupKeyOk } from '../core/clientIp'
import { checkArgs, handler, handlerNames, type Handler } from '../core/registry'
import { verifyToken } from '../core/tokens'
import { assertAccount } from '../core/account'
import { DuplicateError, type Row } from '../db/types'
import { featureFlagsFor, loadSession, type AdminClaims, type UserClaims } from '../domain/session'
import { loadAdmin } from '../modules/admin/auth'
import '../modules'
import { checkSchema } from '../modules/admin/schema'
import { touchActivity } from '../domain/directory'
import { moduleOffError, moduleOffRead } from '@/core/moduleGuards'
import { FEATURE_ACTIONS, featureOffAction, featureOn } from '@/core/features'
import { afterOrderWrite } from '../domain/tracking'
import { bumpBoard, bumpMenu } from '../domain/menuCache'
import { RawJson } from '../core/rawJson'
import { bumpReports } from '../domain/reportCache'
import { bumpCustomerStats } from '../domain/statsCache'
import { moduleOn } from '../domain/util'
import { flushEvents, orderIdsFor, recordsFor } from '../events/publish'
import type { HubEvent } from '../events/hub'
import { ALL_BRANCHES } from '../core/context'
import { checkMediaLink, contentTypeOf } from '../core/media'

export const API_VERSION = '1.0.0'

/** One request, as every host hands it over. `path` is below the API's address ("/rpc/orders.checkout"). */
export interface HttpRequest {
  method: string
  path: string
  /** Query string values (as the host parsed them). */
  query: Record<string, unknown>
  /** A request header (any case). */
  header(name: string): string | undefined
  /** The body, already read: the parsed JSON object (text/plain bodies are JSON too); undefined = none. */
  body: unknown
  /** The network peer's address (Catalyst / local: the socket; Worker: none). */
  peer?: string | null
  /** The host's own request object (Catalyst needs it to start its SDK). */
  raw?: unknown
}

/**
 * The answer. `send`: a JSON / text answer (Express sends it with res.send, as before — same type, length, ETag);
 * `end`: raw bytes with exactly these headers (files); `empty`: status only.
 */
export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string | Uint8Array | null
  kind: 'send' | 'end' | 'empty'
}

export interface CoreOptions {
  envFor(req: HttpRequest): Env
  gzip: Gzip
  /** process.env by default (the Worker copies its settings into it at start). */
  allowedOrigins?: string
}

/** The admin behind a support view is still active, may open support views, and hasn't been signed out since. */
async function supportAdminOk(c: Ctx, sup: SupportClaim): Promise<boolean> {
  if (!/^\d{1,20}$/.test(String(sup.adminId ?? ''))) return false
  const a = await c.platform.get('platform_admins', String(sup.adminId))
  if (!a || a.is_active === false) return false
  if (!adminCan(nameOf(E.AdminRole, a.role) as AdminRole, 'customers.support')) return false
  return sup.atv === undefined || Number(a.token_version ?? 1) === Number(sup.atv)
}

/** The only actions a session may use until it sets a new password after a support reset. */
const SET_PASSWORD_OK = new Set(['auth.me', 'auth.boot', 'auth.checkPassword', 'auth.changePassword', 'auth.setLanguage'])

/** Writes that can change a customer's totals (dues, purchases, last visit). */
const CUSTOMER_WRITES = /^(orders|payments|returns|customers|points|public)\./

/** Writes that only add or move today's work (never change a finished day's report). Everything else bumps it. */
const TODAY_ONLY = /^(orders\.(save|checkout|sendToKitchen|setFulfilment|transferTable|mergeTables)|kitchen\.|qr\.|tables\.|public\.|events\.|auth\.|sync\.)/

/** Actions that change what a QR menu / TV board shows (its cached copy is refreshed). */
const MENU_WRITES = /^(products|categories|specials|tables|branches|business|stock|purchases|returns)\./
/** Settings writes (they may switch QR ordering or specials on) always refresh the public copies. */
const SETTINGS_WRITES = /^(business|branches)\./
/** Something public to refresh: the QR menu (QR ordering) or the TV board (specials). Neither on → no cache work. */
const publicCopies = (name: string, c: Ctx) => SETTINGS_WRITES.test(name) || moduleOn(c, 'qrOrdering') || moduleOn(c, 'specials')
// A bill's stock change matters only when an item sold out (or came back): the menu shows no stock numbers.
const menuChanged = (name: string, c: Ctx) => (MENU_WRITES.test(name) || (!!c.effects.stock?.length && c.soldOutChanged)) && publicCopies(name, c)
/** What the TV specials board shows: the specials, their products, the shop's name / logo / settings (no stock). */
const BOARD_WRITES = /^(products|specials|branches|business)\./
const boardChanged = (name: string, c: Ctx) => BOARD_WRITES.test(name) && (SETTINGS_WRITES.test(name) || moduleOn(c, 'specials'))
/** Order tracking (QR customers' tracking screen, "Notify me") exists only with QR ordering on. */
const tracks = (name: string, c: Ctx) => TRACKING_WRITES.test(name) && moduleOn(c, 'qrOrdering')

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
    if (tracks(name, c)) {
      if (records) for (const o of records.orders) list.push({ kind: 'order', shop, branch: o.branchId, orderId: o.id })
      else if (await c.shared.get(`trk:open:${shop}`)) {
        for (const id of await orderIdsFor(c, name, args, data).catch(() => [] as string[])) list.push({ kind: 'order', shop, branch: null, orderId: id })
      }
    }
    if (menuChanged(name, c)) list.push({ kind: 'menu', shop, branch: null })
  }
  await flushEvents(c, list)
}

/**
 * The shop's newest change-feed number (one row read), sent with every signed-in answer. A busy counter then knows
 * nothing changed on other devices without asking the change feed on its timer (src/data/remote/sync.ts).
 * `own` = the change this request made, so the counter doesn't mistake its own bill for another device's.
 * One database per shop only (the Catalyst Data Store has no change feed).
 */
async function feedNote(c: Ctx, h: Handler, name: string, atStart: Promise<number | null> | null) {
  if (h.access !== 'user' || !c.hasShop || !c.dbs.perShop || name === 'sync.changes' || !c.session) return null
  try {
    // Read with the session check at the start of the request (same round trip). A change this request made is
    // newer: the note gives the larger one. Another device's change after the start shows in the next answer.
    const start = atStart ? await atStart : null
    let latest = start
    if (latest === null) { const [r] = await c.db.sql!('SELECT "id" FROM "change_log" ORDER BY "id" DESC LIMIT 1'); latest = Number(r?.id ?? 0) }
    return { latest: Math.max(latest, c.changeId ?? 0), epoch: c.epoch, own: c.changeId }
  } catch { return null }
}
/** The shop's newest change number, read now (it goes out with the session check: one round trip). */
const latestChange = (c: Ctx): Promise<number | null> =>
  c.db.sql!('SELECT "id" FROM "change_log" ORDER BY "id" DESC LIMIT 1').then((r) => Number(r[0]?.id ?? 0), () => null)

/** Actions that can change what a customer's tracking screen shows. */
const TRACKING_WRITES = /^(orders|payments|kitchen|qr|tables|returns)\./

const json = (status: number, value: unknown): HttpResponse => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(value), kind: 'send' })
const forbidden = () => json(403, { error: { message: 'Not allowed', code: 'FORBIDDEN' } })

/**
 * The request handler. Returns null for an address it doesn't answer (the host's own "not found" then, as before).
 * Every answer gets nosniff, and the CORS headers when the caller's origin is listed (ALLOWED_ORIGINS).
 */
export function createHandler(opts: CoreOptions) {
  // The app can be hosted on another domain (Catalyst Slate, Cloudflare Pages). Only the addresses in ALLOWED_ORIGINS
  // may call the API. Each address also allows its twin in the other Catalyst data centre (.in ⇄ .com), so one entry
  // covers both. (Safe to allow: requests carry the sign-in token in the body or a header, never cookies.)
  const listed = (opts.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
  const twin = (o: string) => o.replace(/\.(onslate|catalystserverless|catalystappsail|zohostratus)\.(in|com)$/, (_m, d: string, t: string) => `.${d}.${t === 'in' ? 'com' : 'in'}`)
  const origins = [...new Set([...listed, ...listed.map(twin)])]

  /** nosniff on every answer, and the CORS headers when the caller's origin is listed. */
  const commonHeaders = (req: HttpRequest): Record<string, string> => {
    // Answers are JSON (or files with their own type): browsers must never guess another type from the content.
    const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' }
    const o = req.header('origin')
    if (o && origins.includes(o)) {
      headers['Access-Control-Allow-Origin'] = o
      headers.Vary = 'Origin'
      headers['Access-Control-Allow-Headers'] = 'content-type, authorization, x-branch, x-request-id, x-device'
      headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
      headers['Access-Control-Max-Age'] = '86400'
    }
    return headers
  }
  // The route's own headers win (a gzipped answer's "Vary: Accept-Encoding" replaces the CORS one, as before).
  const withCommon = (req: HttpRequest, res: HttpResponse): HttpResponse => ({ ...res, headers: { ...commonHeaders(req), ...res.headers } })

  /** The CORS pre-check: 204 for a listed origin, else 403. */
  const preflight = (req: HttpRequest): HttpResponse => { const o = req.header('origin'); return withCommon(req, { status: o && origins.includes(o) ? 204 : 403, headers: {}, body: null, kind: 'empty' }) }

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.method === 'OPTIONS') return preflight(req)
    const res = await route(req)
    return res ? withCommon(req, res) : null
  }
  return { handle, commonHeaders, preflight }

  async function route(req: HttpRequest): Promise<HttpResponse | null> {
    const get = req.method === 'GET' || req.method === 'HEAD'
    const path = req.path

    if (get && /^\/(health\/?)?$/i.test(path)) return json(200, { ok: true, version: API_VERSION, handlers: handlerNames().length })

    // First-time setup only: GET /schema-check with header x-setup-key = SETUP_KEY → which tables / columns are missing.
    if (get && /^\/schema-check\/?$/i.test(path)) {
      if (!setupKeyOk(req.header('x-setup-key'))) return forbidden()
      try { const env = opts.envFor(req); await assertAccount(await env.dbs.platform()); return json(200, { data: await checkSchema(env) }) }
      catch (e) { return json(500, { error: { message: (e as Error).message, code: 'SERVER_ERROR' } }) }
    }

    // After a deploy that adds a migration: POST /migrate with header x-setup-key → every database up to date.
    // (Shop databases are also brought up to date on their first request, so this is optional.)
    if (req.method === 'POST' && /^\/migrate\/?$/i.test(path)) {
      if (!setupKeyOk(req.header('x-setup-key'))) return forbidden()
      try { const env = opts.envFor(req); await assertAccount(await env.dbs.platform()); return json(200, { data: await env.dbs.migrateAll() }) }
      catch (e) { return json(500, { error: { message: (e as Error).message, code: 'SERVER_ERROR' } }) }
    }

    // After a deploy: GET /ip-check with x-setup-key (and a made-up X-Forwarded-For) → which address rate limits use.
    // The answer must be your real address, not the made-up one (core/clientIp.ts).
    if (get && /^\/ip-check\/?$/i.test(path)) {
      if (!setupKeyOk(req.header('x-setup-key'))) return forbidden()
      const { ip, via } = resolveClientIp(ipReq(req))
      return json(200, { data: { ip, via, source: process.env.CLIENT_IP_SOURCE || 'default', forwardedFor: req.header('x-forwarded-for') ?? null, peer: req.peer ?? null } })
    }

    // Private files (support screenshots): only through a signed link that is still valid (core/media.ts). After the
    // link's expiry, a changed key or signature, or for a file that isn't there: the same plain 404, never cached.
    const media = get ? /^\/media\/(p\/.+)$/.exec(path) : null
    if (media) {
      const key = media[1]
      const deny = (): HttpResponse => ({ status: 404, headers: { 'Cache-Control': 'no-store' }, body: null, kind: 'empty' })
      if (!checkMediaLink(key, req.query.e, req.query.s)) return deny()
      try {
        const body = await opts.envFor(req).files.getPrivate(key)
        if (!body) return deny()
        return {
          status: 200, kind: 'end', body,
          headers: { 'Content-Type': contentTypeOf(key), 'Cache-Control': 'private, max-age=1800', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' },
        }
      } catch { return deny() }
    }

    const rpc = req.method === 'POST' ? /^\/rpc\/([^/]+)\/?$/i.exec(path) : null
    if (rpc) {
      let name: string
      try { name = decodeURIComponent(rpc[1]) } catch { return null }
      return rpcCall(req, name)
    }
    return null
  }

  async function rpcCall(req: HttpRequest, name: string): Promise<HttpResponse> {
    const h = handler(name)
    if (!h) return json(404, { error: { message: `Unknown action ${name}`, code: 'NOT_FOUND' } })
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { args?: unknown; h?: unknown }
    try {
      const env = opts.envFor(req)
      const meta = (body.h && typeof body.h === 'object' && body.h) as Record<string, unknown> || {}
      const hdr = (name: string) => req.header(name) ?? (typeof meta[name] === 'string' ? (meta[name] as string) : undefined)
      const platform = await env.dbs.platform()
      // This server's ACCOUNT_ID must be the one its platform database belongs to (separate Catalyst / Cloudflare setups).
      await assertAccount(platform)
      const c = new Ctx(env, platform, (hdr('x-request-id') ?? '').slice(0, 40) || null)
      const device = (hdr('x-device') ?? '').trim()
      c.origin = /^[A-Za-z0-9_-]{6,40}$/.test(device) ? device : null
      const loginDevice = (hdr('x-login-device') ?? '').trim()
      c.loginDevice = /^[A-Za-z0-9_-]{43}$/.test(loginDevice) ? loginDevice : null
      c.ip = resolveClientIp(ipReq(req)).ip.slice(0, 64)
      let feedAtStart: Promise<number | null> | null = null
      const token = (hdr('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const claims = verifyToken<Record<string, unknown>>(token)
      if (h.access === 'user') {
        if (!claims || claims.t !== 'u') throw new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
        await openShop(c, String(claims.bid))
        if (c.dbs.perShop && name !== 'sync.changes' && c.db.sql) feedAtStart = latestChange(c)
        c.session = await loadSession(c, claims as unknown as UserClaims, hdr('x-branch') ?? undefined)
        if (!c.session) throw new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
        // Support view: only while that admin is still active, still allowed support views, and not signed out.
        if (c.session.support && !(await supportAdminOk(c, c.session.support))) throw new ApiError('The support view has ended. Open it again from the admin panel.', 401, 'UNAUTHORIZED')
        if (h.write) c.assertWritable({ readOnlyOk: h.readOnlyOk })
        else if (c.session.business.status === 'deactivated' && !c.session.support) throw new ApiError('This account has been deactivated. Please contact the product admin.', 403, 'DEACTIVATED')
        // After product support reset the password: nothing but setting a new one (and reading who you are).
        if (claims.pwc) {
          c.mustSetPassword = true
          if (!SET_PASSWORD_OK.has(name)) throw new ApiError('Support reset your password. Set a new password to continue.', 403, 'PASSWORD_CHANGE_REQUIRED')
        }
        if (h.perm) c.requirePerm(h.perm)
        if (h.anyPerm && !h.anyPerm.some((p) => c.can(p))) throw new ApiError('You don’t have permission to do this', 403, 'FORBIDDEN')
        // A feature the product admin hasn't released to this customer: never runs (core/features.ts).
        const notReleased = featureOffAction(name, c.session.features)
        if (notReleased && 'error' in notReleased) throw new ApiError(notReleased.error, 403, 'FEATURE_OFF')
        if (notReleased) { await c.finish(true); return json(200, { data: notReleased.empty }) }
        // A module switched off in Settings → Modules: its actions make no new entries (core/moduleGuards.ts).
        if (h.write) { const off = moduleOffError(name, c.session.business.modules); if (off) throw new ApiError(off, 403, 'MODULE_OFF') }
        // …and its reads touch no database: lists answer empty, the rest are refused.
        else {
          const off = moduleOffRead(name, c.session.business.modules)
          if (off && 'error' in off) throw new ApiError(off.error, 403, 'MODULE_OFF')
          if (off) { await c.finish(true); return json(200, { data: off.empty }) }
        }
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
      // Arguments of the wrong kind (a missing object, text where a list belongs…): refused before the handler runs.
      const args = checkArgs(h.args, Array.isArray(body.args) ? body.args : [])
      if (!args) throw new ApiError('Check the request', 400, 'BAD_REQUEST')
      // Customer QR actions (order, tracking) of a shop that doesn't have QR Orders released: refused before any shop read.
      if (h.access === 'public' && FEATURE_ACTIONS[name] && !featureOn(await featureFlagsFor(c), FEATURE_ACTIONS[name].feature, String(args[0] ?? ''))) {
        throw new ApiError('Online ordering is not available right now', 403, 'FEATURE_OFF')
      }
      if (h.write && h.access !== 'admin' && !h.quiet) c.changeName = name
      let data: unknown
      try { data = await run(c, h, args, name) } catch (e) { await c.finish(false); throw e }
      await c.finish(true)
      if (h.write && h.access !== 'admin' && c.hasShop) {
        // Writes without a transaction still tell the other devices (one extra small write).
        await c.logChange().catch((e) => console.error(`[${name}] change feed`, e))
        // The copies below don't depend on one another: they are refreshed at the same moment (their cache writes go
        // out together — one round trip), each still on its own (one failing never stops another, as before).
        const shopId = c.shopId
        await Promise.all([
          // Customers' tracking screens: their cached status is stale now; send "Notify me" pushes.
          tracks(name, c) ? afterOrderWrite(c).catch((e) => console.error(`[${name}] tracking`, e)) : null,
          // Customers' cached totals: bills, payments, returns, points and customer edits change them.
          CUSTOMER_WRITES.test(name) && shopId ? bumpCustomerStats(c, shopId).catch((e) => console.error(`[${name}] stats cache`, e)) : null,
          // Cached reports of finished days: anything but today's new sales may change them.
          !TODAY_ONLY.test(name) && shopId ? bumpReports(c, shopId).catch((e) => console.error(`[${name}] report cache`, e)) : null,
          // QR menu / TV board copies are stale now (catalogue, settings, or stock changed by a bill).
          menuChanged(name, c) && shopId ? bumpMenu(c, shopId).catch((e) => console.error(`[${name}] menu cache`, e)) : null,
          boardChanged(name, c) && shopId ? bumpBoard(c, shopId).catch((e) => console.error(`[${name}] board cache`, e)) : null,
          c.session ? touchActivity(c) : null,
        ])
      }
      if (c.events) await sendEvents(c, h, name, args, data)
      const feed = await feedNote(c, h, name, feedAtStart)
      const rest = { ...(Object.keys(c.effects).length ? { effects: c.effects } : {}), ...(feed ? { feed } : {}) }
      // A cached copy that is already JSON text (QR menu, TV board): written as it is — the same bytes res.json would send.
      if (data instanceof RawJson) { const more = JSON.stringify(rest); return jsonText(req, name, `{"data":${data.text}${more === '{}' ? '' : `,${more.slice(1, -1)}`}}`) }
      // The customers' QR menu answers go gzipped (core/gzipReply.ts); every other answer as before.
      if (GZIP_ACTIONS.has(name)) return jsonText(req, name, JSON.stringify({ data: data === undefined ? null : data, ...rest }))
      return json(200, { data: data === undefined ? null : data, ...rest })
    } catch (e) {
      if (e instanceof ApiError) return json(e.status, { error: { message: e.message, code: e.code } })
      if (e instanceof DuplicateError) return json(409, { error: { message: 'This already exists — it may have been saved on another device. Refresh and check.', code: 'DUPLICATE' } })
      console.error(`[${name}]`, e)
      return json(500, { error: { message: 'Something went wrong on the server. Please try again.', code: 'SERVER_ERROR' } })
    }
  }

  /** A JSON text answer, gzipped for the QR menu actions when the browser accepts it. */
  async function jsonText(req: HttpRequest, name: string, text: string): Promise<HttpResponse> {
    const r = await jsonTextReply(req.header('accept-encoding'), name, text, opts.gzip)
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (r.gz) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding' }
    return { status: 200, headers, body: r.body, kind: 'send' }
  }
}

/** What resolveClientIp reads: the headers and the socket peer. */
const ipReq = (req: HttpRequest) => ({ header: (n: string) => req.header(n), socket: { remoteAddress: req.peer ?? null } })

/** The handler, inside the transaction its `tx` option asks for. */
async function run(c: Ctx, h: Handler, args: unknown[], name: string) {
  const mode = h.tx ?? (h.write && h.access !== 'public' ? 'auto' : 'none')
  if (!h.write || mode !== 'auto') return h.run(c, ...args)
  if (h.access === 'admin') return c.platformTx(() => h.run(c, ...args))
  if (!h.once || !c.requestId || !c.hasShop) return c.tx(() => h.run(c, ...args))
  // Saved once per request id: the first answer is kept with the change, in the same transaction.
  const key = `${c.businessId}:${c.requestId}`.slice(0, 80)
  try {
    return await c.tx(async () => {
      const done = await c.db.first('request_log', { uniq_key: key })
      if (done) { c.changeName = null; return replay(done, name) } // nothing changed: no change-feed entry
      const data = await h.run(c, ...args)
      const json = JSON.stringify(data === undefined ? null : data)
      await c.db.insert('request_log', { business_id: c.businessId, uniq_key: key, name, answer_json: json.length <= ANSWER_MAX ? json : null })
      return data
    })
  } catch (e) {
    // The same request arrived twice at the same moment: the other copy saved it first — answer as it did.
    if (e instanceof DuplicateError) { const done = await c.db.first('request_log', { uniq_key: key }); if (done) { c.changeName = null; return replay(done, name) } }
    throw e
  }
}
/** The kept answer has to fit a Data Store text column. */
const ANSWER_MAX = 9_000
/** A request already saved: its answer again (nothing runs or saves). */
function replay(done: Row, name: string) {
  if (str(done.name) !== name) throw new ApiError('Duplicate request', 409)
  if (done.answer_json == null) throw new ApiError('This was already saved. Refresh to see it.', 409, 'DUPLICATE')
  return JSON.parse(str(done.answer_json)) as unknown
}

/** A token for a shop whose database is gone (customer deleted) means: sign in again. */
async function openShop(c: Ctx, businessId: string) {
  try { await c.useShop(businessId) } catch (e) {
    if (e instanceof ApiError && (e.code === 'NO_SHOP_DB' || e.code === 'NOT_FOUND')) throw new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
    throw e
  }
}
