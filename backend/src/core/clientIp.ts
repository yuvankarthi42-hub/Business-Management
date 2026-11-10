// The visitor's network address, for rate limits only (never for permissions). It must not be something the
// visitor can choose, so headers are trusted only as far as the hosting really sets them:
//
//   CLIENT_IP_SOURCE=catalyst  (default in production) — Catalyst's gateway appends the address it received the
//     connection from to X-Forwarded-For. A visitor can put anything at the LEFT of that list, never at the right,
//     so the list is read from the right: our own / private proxy hops are skipped (plus TRUSTED_PROXIES), and the
//     first other address is the visitor. Check it after a deploy with GET /ip-check (x-setup-key) while sending
//     a made-up X-Forwarded-For: the answer must still be your real address.
//   CLIENT_IP_SOURCE=cloudflare (not used yet) — CF-Connecting-IP, but only when the request carries the secret
//     header that our Cloudflare rule adds (X-Edge-Auth = CF_EDGE_SECRET). Without it → the catalyst rule above,
//     so a visitor talking to Catalyst directly can't pretend to be Cloudflare.
//   CLIENT_IP_SOURCE=socket (default locally) — the TCP peer address only.
import { createHash, timingSafeEqual } from 'node:crypto'

export type IpSource = 'socket' | 'catalyst' | 'cloudflare'
interface ReqLike { header(name: string): string | undefined; socket?: { remoteAddress?: string | null } }

const v4 = (s: string) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); return m && m.slice(1).every((x) => Number(x) <= 255) ? m.slice(1).map(Number) : null }

/** Strips ports, brackets and the IPv4-in-IPv6 prefix; '' when it isn't an IP address. */
export function cleanIp(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined) // [::1]:443
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':')) // 1.2.3.4:5678
  s = s.replace(/^::ffff:/i, '')
  if (v4(s)) return s
  return /^[0-9a-f:]+$/i.test(s) && s.includes(':') && s.length <= 45 ? s.toLowerCase() : ''
}

/** Loopback, private, link-local, carrier-grade NAT and unique-local addresses: never a visitor on the internet. */
export function isPrivateIp(ip: string): boolean {
  const a = v4(ip)
  if (a) return a[0] === 10 || a[0] === 127 || a[0] === 0 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127)
  return ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip)
}

/** "10.0.0.0/8, 203.0.113.7" → a matcher (IPv4 CIDR or exact address). */
function matcher(list: string | undefined) {
  const rules = String(list ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((r) => {
    const [base, bits] = r.split('/')
    const b = v4(base)
    if (b && bits !== undefined) {
      const n = Math.max(0, Math.min(32, Number(bits)))
      const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0
      const net = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
      return (ip: string) => { const a = v4(ip); return !!a && ((((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0) & mask) === (net & mask) }
    }
    const exact = cleanIp(r)
    return (ip: string) => ip === exact
  })
  return (ip: string) => rules.some((f) => f(ip))
}

const sameSecret = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

export function ipSource(env: NodeJS.ProcessEnv = process.env): IpSource {
  const v = String(env.CLIENT_IP_SOURCE ?? '').trim().toLowerCase()
  if (v === 'socket' || v === 'catalyst' || v === 'cloudflare') return v
  return env.NODE_ENV === 'production' ? 'catalyst' : 'socket'
}

/** The address rate limits are keyed on, and how it was found (for /ip-check). */
export function resolveClientIp(req: ReqLike, env: NodeJS.ProcessEnv = process.env): { ip: string; via: string } {
  const source = ipSource(env)
  const peer = cleanIp(req.socket?.remoteAddress)
  if (source === 'socket') return { ip: peer, via: 'socket' }
  if (source === 'cloudflare') {
    const secret = String(env.CF_EDGE_SECRET ?? '')
    const sent = req.header('x-edge-auth') ?? ''
    const cf = cleanIp(req.header('cf-connecting-ip'))
    if (secret.length >= 16 && sent && sameSecret(sent, secret) && cf) return { ip: cf, via: 'cloudflare' }
    // Not from our Cloudflare: fall through to the gateway rule (the header can't be trusted).
  }
  const trusted = matcher(env.TRUSTED_PROXIES)
  const hops = String(req.header('x-forwarded-for') ?? '').split(',').map(cleanIp)
  // Right to left: the gateway's own entry is last. Skip our proxies; the first other address is the visitor.
  const chain = [...hops, peer]
  for (let i = chain.length - 1; i >= 0; i--) {
    const ip = chain[i]
    if (!ip || isPrivateIp(ip) || trusted(ip)) continue
    return { ip, via: i === chain.length - 1 ? 'peer' : `x-forwarded-for[${i}]` }
  }
  return { ip: peer || hops.filter(Boolean).pop() || '', via: 'fallback' }
}

/** True when the request carries SETUP_KEY (constant-time; the key must be at least 16 characters). */
export function setupKeyOk(sent: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const want = String(env.SETUP_KEY ?? '')
  return want.length >= 16 && !!sent && sameSecret(sent, want)
}
