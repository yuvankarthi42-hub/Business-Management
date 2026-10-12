// Sign-in tokens (JWT, HS256) — no session table needed. The secret comes from the function's
// environment variable AUTH_SECRET (Catalyst console → Functions → api → Configuration).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { ApiError } from './errors'

const b64 = (s: Buffer | string) => Buffer.from(s).toString('base64url')
const secret = () => {
  const s = process.env.AUTH_SECRET
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === 'production') throw new ApiError('Server is not configured (AUTH_SECRET)', 500, 'CONFIG')
    return 'dev-only-secret-change-me-dev-only-secret'
  }
  return s
}

export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }))
  const sig = b64(createHmac('sha256', secret()).update(`${head}.${body}`).digest())
  return `${head}.${body}.${sig}`
}

/** Returns the payload, or null when the token is missing, tampered with or expired. */
export function verifyToken<T extends Record<string, unknown>>(token: string | undefined | null): (T & { exp: number; iat: number }) | null {
  if (!token) return null
  const [head, body, sig] = token.split('.')
  if (!head || !body || !sig) return null
  const want = createHmac('sha256', secret()).update(`${head}.${body}`).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null
    return p
  } catch { return null }
}
