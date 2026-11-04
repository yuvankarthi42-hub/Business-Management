import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string; price: number }
type Me = { business: { modules: Record<string, boolean> }; features: Record<string, boolean> }
type Mode = 'off' | 'selected' | 'all'

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const draft = (p: P) => ({ type: 'takeaway', tableId: null, customerId: null, items: [{ id: 'tmp_1', productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty: 1, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '' }], discount: 0, notes: '', source: 'pos' })

/** A shop with QR ordering, specials and GST on (the test environment releases all three features to everyone). */
async function shop() {
  const s = await withShop()
  await s.call('business.update', { billing: { taxEnabled: true }, modules: { billing: true, products: true, orders: true, reports: true, qrOrdering: true, specials: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
  const tea = await s.call<P>('products.save', { name: 'Tea', price: 20 })
  const as = async <T>(token: string | null, name: string, ...args: unknown[]) => { s.setToken(token); try { return await s.call<T>(name, ...args) } finally { s.setToken(s.ownerToken) } }
  const flag = (key: string, mode: Mode, ids: string[] = []) => as(s.adminToken, 'admin.setFeature', key, { mode, businessIds: ids })
  const pub = <T>(name: string, ...args: unknown[]) => as<T>(null, name, ...args)
  const order = () => pub<{ orderId: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: tea.id, variantId: null, addOnIds: [], qty: 1, notes: '' }], guest: { name: 'Anu', phone: '9811111111', address: '' }, notes: '' })
  return { s, tea, flag, pub, order }
}

test('QR Orders not released: module off for the shop, staff and customer QR actions refused or empty', async () => {
  const { s, flag, pub, order } = await shop()
  try {
    const placed = await order() // released: works
    assert.equal((await s.call<unknown[]>('qr.pending')).length, 1)
    assert.equal((await pub<{ business: { modules: Record<string, boolean> } }>('public.menu', s.businessId, null, null)).business.modules.qrOrdering, true)

    await flag('qrOrders', 'off')
    const me = await s.call<Me>('auth.me')
    assert.equal(me.features.qrOrders, false)
    assert.equal(me.business.modules.qrOrdering, false, 'the app hides QR ordering everywhere')
    // Lists answer empty without reading the shop (the pending order is still there); actions are refused.
    assert.deepEqual(await s.call('qr.pending'), [])
    assert.deepEqual(await s.call('qr.recent'), [])
    await assert.rejects(s.call('qr.accept', placed.orderId), (e: { code: string }) => e.code === 'FEATURE_OFF')
    await assert.rejects(s.call('qr.reject', placed.orderId, 'x'), (e: { code: string }) => e.code === 'FEATURE_OFF')
    // Customers: the menu (even a copy cached before) says ordering is off; ordering and tracking are refused.
    assert.equal((await pub<{ business: { modules: Record<string, boolean> }; products: unknown[] }>('public.menu', s.businessId, null, null)).business.modules.qrOrdering, false)
    await assert.rejects(order(), /not available/)
    await assert.rejects(pub('public.order', s.businessId, placed.orderId), /not available/)
    await assert.rejects(pub('public.track', s.businessId, '1'), /not available/)

    // Released again (to this customer only): everything as before, the pending order included.
    await flag('qrOrders', 'selected', [s.businessId])
    assert.equal((await s.call<Me>('auth.me')).business.modules.qrOrdering, true)
    assert.equal((await s.call<unknown[]>('qr.pending')).length, 1)
    await s.call('qr.accept', placed.orderId)
  } finally { s.close() }
})

test('Daily Specials not released: no specials in the app, billing, QR menu or TV board', async () => {
  const { s, tea, flag, pub } = await shop()
  try {
    await s.call('specials.save', today(), [{ productId: tea.id, specialPrice: 15, tag: 'Today', sort: 0 }])
    assert.equal((await s.call<unknown[]>('specials.list', today())).length, 1)
    assert.equal((await pub<{ items: unknown[] }>('public.specials', s.businessId)).items.length, 1)
    assert.equal((await pub<{ business: { specialsOn: boolean } }>('public.specials', s.businessId)).business.specialsOn, true, 'TV board keeps checking')

    await flag('specials', 'off')
    assert.equal((await s.call<Me>('auth.me')).business.modules.specials, false)
    assert.deepEqual(await s.call('specials.list', today()), [])
    await assert.rejects(s.call('specials.save', today(), []), (e: { code: string }) => e.code === 'FEATURE_OFF')
    assert.equal((await pub<{ items: unknown[] }>('public.specials', s.businessId)).items.length, 0, 'TV board empty (cached copy refreshed)')
    assert.equal((await pub<{ business: { specialsOn: boolean } }>('public.specials', s.businessId)).business.specialsOn, false, 'TV board stops checking')
    assert.equal((await pub<{ specials: unknown[] }>('public.menu', s.businessId, null, null)).specials.length, 0)
    // A bill charges the normal price.
    const bill = await s.call<{ order: { total: number } }>('orders.save', draft(tea))
    assert.equal(bill.order.total, 21) // ₹20 + 5% GST, not the ₹15 special

    await flag('specials', 'all')
    assert.equal((await s.call<unknown[]>('specials.list', today())).length, 1, 'saved specials come back')
  } finally { s.close() }
})

test('GST report not released: reports.gst refused; other reports unchanged', async () => {
  const { s, flag } = await shop()
  try {
    const month = today().slice(0, 7)
    await s.call('reports.gst', month)
    await flag('gstReport', 'off')
    assert.equal((await s.call<Me>('auth.me')).features.gstReport, false)
    await assert.rejects(s.call('reports.gst', month), (e: { code: string; status: number }) => e.code === 'FEATURE_OFF' && e.status === 403)
    await s.call('reports.summary', new Date(Date.now() - 864e5).toISOString(), new Date().toISOString())
    await flag('gstReport', 'selected', [s.businessId])
    await s.call('reports.gst', month)
  } finally { s.close() }
})

test('Settings → Modules saved while a feature is off keeps the shop’s own choice for its module', async () => {
  const { s, flag } = await shop()
  try {
    await flag('qrOrders', 'off')
    await flag('specials', 'off')
    const seen = (await s.call<Me>('auth.me')).business.modules
    assert.equal(seen.qrOrdering, false)
    await s.call('business.update', { modules: { ...seen, kitchen: true } }) // what the Modules screen sends
    await flag('qrOrders', 'all')
    await flag('specials', 'all')
    const back = (await s.call<Me>('auth.me')).business.modules
    assert.equal(back.qrOrdering, true, 'QR ordering comes back as the shop had it')
    assert.equal(back.specials, true)
    assert.equal(back.kitchen, true, 'the change the owner made is saved')
  } finally { s.close() }
})

test('Single device: off by default; switched per customer; only tells the app (nothing refused on the server)', async () => {
  const { s, pub, order } = await shop()
  try {
    assert.equal((await s.call<Me>('auth.me')).features.singleDevice, false, 'default: off (every shop polls as before)')
    s.setToken(s.adminToken)
    await s.call('admin.setCustomerFeature', s.businessId, 'singleDevice', true)
    s.setToken(s.ownerToken)
    const me = await s.call<Me>('auth.me')
    assert.equal(me.features.singleDevice, true)
    assert.equal(me.business.modules.qrOrdering, true, 'modules unchanged')
    // The change feed, QR ordering and billing work as before (the flag only stops the app's timed checks).
    await s.call('sync.changes', null)
    await order()
    assert.equal((await s.call<unknown[]>('qr.pending')).length, 1)
    assert.ok(await pub('public.menu', s.businessId, null, null))
    s.setToken(s.adminToken)
    await s.call('admin.setCustomerFeature', s.businessId, 'singleDevice', false)
    s.setToken(s.ownerToken)
    assert.equal((await s.call<Me>('auth.me')).features.singleDevice, false)
  } finally { s.close() }
})

test('TV board: specialsOn follows the shop\'s Daily Specials module too', async () => {
  const { s, pub } = await shop()
  try {
    await s.call('business.update', { modules: { ...(await s.call<Me>('auth.me')).business.modules, specials: false } })
    assert.equal((await pub<{ business: { specialsOn: boolean } }>('public.specials', s.businessId)).business.specialsOn, false)
  } finally { s.close() }
})
