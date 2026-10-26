// Encrypts a value the way the API stores secrets (shop database tokens, WhatsApp tokens): AES-256-GCM with
// SECRETS_KEY, as "v1:<base64>". Use it when repointing a restored shop database (PRODUCTION.md → Backups).
//   SECRETS_KEY='<same as the api function>' node backend/scripts/encrypt-secret.mjs '<value>'
// Prints only the encrypted value. Never commit or share the plain value.
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
const raw = process.env.SECRETS_KEY ?? ''
const plain = process.argv[2]
if (raw.length < 32 || !plain) { console.error("Usage: SECRETS_KEY='<32+ chars>' node backend/scripts/encrypt-secret.mjs '<value>'"); process.exit(1) }
const key = createHash('sha256').update(raw).digest()
const iv = randomBytes(12)
const c = createCipheriv('aes-256-gcm', key, iv)
const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
console.log('v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'))
