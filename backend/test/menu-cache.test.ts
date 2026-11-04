import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string; stock: number; costPrice: number; wholesalePrice: number | null; variants: { wholesalePrice: number | null }[] }
type Menu = { products: P[] }
const line = (p: { id: string }, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[]) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos' })

test('QR menu copy: kept after ordinary bills, refreshed when an item sells out or comes back; nothing private sent', async () => {
  const s = await withShop()
  const shared = (s.env as unknown as { shared: { get(k: string): Promise<string | null> } }).shared
  const version = () => shared.get(`menuv:${s.businessId}`)
  try {
    await s.call('business.update', { billing: { taxEnabled: false, wholesale: { enabled: true, label: 'Wholesale' } }, modules: { qrOrdering: true, inventory: true }, qr: { orderTypes: ['takeaway'], autoAccept: false, baseUrl: '' } })
    const dosa = await s.call<P>('products.save', { name: 'Dosa', price: 40, costPrice: 15, trackStock: true, stock: 3, wholesalePrice: 30, variants: [{ id: 'v1', name: 'Ghee', price: 60, wholesalePrice: 45 }] })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 15, costPrice: 5 }) // stock not tracked
    const menu = () => s.call<Menu>('public.menu', s.businessId, null, null)
    const has = (m: Menu, p: { id: string }) => m.products.some((x) => x.id === p.id)

    const first = await menu()
    assert.ok(has(first, dosa) && has(first, tea))
    // Customers never get cost or wholesale prices (not even a variant's).
    for (const p of first.products) assert.ok(p.costPrice === 0 && p.wholesalePrice === null && p.variants.every((v) => v.wholesalePrice === null), JSON.stringify(p))
    // The cached copy is sent as JSON text: byte for byte what a fresh build sends.
    const raw = async () => (await fetch(`${s.base}/rpc/public.menu`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: [s.businessId, null, null] }) }))
    const r1 = await raw()
    assert.match(r1.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(JSON.parse(await r1.text()), { data: first })

    // Ordinary bills (3 → 2 → 1 left, and an untracked item): the copy stays (no rebuild for the next scan).
    const v0 = await version()
    await s.call('orders.checkout', draft([line(dosa), line(tea, 2)]), [{ method: 'cash', amount: 70 }])
    await s.call('orders.checkout', draft([line(dosa)]), [{ method: 'cash', amount: 40 }])
    assert.equal(await version(), v0, 'nothing sold out: same menu version')
    assert.ok(has(await menu(), dosa))

    // The last one sold: the menu is refreshed and Dosa is hidden.
    await s.call('orders.checkout', draft([line(dosa)]), [{ method: 'cash', amount: 40 }])
    assert.notEqual(await version(), v0, 'sold out: new menu version')
    assert.ok(!has(await menu(), dosa) && has(await menu(), tea))

    // Stock in: back on the menu.
    await s.call('inventory.adjust', dosa.id, 'purchase', 5, 'stock in')
    assert.ok(has(await menu(), dosa))
    // A bill that doesn't change any stock flip (untracked item only): copy kept.
    const v1 = await version()
    await s.call('orders.checkout', draft([line(tea)]), [{ method: 'cash', amount: 15 }])
    assert.equal(await version(), v1)

    // TV board: no cost or wholesale either.
    await s.call('business.update', { modules: { specials: true } })
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    await s.call('specials.save', day, [{ productId: dosa.id, specialPrice: null, tag: 'Hot' }])
    const board = await s.call<{ items: { product: P }[] }>('public.specials', s.businessId)
    assert.equal(board.items.length, 1)
    assert.ok(board.items.every(({ product: p }) => p.costPrice === 0 && p.wholesalePrice === null && p.variants.every((v) => v.wholesalePrice === null)))
    assert.deepEqual(await s.call('public.specials', s.businessId), board, 'cached board = fresh board')
  } finally { s.close() }
})
