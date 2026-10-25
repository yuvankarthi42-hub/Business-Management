// Browser push (Web Push) without extra libraries: VAPID sign-in (RFC 8292) + encrypted message (RFC 8291,
// aes128gcm). The server sends one request to the browser's push service (Google / Apple / Mozilla) when an
// order's status changes — no open connection, so it works from a Catalyst function.
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url; make a pair with `npm run vapid`), VAPID_SUBJECT (mailto:…).
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface PushResult { ok: boolean; gone: boolean; status: number }
export interface PushSender {
  readonly publicKey: string
  send(target: PushTarget, payload: string): Promise<PushResult>
}

const b64u = (b: Buffer) => b.toString('base64url')
const fromB64u = (s: string) => Buffer.from(s, 'base64url')

/** A new VAPID key pair (base64url): put them in the function's environment variables. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) }
}

/** The encrypted body for one browser (RFC 8291). */
export function encryptPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, payload: string): Buffer {
  const uaPublic = fromB64u(target.p256dh)
  const authSecret = fromB64u(target.auth)
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid push subscription keys')
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const salt = randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

/** The VAPID "Authorization" header for one push service. */
export function vapidHeader(endpoint: string, keys: { publicKey: string; privateKey: string }, subject: string, now = Date.now()) {
  const pub = fromB64u(keys.publicKey)
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' })
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`
}

/** Only real push services are called (never an address a browser could make up to reach our network). */
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.microsoft\.com)(:\d+)?\//i
export const isPushEndpoint = (u: string) => typeof u === 'string' && u.length <= 500 && PUSH_HOSTS.test(u)

export class WebPushSender implements PushSender {
  constructor(private keys: { publicKey: string; privateKey: string }, private subject: string) {}
  get publicKey() { return this.keys.publicKey }
  async send(target: PushTarget, payload: string): Promise<PushResult> {
    if (!isPushEndpoint(target.endpoint)) return { ok: false, gone: true, status: 0 }
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '43200', urgency: 'high', authorization: vapidHeader(target.endpoint, this.keys, this.subject) },
      body: encryptPayload(target, payload),
    })
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status }
  }
}

/** From the environment, or null when push isn't set up (the tracking page then shows only Refresh). */
export function pushFromEnv(): PushSender | null {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return null
  return new WebPushSender({ publicKey: pub, privateKey: priv }, process.env.VAPID_SUBJECT || 'mailto:KadaiKalanjiyam@gmail.com')
}
