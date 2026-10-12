// Talks to the BillPoodum API on Zoho Catalyst: POST /server/api/rpc/<namespace>.<method> { args }.
// Only sign-in tokens and the chosen branch are kept in the browser — never data or pending changes.

export class ApiError extends Error {
  constructor(message: string, readonly code = 'ERROR', readonly status = 0) { super(message) }
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/server/api'
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

/** Called after the server says the token is no longer valid (password changed, login turned off…). */
let onSignedOut: (kind: 'user' | 'admin') => void = () => {}
export const setSignedOutHandler = (fn: typeof onSignedOut) => { onSignedOut = fn }

export async function rpc<T>(name: string, args: unknown[], token: TokenKind): Promise<{ data: T; effects?: Effects }> {
  const id = randomId()
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
    res = await fetch(`${BASE}/rpc/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': id,
        'x-device': deviceId,
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...(token === 'user' && auth.branch ? { 'x-branch': auth.branch } : {}),
      },
      body: JSON.stringify({ args }),
    })
  } catch {
    // No queueing: an offline change is never saved for later. The user sees the error and tries again.
    throw new ApiError('No internet connection. Nothing was saved — please try again when you are online.', 'OFFLINE')
  }
  let body: { data?: T; effects?: Effects; error?: { message: string; code: string } }
  try { body = await res.json() } catch { throw new ApiError('The server did not answer properly. Please try again.', 'BAD_RESPONSE', res.status) }
  if (body.error || !res.ok) {
    const e = new ApiError(body.error?.message ?? 'Something went wrong', body.error?.code, res.status)
    if (res.status === 401 && t) { if (token === 'user') auth.user = null; else auth.admin = null; onSignedOut(token as 'user' | 'admin') }
    throw e
  }
  return { data: body.data as T, effects: body.effects }
}
