// M3, M4, M5: bills can't be changed in ways the person's role doesn't allow, and repeated QR requests are safe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type S = Awaited<ReturnType<typeof withShop>>
type Item = { id: string; productId: string; qty: number; kotQty: number; unitPrice: number }
type Order = { id: string; status: string; items: Item[]; qrStatus?: string }
const forbidden = (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN'
const line = (productId: string, qty: number, extra: Record<string, unknown> = {}) => ({ id: `tmp_${Math.random()}`, productId, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', ...extra })
const draft = (items: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'dine_in', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

async function shop() {
  const s = await withShop()
  await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, products: true, orders: true, tables: true, kitchen: true, qrOrdering: true }, qr: { orderTypes: ['dine_in', 'takeaway'], autoAccept: true, baseUrl: '' } })
  const t1 = await s.call<{ id: string }>('tables.save', { label: 'T1', floor: 'Main', seats: 4 })
  const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 20, sendToKitchen: true })
  const biryani = await s.call<{ id: string }>('products.save', { name: 'Biryani', price: 250, sendToKitchen: true })
  const roles = await s.call<{ id: string; name: string }[]>('roles.list')
  const user = async (name: string, phone: string, role: string) => {
    await s.call('users.save', { name, phone, roleId: roles.find((r) => r.name === role)!.id, password: `${name}#Pass2026`, branchId: s.mainBranch })
    return async () => { s.setToken(null); s.setToken((await s.call<{ token: string }>('auth.login', phone, `${name}#Pass2026`)).token) }
  }
  const asCashier = await user('Ravi', '9876500031', 'Cashier')
  const asWaiter = await user('Kumar', '9876500032', 'Waiter')
  const asKitchen = await user('Chef', '9876500033', 'Kitchen Staff')
  const asOwner = () => s.setToken(s.ownerToken)
  return { s, t1, tea, biryani, asCashier, asWaiter, asKitchen, asOwner }
}
const get = (s: S, id: string) => s.call<Order>('orders.get', id).then((r) => (r as unknown as { order?: Order }).order ?? r)

test('M5: who may change running orders — kitchen staff can’t edit bills; waiters and cashiers can as before', async () => {
  const { s, t1, tea, asCashier, asWaiter, asKitchen } = await shop()
  try {
    await asKitchen()
    await assert.rejects(s.call('orders.save', draft([line(tea.id, 1)], { tableId: t1.id })), forbidden)
    await asWaiter()
    const r = await s.call<{ order: Order; kot: { id: string } | null }>('orders.save', draft([line(tea.id, 2)], { tableId: t1.id }), { sendToKitchen: true })
    await asKitchen()
    await s.call('kitchen.setStatus', r.kot!.id, 'preparing') // the kitchen still updates its tickets
    await asCashier()
    // Adding to the order is fine.
    const o = r.order
    await s.call('orders.save', draft([...o.items, line(tea.id, 1)], { id: o.id, tableId: t1.id }))
  } finally { s.close() }
})

test('M5: taking away items already sent to the kitchen needs “Cancel / void orders”', async () => {
  const { s, t1, tea, biryani, asCashier, asOwner } = await shop()
  try {
    await asCashier()
    const r = await s.call<{ order: Order }>('orders.save', draft([line(tea.id, 2), line(biryani.id, 1)], { tableId: t1.id }), { sendToKitchen: true })
    const o = r.order
    const [teaLine, biryaniLine] = o.items
    assert.equal(teaLine.kotQty, 2)
    // Remove the sent biryani, or cut the sent tea below 2: refused for a cashier.
    await assert.rejects(s.call('orders.save', draft([teaLine], { id: o.id, tableId: t1.id })), forbidden)
    await assert.rejects(s.call('orders.save', draft([{ ...teaLine, qty: 1 }, biryaniLine], { id: o.id, tableId: t1.id })), forbidden)
    // Saving it unchanged, or adding, still works.
    await s.call('orders.save', draft([teaLine, biryaniLine], { id: o.id, tableId: t1.id }))
    await s.call('orders.save', draft([{ ...teaLine, qty: 3 }, biryaniLine], { id: o.id, tableId: t1.id }))
    // The owner (with Cancel / void) may remove it.
    asOwner()
    await s.call('orders.save', draft([{ ...teaLine, qty: 3 }], { id: o.id, tableId: t1.id }))
    assert.equal((await get(s, o.id)).items.length, 1)
  } finally { s.close() }
})

test('M4: an approved counter price stays with its item — swapping the item on that line needs the price permission', async () => {
  const { s, t1, tea, biryani, asCashier, asOwner } = await shop()
  try {
    asOwner()
    const r = await s.call<{ order: Order }>('orders.save', draft([line(biryani.id, 1, { priceOverride: 10 })], { tableId: t1.id }))
    const ln = r.order.items[0]
    assert.equal(ln.unitPrice, 10)
    await asCashier()
    // Same item, same approved price: saving again is fine (no impact).
    await s.call('orders.save', draft([{ ...ln, priceOverride: 10 }], { id: r.order.id, tableId: t1.id }))
    // Same line id, another item at that price: refused.
    await assert.rejects(s.call('orders.save', draft([{ ...ln, productId: tea.id, priceOverride: 10 }], { id: r.order.id, tableId: t1.id })), forbidden)
  } finally { s.close() }
})

test('M3: a repeated QR order request is answered once — no second accept, no items merged twice', async () => {
  const { s, t1, tea, biryani, asWaiter } = await shop()
  try {
    await asWaiter()
    const running = (await s.call<{ order: Order }>('orders.save', draft([line(tea.id, 1)], { tableId: t1.id }))).order
    s.setToken(null)
    s.setRequestId('qr-repeat-12345678')
    const input = { type: 'dine_in', tableId: t1.id, items: [{ productId: biryani.id, variantId: null, addOnIds: [], qty: 1, notes: '' }], guest: { name: '', phone: '', address: '' }, notes: '' }
    const first = await s.call<{ orderId: string }>('public.placeOrder', s.businessId, input)
    await asWaiter()
    const after1 = await get(s, running.id)
    const qty1 = after1.items.reduce((a, i) => a + i.qty, 0)
    assert.equal(qty1, 2, 'merged once into the running order')
    s.setToken(null)
    const again = await s.call<{ orderId: string }>('public.placeOrder', s.businessId, input) // same request id
    s.setRequestId(null)
    assert.equal(again.orderId, first.orderId)
    await asWaiter()
    const after2 = await get(s, running.id)
    assert.equal(after2.items.reduce((a, i) => a + i.qty, 0), qty1, 'not merged again')
    assert.equal(after2.status, 'open')
  } finally { s.close() }
})

test('M3: accepting a QR order twice is refused the second time, nothing changes', async () => {
  const { s, tea } = await shop()
  try {
    await s.call('business.update', { qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    s.setToken(null)
    const placed = await s.call<{ orderId: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: tea.id, variantId: null, addOnIds: [], qty: 2, notes: '' }], guest: { name: 'Anu', phone: '9811111111', address: '' }, notes: '' })
    s.setToken(s.ownerToken)
    await s.call('qr.accept', placed.orderId)
    const a = await get(s, placed.orderId)
    await assert.rejects(s.call('qr.accept', placed.orderId), /no longer pending/) // already refused by qr.accept
    const b = await get(s, placed.orderId)
    assert.deepEqual(b.items.map((i) => i.qty), a.items.map((i) => i.qty))
    assert.equal(b.qrStatus, 'accepted')
  } finally { s.close() }
})
