// Secrets at rest (WhatsApp access tokens) for databases that don't encrypt by themselves (Turso / SQLite).
// AES-256-GCM with a key from SECRETS_KEY (32+ random characters, kept only in the function's settings).
// Stored as "v1:<base64 iv · tag · ciphertext>". Changing SECRETS_KEY makes saved tokens unreadable — they
// then have to be entered again (WhatsApp settings).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const PREFIX = 'v1:'
let warned = false
function key(): Buffer {
  const raw = process.env.SECRETS_KEY ?? ''
  if (raw.length >= 32) return createHash('sha256').update(raw).digest()
  if (process.env.NODE_ENV === 'production') throw new Error('SECRETS_KEY is not set (32+ characters) — needed to save access tokens')
  if (!warned) { console.warn('SECRETS_KEY not set: using a development key (never in production).'); warned = true }
  return createHash('sha256').update('billpoodum-development-only-key').digest()
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) return stored
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
    const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  } catch {
    console.error('A saved secret could not be decrypted (was SECRETS_KEY changed?)')
    return null
  }
}
