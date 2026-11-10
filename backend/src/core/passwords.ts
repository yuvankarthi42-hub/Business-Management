// Password hashing: PBKDF2-SHA256 (Web Crypto, native — the same code runs on Node and Cloudflare Workers).
// About 4 ms of CPU per hash at the default 20,000 iterations, so a sign-in stays inside a 10 ms CPU budget.
//
// Stored as  pbkdf2-sha256$<iterations>$<p|n>$<salt>$<hash>   (p = the server pepper was used, n = not; base64url)
//  • PASSWORD_ITERATIONS (env, default 20000): raise it on a bigger CPU budget — older hashes are upgraded at the
//    next sign-in (needsRehash), with no reset for anyone.
//  • PASSWORD_PEPPER (env, optional, 32+ characters): a server-side secret mixed in before hashing, so a copy of the
//    database alone can't be used to guess passwords. Never change it once set (existing passwords stop working).
//  • Older bcrypt hashes ($2a$ / $2b$) still sign in, and are replaced by PBKDF2 at that sign-in.
import { webcrypto } from 'node:crypto'
import { ApiError } from './errors'

const subtle = webcrypto.subtle
const enc = new TextEncoder()
const PREFIX = 'pbkdf2-sha256'
export const DEFAULT_ITERATIONS = 20_000

/** Iterations for new hashes (10,000 – 1,000,000). */
export function passwordIterations() {
  const n = Math.floor(Number(process.env.PASSWORD_ITERATIONS))
  return Number.isFinite(n) && n >= 10_000 && n <= 1_000_000 ? n : DEFAULT_ITERATIONS
}
const pepper = () => (process.env.PASSWORD_PEPPER ?? '').trim()

/**
 * Production without PASSWORD_PEPPER (or a short one): a warning in the server log, once. Never stops the server —
 * passwords keep working; setting it later upgrades each password at its next sign-in.
 */
export function warnIfNoPepper(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.warn): boolean {
  if (env.NODE_ENV !== 'production') return false
  const p = String(env.PASSWORD_PEPPER ?? '').trim()
  if (p.length >= 32) return false
  log(p ? '[security] PASSWORD_PEPPER is shorter than 32 characters — use a longer random value.'
    : '[security] PASSWORD_PEPPER is not set — set a random 32+ character value on the api function (see DEPLOY-NEW-ACCOUNT.md). Never change it once set.')
  return true
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

/** The bytes PBKDF2 hashes: the password itself, or HMAC-SHA256(pepper, password) when a pepper is used. */
async function input(plain: string, peppered: boolean) {
  if (!peppered) return enc.encode(plain)
  const key = await subtle.importKey('raw', enc.encode(pepper()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', key, enc.encode(plain)))
}
async function derive(plain: string, salt: Uint8Array, iterations: number, peppered: boolean) {
  const key = await subtle.importKey('raw', await input(plain, peppered), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}
/** Same length → compares every byte (the time doesn't show where a guess went wrong). */
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}
interface Parsed { iterations: number; peppered: boolean; salt: Uint8Array; hash: Uint8Array }
function parse(stored: string): Parsed | null {
  const [p, it, pep, salt, hash] = stored.split('$')
  const iterations = Number(it)
  if (p !== PREFIX || !Number.isInteger(iterations) || iterations < 1 || (pep !== 'p' && pep !== 'n') || !salt || !hash) return null
  return { iterations, peppered: pep === 'p', salt: unb64(salt), hash: unb64(hash) }
}
const isBcrypt = (h: string) => /^\$2[aby]\$\d{2}\$/.test(h)

export async function hashPassword(plain: string) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const iterations = passwordIterations(), peppered = !!pepper()
  return `${PREFIX}$${iterations}$${peppered ? 'p' : 'n'}$${b64(salt)}$${b64(await derive(plain, salt, iterations, peppered))}`
}

export async function checkPassword(plain: string, stored: string | null | undefined) {
  if (!stored || typeof plain !== 'string') return false
  if (isBcrypt(stored)) {
    // Hashes made before PBKDF2 (only loaded when such a hash is met).
    const bcrypt = (await import('bcryptjs')).default
    return bcrypt.compare(plain, stored)
  }
  const p = parse(stored)
  if (!p) return false
  // A peppered hash can't be checked without the pepper (it was removed from the settings): fail, never guess.
  if (p.peppered && !pepper()) return false
  return sameBytes(await derive(plain, p.salt, p.iterations, p.peppered), p.hash)
}

/** After a correct password: should the stored hash be replaced (old bcrypt, fewer iterations, pepper now set)? */
export function needsRehash(stored: string | null | undefined) {
  if (!stored) return false
  if (isBcrypt(stored)) return true
  const p = parse(stored)
  if (!p) return false
  return p.iterations < passwordIterations() || (!p.peppered && !!pepper())
}

/** Passwords too common to allow (checked on new passwords only; existing ones keep working). */
const COMMON = new Set(['12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234', '11223344', 'password',
  'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyui', 'abcd1234', 'abc12345', 'iloveyou', 'admin123', 'welcome1',
  'welcome123', 'letmein1'])

/** Rules for a NEW password (sign-in with an existing one is never refused by these). `avoid`: the mobile / username. */
export function assertPassword(p: string | undefined | null, avoid: (string | null | undefined)[] = []) {
  if (!p || p.length < 8) throw new ApiError('Password must be at least 8 characters')
  if (p.length > 72) throw new ApiError('Password is too long (72 characters at most)')
  const low = p.toLowerCase()
  if (COMMON.has(low) || /^(.)\1+$/.test(p)) throw new ApiError('This password is too easy to guess. Choose another one.')
  const digits = (s: string) => s.replace(/\D/g, '')
  for (const a of avoid) {
    const x = String(a ?? '').trim().toLowerCase()
    if (!x) continue
    if (low === x || (digits(x).length >= 8 && digits(p) === digits(x)) || (digits(x).length >= 10 && digits(p) === digits(x).slice(-10))) {
      throw new ApiError('Don’t use your mobile number or username as the password.')
    }
  }
}
