import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string; price: number; stock: number; stockByBranch: Record<string, number>; variants: { id: string; name: string; price: number }[] }
type O = { id: string; status: string; invoiceNumber: string; total: number; paid: number; balance: number; items: { id: string; qty: number; unitPrice: number; kotQty: number }[] }

test('billing: re-pricing, stock, numbers, idempotency, dues, cancel', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const milk = await s.call<P>('products.save', { name: 'Milk 500 ml', price: 27, trackStock: true, stock: 10, unit: 'pc' })
    assert.equal(milk.stock, 10)
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 0, variants: [{ id: 'v1', name: 'Small', price: 10 }, { id: 'v2', name: 'Large', price: 15 }] })
    assert.equal(tea.variants.length, 2)
    const line = (p: P, qty: number, extra = {}) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0, ...extra })
    const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

    // The browser says ₹1 — the server bills the catalogue price.
    const o1 = await s.call<O>('orders.checkout', draft([line(milk, 2), line(tea, 1, { variantId: tea.variants[1].id })]), [{ method: 'cash', amount: 69 }])
    assert.equal(o1.status, 'completed')
    assert.equal(o1.total, 69) // 2 × 27 + 15
    assert.equal(o1.invoiceNumber, 'INV-10001')
    const o2 = await s.call<O>('orders.checkout', draft([line(milk, 1)]), [{ method: 'upi', amount: 27 }])
    assert.equal(o2.invoiceNumber, 'INV-10002')
    const list = await s.call<P[]>('products.list')
    assert.equal(list.find((p) => p.id === milk.id)!.stock, 7)
    await assert.rejects(s.call('orders.checkout', draft([line(milk, 1)]), [{ method: 'cash', amount: 100 }]), /exceeds/)
    await assert.rejects(s.call('orders.checkout', draft([line(milk, 1)]), [{ method: 'cash', amount: 10 }]), /Select a customer/)

    // Credit to a customer, then collect the due.
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Raja', phone: '9800011122' })
    const o3 = await s.call<O>('orders.checkout', draft([line(milk, 2)], { customerId: cust.id }), [{ method: 'cash', amount: 20 }])
    assert.equal(o3.balance, 34)
    const custs = await s.call<{ id: string; stats: { outstanding: number; orderCount: number } }[]>('customers.list')
    assert.equal(custs[0].stats.outstanding, 34)
    await assert.rejects(s.call('customers.collectDue', cust.id, 50, 'cash'), /more than outstanding/)
    await s.call('customers.collectDue', cust.id, 34, 'upi')
    const after = await s.call<{ order: O }>('orders.get', o3.id)
    assert.equal(after.order.balance, 0)

    // Cancel a bill: stock comes back, payments are voided.
    await s.call('orders.cancel', o2.id, 'wrong item')
    const list2 = await s.call<P[]>('products.list')
    assert.equal(list2.find((p) => p.id === milk.id)!.stock, 6) // 10 − 2 − 1 − 2 + 1
    const pays = await s.call<{ orderId: string; voided: boolean }[]>('payments.list', new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString())
    assert.ok(pays.filter((p) => p.orderId === o2.id).every((p) => p.voided))
  } finally { s.close() }
})

test('checkout retried with the same request id makes one bill', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const p = await s.call<P>('products.save', { name: 'Pen', price: 10, trackStock: true, stock: 5 })
    const body = { type: 'counter', tableId: null, customerId: null, items: [{ id: 'a', productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty: 1, unit: 'pc', unitPrice: 10, taxRate: 0, notes: '', kotQty: 0 }], discount: 0, notes: '', source: 'pos' }
    const rid = 'req-123456'
    const call = async () => {
      const res = await fetch(`${s.base}/rpc/orders.checkout`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.ownerToken}`, 'x-request-id': rid }, body: JSON.stringify({ args: [body, [{ method: 'cash', amount: 10 }]] }) })
      return (await res.json()) as { data: O; effects?: { stock: { stock: number }[] } }
    }
    const a = await call(), b = await call()
    assert.equal(a.data.id, b.data.id)
    assert.equal(a.effects!.stock[0].stock, 4)
    const prods = await s.call<P[]>('products.list')
    assert.equal(prods[0].stock, 4) // sold once
  } finally { s.close() }
})

test('tables, running order, kitchen tickets and QR menu', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, tables: true, kitchen: true, qrOrdering: true, products: true }, qr: { orderTypes: ['dine_in', 'takeaway'], autoAccept: false, baseUrl: '' } })
    const t1 = await s.call<{ id: string }>('tables.save', { label: 'T1', floor: 'Main', seats: 4 })
    const dosa = await s.call<P>('products.save', { name: 'Dosa', price: 60, sendToKitchen: true })
    const item = (qty: number, id = 'n1') => ({ id, productId: dosa.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
    const r = await s.call<{ order: O; kot: { items: { qty: number }[] } }>('orders.save', { type: 'dine_in', tableId: t1.id, customerId: null, items: [item(2)], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    assert.equal(r.kot.items[0].qty, 2)
    await assert.rejects(s.call('orders.save', { type: 'dine_in', tableId: t1.id, customerId: null, items: [item(1)], discount: 0, notes: '', source: 'pos' }), /already has a running order/)
    // Add one more: only the extra one goes to the kitchen.
    const lineId = r.order.items[0].id
    const r2 = await s.call<{ order: O; kot: { items: { qty: number }[] } }>('orders.save', { id: r.order.id, type: 'dine_in', tableId: t1.id, customerId: null, items: [{ ...item(3, lineId) }], discount: 0, notes: '', source: 'pos' }, { sendToKitchen: true })
    assert.equal(r2.kot.items[0].qty, 1)
    const kots = await s.call<{ id: string; status: string }[]>('kitchen.list')
    assert.equal(kots.length, 2)
    await s.call('kitchen.setStatus', kots[0].id, 'ready')
    const billed = await s.call<O>('orders.settle', r.order.id, [{ method: 'cash', amount: 180 }])
    assert.equal(billed.total, 180)

    // QR menu (no login) and a guest order waiting for staff.
    s.setToken(null)
    const menu = await s.call<{ products: { id: string }[]; tables: { id: string }[] }>('public.menu', s.businessId, null, t1.id)
    assert.equal(menu.products.length, 1)
    const placed = await s.call<{ orderId: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: dosa.id, variantId: null, addOnIds: [], qty: 2, notes: '' }], guest: { name: 'Anu', phone: '9811122233', address: '' }, notes: '' })
    const track = await s.call<{ status: string; qrStatus: string; total: number }>('public.order', s.businessId, placed.orderId)
    assert.equal(track.qrStatus, 'pending')
    assert.equal(track.total, 120)
    s.setToken(s.ownerToken)
    const pending = await s.call<O[]>('qr.pending')
    assert.equal(pending.length, 1)
    await s.call('qr.accept', placed.orderId)
    assert.equal((await s.call<O[]>('qr.pending')).length, 0)
  } finally { s.close() }
})

test('takeaway: KOT, then open the running bill and pay — no second order, no duplicate KOT', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, kitchen: true, products: true } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 20, sendToKitchen: true })
    const vada = await s.call<P>('products.save', { name: 'Vada', price: 15, sendToKitchen: true })
    const line = (p: P, qty: number, extra = {}) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0, ...extra })
    const draft = (items: unknown[], extra = {}) => ({ type: 'takeaway', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

    // Billing page → KOT: a running takeaway order and one kitchen ticket.
    const held = await s.call<{ order: O; kot: { items: unknown[] } | null }>('orders.save', draft([line(tea, 2)]), { sendToKitchen: true })
    assert.ok(held.kot)
    assert.equal((await s.call<unknown[]>('kitchen.list')).length, 1)

    // Open the running bill (the app sends the items as the server returned them) and pay.
    const [running] = await s.call<(O & { type: string })[]>('orders.running')
    assert.equal(running.id, held.order.id)
    const paid = await s.call<O>('orders.checkout', draft(running.items, { id: running.id }), [{ method: 'cash', amount: 40 }])
    assert.equal(paid.id, held.order.id) // the same order, now billed
    assert.equal(paid.status, 'completed')
    assert.equal((await s.call<unknown[]>('kitchen.list')).length, 1) // no duplicate KOT
    assert.equal((await s.call<unknown[]>('orders.running')).length, 0)

    // Another running bill, one item added before paying: only that item goes to the kitchen.
    const held2 = await s.call<{ order: O }>('orders.save', draft([line(tea, 1)]), { sendToKitchen: true })
    const [r2] = await s.call<O[]>('orders.running')
    await s.call('orders.checkout', draft([...r2.items, line(vada, 3)], { id: held2.order.id }), [{ method: 'upi', amount: 65 }])
    const kots = await s.call<{ orderId: string; items: { qty: number }[] }[]>('kitchen.list')
    const forOrder2 = kots.filter((k) => k.orderId === held2.order.id)
    assert.equal(forOrder2.length, 2)
    assert.deepEqual(forOrder2.map((k) => k.items.map((i) => i.qty)).sort(), [[1], [3]])
  } finally { s.close() }
})
