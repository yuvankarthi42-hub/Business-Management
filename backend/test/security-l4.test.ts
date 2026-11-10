// Low fixes, step 4: L17 (exact push hosts), L9 (private support screenshots behind short-lived signed links).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import '../src/modules/support'
import { isPushEndpoint } from '../src/core/webpush'
import { checkMediaLink, mediaKeyOf, mediaLink } from '../src/core/media'
import { withShop } from './fixtures'

type Ticket = { id: string; messages: { images: string[] }[] }
const png = (bytes: number) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes)]).toString('base64')}`

test('L17: only the browsers’ own push services', () => {
  for (const u of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://fcm.googleapis.com:443/fcm/send/x'])
    assert.equal(isPushEndpoint(u), true, u)
  for (const u of ['https://storage.googleapis.com/bucket/x', 'https://evil.googleapis.com/x', 'https://push.services.mozilla.com.evil.in/x', 'https://notify.windows.com/x', 'https://fcm.googleapis.com:8080/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.in/x'])
    assert.equal(isPushEndpoint(u), false, u)
})

test('L9: signed links — genuine and in time only', () => {
  const now = Date.now(), key = 'p/12/tickets/abc123.png'
  const link = mediaLink(key, now)
  const q = new URLSearchParams(link.split('?')[1])
  assert.equal(mediaKeyOf(`https://api.example.in/server/api/${link}`), key)
  assert.equal(checkMediaLink(key, q.get('e'), q.get('s'), now), true)
  assert.equal(checkMediaLink(key, q.get('e'), q.get('s'), now + 61 * 60_000), false, 'expired after an hour at most')
  assert.equal(checkMediaLink('p/13/tickets/abc123.png', q.get('e'), q.get('s'), now), false, 'another file')
  assert.equal(checkMediaLink(key, Number(q.get('e')) + 1800, q.get('s'), now), false, 'a longer expiry')
  assert.equal(checkMediaLink('p/../secret.png', q.get('e'), q.get('s'), now), false)
})

test('L9: with a private store, screenshots are served only through signed links', async () => {
  process.env.TEST_PRIVATE_FILES = '1'
  const s = await withShop()
  delete process.env.TEST_PRIVATE_FILES
  try {
    const shot = await s.call<{ url: string }>('support.storeScreenshot', { image: png(1000) })
    assert.match(shot.url, new RegExp(`^media/p/${s.businessId}/tickets/[0-9a-f]+\\.png\\?e=\\d+&s=`))
    const full = `${s.base}/${shot.url}`
    const r = await fetch(full)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'image/png')
    assert.equal((await r.arrayBuffer()).byteLength, 1008)
    assert.equal((await fetch(full.replace(/&s=[^&]+/, '&s=AAAAAAAAAAAAAAAAAAAAAA'))).status, 404, 'a made-up signature')
    assert.equal((await fetch(full.split('?')[0])).status, 404, 'no signature')
    // The app sends the full link back; the ticket shows a fresh signed link.
    const t = await s.call<Ticket>('support.create', { subject: 'Bill not printing', category: 'printer', message: 'The printer stays silent', images: [full] })
    assert.match(t.messages[0].images[0], /^media\/p\//)
    // Another shop's private file is refused.
    await assert.rejects(s.call('support.reply', t.id, 'again', ['media/p/999/tickets/abc.png?e=1&s=x']), /Upload the screenshot again/)
    // Admin side.
    s.setToken(s.adminToken)
    const a = await s.call<{ url: string }>('admin.storeScreenshot', { image: png(500) })
    assert.match(a.url, /^media\/p\/platform\/tickets\//)
    await s.call('admin.replyTicket', t.id, 'Restart the printer', [a.url])
    const seen = await s.call<Ticket>('admin.ticket', t.id)
    assert.equal(seen.messages[1].images.length, 1)
    assert.equal((await fetch(`${s.base}/${seen.messages[1].images[0]}`)).status, 200)
  } finally { s.close(); rmSync('/tmp/bp-test-private', { recursive: true, force: true }) }
})

test('L9: one-time move of older screenshots to the private store', async () => {
  // Saved before the private store existed (public, as before).
  const s = await withShop()
  let id = ''
  try {
    const shot = await s.call<{ url: string }>('support.storeScreenshot', { image: png(800) })
    assert.match(shot.url, /\/uploads\//, 'no private store → public, unchanged')
    id = (await s.call<Ticket>('support.create', { subject: 'Old ticket', category: 'other', message: 'With a screenshot', images: [shot.url] })).id
    s.setToken(s.adminToken)
    await assert.rejects(s.call('admin.moveScreenshots'), /STRATUS_PRIVATE_BUCKET/)
    // Now with a private store (same files and databases).
    const files = s.env.files as unknown as { privateDir: string | null }
    files.privateDir = '/tmp/bp-test-private'
    const r = await s.call<{ moved: number; left: number }>('admin.moveScreenshots')
    assert.equal(r.moved, 1)
    assert.equal(r.left, 0)
    const t = await s.call<Ticket>('admin.ticket', id)
    assert.match(t.messages[0].images[0], /^media\/p\//)
    assert.equal((await fetch(`${s.base}/${t.messages[0].images[0]}`)).status, 200)
    assert.equal(existsSync(`/tmp/bp-test-uploads${shot.url.replace(/^\/uploads/, '')}`), false, 'the public copy is gone')
  } finally { s.close(); rmSync('/tmp/bp-test-private', { recursive: true, force: true }) }
})

// ---------- L11: key id and row binding for saved secrets ----------
test('L11: a secret is tied to its row; old v1 values still read; plain text refused; key change keeps old values readable', async () => {
  const { decryptSecret, encryptSecret, secretPlace } = await import('../src/core/crypto')
  const { createCipheriv, createHash, randomBytes } = await import('node:crypto')
  const saved = { ...process.env }
  try {
    process.env.SECRETS_KEY = 'a'.repeat(40)
    const here = secretPlace('secrets', 'value', '2:15:1'), there = secretPlace('secrets', 'value', '2:16:1')
    const v = encryptSecret('EAAG-token-1234', here)
    assert.match(v, /^v2:1:/)
    assert.equal(decryptSecret(v, here), 'EAAG-token-1234')
    assert.equal(decryptSecret(v, there), null, 'copied into another row: unreadable')
    // A v1 value (no row binding) from before: still read.
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', createHash('sha256').update('a'.repeat(40)).digest(), iv)
    const ct = Buffer.concat([c.update('old-token', 'utf8'), c.final()])
    assert.equal(decryptSecret('v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'), here), 'old-token')
    // Plain text: refused (unless a one-off import says so).
    assert.equal(decryptSecret('EAAG-plain', here), null)
    process.env.SECRETS_ALLOW_PLAINTEXT = '1'
    assert.equal(decryptSecret('EAAG-plain', here), 'EAAG-plain')
    delete process.env.SECRETS_ALLOW_PLAINTEXT
    // Key change: the old key as SECRETS_KEY_PREVIOUS keeps old values readable; new values use the new key id.
    process.env.SECRETS_KEY = 'b'.repeat(40); process.env.SECRETS_KEY_ID = '2'
    assert.equal(decryptSecret(v, here), null, 'without the previous key')
    process.env.SECRETS_KEY_PREVIOUS = 'a'.repeat(40); process.env.SECRETS_KEY_PREVIOUS_ID = '1'
    assert.equal(decryptSecret(v, here), 'EAAG-token-1234')
    assert.match(encryptSecret('x', here), /^v2:2:/)
  } finally { for (const k of ['SECRETS_KEY', 'SECRETS_KEY_ID', 'SECRETS_KEY_PREVIOUS', 'SECRETS_KEY_PREVIOUS_ID', 'SECRETS_ALLOW_PLAINTEXT']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
})
