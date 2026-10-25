import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

const png = (bytes: number) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes)]).toString('base64')}`
type B = { logoUrl?: string | null }
const me = async (s: Awaited<ReturnType<typeof withShop>>) => (await s.call<{ business: B }>('auth.me')).business

test('shop logo: upload, replace, remove; shown on the public menu; owner-only; size checked', async () => {
  const s = await withShop()
  try {
    // No logo yet: the app shows the Kadai Kalanjiyam logo.
    assert.equal((await me(s)).logoUrl ?? null, null)

    const b1 = await s.call<B>('business.setLogo', { image: png(2000), width: 512, height: 512 })
    assert.match(String(b1.logoUrl), new RegExp(`/${s.businessId}/logos/[0-9a-f]+\\.png$`))
    assert.equal((await me(s)).logoUrl, b1.logoUrl, 'the signed-in session sees the new logo')

    const b2 = await s.call<B>('business.setLogo', { image: png(3000) })
    assert.notEqual(b2.logoUrl, b1.logoUrl, 'a new upload replaces the old one')

    // Customers scanning the QR see it too.
    const menu = await s.call<{ business: { logoUrl: string | null } }>('public.menu', s.businessId, s.mainBranch)
    assert.equal(menu.business.logoUrl, b2.logoUrl)

    await assert.rejects(s.call('business.setLogo', { image: png(90 * 1024) }), /too large/)
    await assert.rejects(s.call('business.setLogo', { image: 'data:image/png;base64,AAAA' }), /not a supported image/)

    // Staff without "settings" can't change it.
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    await s.call('users.save', { name: 'Ravi', phone: '9800000601', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const owner = s.ownerToken
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000601', 'ravi1234')).token)
    await assert.rejects(s.call('business.setLogo', null))
    s.setToken(owner)

    const b3 = await s.call<B>('business.setLogo', null)
    assert.equal(b3.logoUrl ?? null, null, 'removed: back to the Kadai Kalanjiyam logo')
  } finally { s.close() }
})
