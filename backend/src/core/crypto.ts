// Secrets at rest (WhatsApp access tokens) for databases that don't encrypt by themselves (Turso / SQLite).
// AES-256-GCM with a key from SECRETS_KEY (32+ random characters, kept only in the function's settings).
//
// Stored as "v2:<key id>:<base64 iv · tag · ciphertext>". The value is tied to its place (table, column and the
// row's own key, e.g. secrets.uniq_key) as GCM associated data, so a value copied into another row or column
// can't be read. Key change without losing saved tokens: put the old key in SECRETS_KEY_PREVIOUS (with its id in
// SECRETS_KEY_PREVIOUS_ID), the new one in SECRETS_KEY with a new SECRETS_KEY_ID (default "1"); old values are
// still read and are saved with the new key the next time they change.
// Older "v1:<…>" values (no key id, not tied to a row) are still read and become v2 when next saved.
// Text without a prefix (never encrypted) is refused — unless SECRETS_ALLOW_PLAINTEXT=1, for a one-off import.
import { devSecretsAllowed } from './tokens'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const V1 = 'v1:', V2 = 'v2:'
const KID = /^[a-z0-9]{1,8}$/i
let warned = false
const hashed = (raw: string) => createHash('sha256').update(raw).digest()
const cache = new Map<string, Buffer>()
function keyFrom(raw: string) { let k = cache.get(raw); if (!k) { k = hashed(raw); cache.set(raw, k) } return k }

/** The key used for new values: [id, key]. */
function current(): [string, Buffer] {
  const raw = process.env.SECRETS_KEY ?? ''
  const id = process.env.SECRETS_KEY_ID || '1'
  if (!KID.test(id)) throw new Error('SECRETS_KEY_ID must be 1–8 letters or digits')
  if (raw.length >= 32) return [id, keyFrom(raw)]
  if (!devSecretsAllowed()) throw new Error('SECRETS_KEY is not set (32+ characters) — needed to save access tokens')
  if (!warned) { console.warn('SECRETS_KEY not set: using a development key (never in production).'); warned = true }
  return [id, keyFrom('billpoodum-development-only-key')]
}
/** Keys that can read: the current one, then the previous one (during a key change). */
function readers(id?: string): Buffer[] {
  const [curId, cur] = current()
  const prev = process.env.SECRETS_KEY_PREVIOUS ?? ''
  const prevId = process.env.SECRETS_KEY_PREVIOUS_ID || ''
  const out: Buffer[] = []
  if (id === undefined || id === curId) out.push(cur)
  if (prev.length >= 32 && (id === undefined || id === prevId || !prevId)) out.push(keyFrom(prev))
  return out
}
/** Where a value belongs: "table.column|row key". */
export const secretPlace = (table: string, column: string, rowKey: string | null | undefined) => `${table}.${column}|${rowKey ?? ''}`

export function encryptSecret(plain: string, place: string): string {
  const [id, key] = current()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(place, 'utf8'))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `${V2}${id}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}

function open(b64: string, key: Buffer, place: string | null): string | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
    if (place !== null) d.setAAD(Buffer.from(place, 'utf8'))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  } catch { return null }
}
export function decryptSecret(stored: string, place: string): string | null {
  let out: string | null = null
  if (stored.startsWith(V2)) {
    const rest = stored.slice(V2.length), i = rest.indexOf(':')
    const id = i > 0 ? rest.slice(0, i) : ''
    if (KID.test(id)) for (const k of readers(id)) if ((out = open(rest.slice(i + 1), k, place)) !== null) break
  } else if (stored.startsWith(V1)) {
    for (const k of readers()) if ((out = open(stored.slice(V1.length), k, null)) !== null) break
  } else {
    if (process.env.SECRETS_ALLOW_PLAINTEXT === '1') return stored
    console.error('A saved secret is not encrypted — refused (enter it again, or SECRETS_ALLOW_PLAINTEXT=1 for a one-off import)')
    return null
  }
  if (out === null) console.error('A saved secret could not be decrypted (was SECRETS_KEY changed, or the value moved to another row?)')
  return out
}
