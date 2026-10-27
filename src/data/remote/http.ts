// Talks to the Kadai Kalanjiyam API on Zoho Catalyst: POST /server/api/rpc/<namespace>.<method> { args }.
// Only sign-in tokens and the chosen branch are kept in the browser — never data or pending changes.

export class ApiError extends Error {
  constructor(message: string, readonly code = 'ERROR', readonly status = 0) { super(message) }
}

/**
 * Where the API is. VITE_API_BASE may list several addresses (comma-separated); a Catalyst address also tries
 * its twin in the other data centre (.in ⇄ .com). The first one that answers /health is used for this tab.
 */
const CANDIDATES = (() => {
  const raw = String(import.meta.env.VITE_API_BASE ?? '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean)
  const out: string[] = []
  for (const u of raw.length ? raw : ['/server/api']) {
    out.push(u)
    const twin = u.replace(/\.catalystserverless\.(in|com)(?=[/:]|$)/, (_m, t: string) => `.catalystserverless.${t === 'in' ? 'com' : 'in'}`)
    if (twin !== u) out.push(twin)
  }
  return [...new Set(out)]
})()
const API_KEY = 'billpoodum.api'
let chosen: Promise<string> | null = null
async function probe(u: string) {
  try {
    const r = await fetch(`${u}/health`, { signal: AbortSignal.timeout(6000), credentials: 'omit' })
    return r.ok && !!((await r.json()) as { ok?: boolean }).ok
  } catch { return false }
}
function apiBase(): Promise<string> {
  if (CANDIDATES.length === 1) return Promise.resolve(CANDIDATES[0])
  chosen ??= (async () => {
    try { const s = sessionStorage.getItem(API_KEY); if (s && CANDIDATES.includes(s)) return s } catch { /* private mode */ }
    for (const u of CANDIDATES) if (await probe(u)) { try { sessionStorage.setItem(API_KEY, u) } catch { /* private mode */ } return u }
    chosen = null // nothing answered (offline?): try again on the next request
    return CANDIDATES[0]
  })()
  return chosen
}
/** After a network failure: ask again which address answers. */
function forgetBase() { chosen = null; try { sessionStorage.removeItem(API_KEY) } catch { /* private mode */ } }
const crossSite = (base: string) => { try { return new URL(base, location.href).origin !== location.origin } catch { return false } }
const KEYS = { user: 'billpoodum.token', admin: 'billpoodum.adminToken', branch: 'billpoodum.branch' } as const

const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* private mode: this tab only */ } }

export const auth = {
  get user() { return read(KEYS.user) },
  set user(v: string | null) { write(KEYS.user, v) },
  get admin() { return read(KEYS.admin) },
  set admin(v: string | null) { write(KEYS.admin, v) },
  get branch() { return read(KEYS.branch) },
  set branch(v: string | null) { write(KEYS.branch, v) },
}

export type TokenKind = 'user' | 'admin' | 'none'
export interface Effects { stock?: { productId: string; branchId: string; stock: number }[] }

const randomId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 32)
/** This tab, so the change feed doesn't send back our own changes (sessionStorage: one per tab, never data). */
export const deviceId = (() => {
  try { const v = sessionStorage.getItem('billpoodum.device') ?? randomId().slice(0, 20); sessionStorage.setItem('billpoodum.device', v); return v } catch { return randomId().slice(0, 20) }
})()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The change-feed note on signed-in answers (sync.ts listens). */
let onFeed: (note: { latest: number; epoch?: string | null; own?: number | null }) => void = () => {}
export const setFeedListener = (fn: typeof onFeed) => { onFeed = fn }

/** Called after the server says the token is no longer valid (password changed, login turned off…). */
let onSignedOut: (kind: 'user' | 'admin') => void = () => {}
export const setSignedOutHandler = (fn: typeof onSignedOut) => { onSignedOut = fn }

/** A fixed request id for the next call (see withRequestId). */
let pinned: string | null = null
/**
 * Runs `fn` with its first server call using request id `id`. A bill is sent with the same id every time it is
 * retried (double tap, connection dropped after the server saved it), and the server saves it at most once.
 * `fn` must make that call straight away (before any await).
 */
export function withRequestId<T>(id: string, fn: () => Promise<T>): Promise<T> {
  pinned = id
  try { return fn() } finally { pinned = null }
}
export const newRequestId = () => randomId()

export async function rpc<T>(name: string, args: unknown[], token: TokenKind): Promise<{ data: T; effects?: Effects }> {
  const id = pinned ?? randomId()
  pinned = null
  for (let attempt = 0; ; attempt++) {
    try { return await rpcOnce<T>(name, args, token, id) } catch (e) {
      // BUSY = another device of the shop was saving and nothing was saved here: try once more, with the same
      // request id (bills, payments and returns are saved at most once per id).
      if (!(e instanceof ApiError) || e.code !== 'BUSY' || attempt >= 1) throw e
      await sleep(300 + Math.random() * 400)
    }
  }
}

async function rpcOnce<T>(name: string, args: unknown[], token: TokenKind, id: string): Promise<{ data: T; effects?: Effects }> {
  const t = token === 'user' ? auth.user : token === 'admin' ? auth.admin : null
  let res: Response
  try {
    const h: Record<string, string> = {
      'x-request-id': id,
      'x-device': deviceId,
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(token === 'user' && auth.branch ? { 'x-branch': auth.branch } : {}),
    }
    // API on another site (app on Slate): a "simple" request — plain text body, no extra headers — so the
    // browser sends it without a CORS pre-check. The sign-in token and branch travel inside the body.
    const base = await apiBase()
    res = await fetch(`${base}/rpc/${name}`, crossSite(base)
      ? { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ args, h }), credentials: 'omit' }
      : { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ args }) })
  } catch {
    if (CANDIDATES.length > 1) forgetBase()
    // No queueing: an offline change is never saved for later. The user sees the error and tries again.
    // The request may or may not have reached the server, so never claim either way.
    throw new ApiError('Connection problem — this may not have been saved. Please check and try again.', 'OFFLINE')
  }
  let body: { data?: T; effects?: Effects; error?: { message: string; code: string }; feed?: { latest: number; epoch?: string | null; own?: number | null } }
  try { body = await res.json() } catch { throw new ApiError('The server did not answer properly. Please try again.', 'BAD_RESPONSE', res.status) }
  if (body.error || !res.ok) {
    const e = new ApiError(body.error?.message ?? 'Something went wrong', body.error?.code, res.status)
    if (res.status === 401 && t) { if (token === 'user') auth.user = null; else auth.admin = null; onSignedOut(token as 'user' | 'admin') }
    throw e
  }
  if (token === 'user' && body.feed && typeof body.feed === 'object') { try { onFeed(body.feed) } catch { /* never breaks the call */ } }
  return { data: body.data as T, effects: body.effects }
}
