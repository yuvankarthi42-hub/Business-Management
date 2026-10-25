// Prints a new VAPID key pair for browser push (order tracking "Notify me").
// Put both in the API function's environment variables: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and VAPID_SUBJECT=mailto:…).
// Never commit the private key.
import { createECDH } from 'node:crypto'
const ecdh = createECDH('prime256v1')
ecdh.generateKeys()
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}`)
console.log(`VAPID_PRIVATE_KEY=${ecdh.getPrivateKey().toString('base64url')}`)
