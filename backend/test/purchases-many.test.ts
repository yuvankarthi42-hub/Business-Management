import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { listProducts } from './helpers'

type P = { id: string; costPrice: number; hsn: string | null; stock: number; trackStock: boolean }
type Pur = { id: string; total: number; lines: { id: string; productId: string; qty: number }[] }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const line = (p: { id: string }, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })

test('purchase bill with many lines: stock, cost, HSN, batches and void — all lines saved together', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: true, taxMode: 'exclusive' }, modules: { inventory: true } })
    const sup = await s.call<{ id: string }>('suppliers.save', { name: 'Arani Weavers' })
    const cloth = await s.call<P>('products.save', { name: 'Cloth', price: 100, costPrice: 50, trackStock: true, stock: 4, hsn: '5208' })
    const loose = await s.call<P>('products.save', { name: 'Loose item', price: 80, costPrice: 10, trackStock: false }) // starts tracking stock on purchase
    const bag = await s.call<P>('products.save', { name: 'Bag', price: 60, costPrice: 20, trackStock: true })
    const curd = await s.call<P>('products.save', { name: 'Curd', price: 30, costPrice: 15, trackStock: true, trackExpiry: true })
    await s.call('inventory.adjust', curd.id, 'purchase', 2, 'opening', 15, { batchNo: 'B1', expiry: '2030-01-01' }) // an older batch with the same number
    const p = await s.call<Pur>('purchases.create', { supplierId: sup.id, supplierBillNo: 'A-1', date: today(), paid: 0, method: 'cash', lines: [
      { productId: cloth.id, qty: 10, cost: 55.5, taxRate: 5 }, { productId: loose.id, qty: 4, cost: 12, taxRate: 5 }, { productId: bag.id, qty: 3, cost: 22, taxRate: 18, hsn: '4202' },
      { productId: curd.id, qty: 6, cost: 16, taxRate: 5, batchNo: 'B1', expiry: '2030-01-01' }, { productId: curd.id, qty: 5, cost: 17, taxRate: 5, batchNo: 'B2', expiry: '2030-02-02' },
    ] })
    assert.equal(p.lines.length, 5)
    const byId = new Map((await listProducts<P>(s)).map((x) => [x.id, x]))
    assert.deepEqual([byId.get(cloth.id)!.stock, byId.get(loose.id)!.stock, byId.get(bag.id)!.stock, byId.get(curd.id)!.stock], [14, 4, 3, 13])
    assert.ok(byId.get(loose.id)!.trackStock, 'bought items start tracking stock')
    assert.equal(byId.get(curd.id)!.costPrice, 17, 'two lines for one item: the last line’s cost')
    assert.deepEqual([byId.get(cloth.id)!.costPrice, byId.get(cloth.id)!.hsn, byId.get(bag.id)!.hsn], [55.5, '5208', '4202'], 'own HSN kept; missing HSN taken from the bill')
    // Batches: the old B1 (opening stock) and the new B2 each point at their bill line, with that line's cost.
    const batches = await s.db.select('stock_batches', { where: { product_id: curd.id } })
    const curdLines = p.lines.filter((l) => l.productId === curd.id)
    assert.deepEqual(batches.map((b) => [b.batch_no, Number(b.qty_left_milli) / 1000, b.purchase_item_id, b.cost_minor]).sort(), [['B1', 8, curdLines[0].id, 1600], ['B2', 5, curdLines[1].id, 1700]].sort())
    const moves = await s.db.select('stock_movements', { where: { ref_id: p.id } })
    assert.equal(moves.length, 5)

    // Void blocked when some of it is sold; the message names the item.
    const sold = await s.call<{ order: { id: string; total: number } }>('orders.save', { type: 'counter', tableId: null, customerId: null, items: [line(bag, 2)], discount: 0, notes: '', source: 'pos' })
    await s.call('orders.settle', sold.order.id, [{ method: 'cash', amount: sold.order.total }])
    await assert.rejects(s.call('purchases.void', p.id, 'mistake'), /Bag: only 1 left in stock — the purchase can’t be voided/)
    assert.equal((await listProducts<P>(s)).find((x) => x.id === cloth.id)!.stock, 14, 'nothing taken out when blocked')

    // A second bill voids cleanly: all its stock goes back out.
    const p2 = await s.call<Pur>('purchases.create', { supplierId: sup.id, supplierBillNo: 'A-2', date: today(), paid: 0, method: 'cash', lines: [{ productId: cloth.id, qty: 2, cost: 56, taxRate: 5 }, { productId: curd.id, qty: 1, cost: 16, taxRate: 5, batchNo: 'B3', expiry: '2030-03-03' }] })
    await s.call('purchases.void', p2.id, 'wrong bill')
    const after = new Map((await listProducts<P>(s)).map((x) => [x.id, x]))
    assert.deepEqual([after.get(cloth.id)!.stock, after.get(curd.id)!.stock], [14, 13])
    await assert.rejects(s.call('purchases.void', p2.id, 'again'), /already voided/)
  } finally { s.close() }
})
