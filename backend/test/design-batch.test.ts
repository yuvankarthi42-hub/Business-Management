import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextInStoreBarcode } from '@/lib/barcode'
import { outgoing } from '../src/core/meter'
import { withShop } from './fixtures'
import { listProducts, TEST_DB } from './helpers'

type P = { id: string; name: string; sku: string; barcode: string; stock: number; active: boolean; details?: { design?: string; fabric?: string; colour?: string; size?: string } | null }
type M = { productId: string; type: string; qty: number; balanceAfter: number; note: string }

const base = { name: 'Cotton Saree', categoryId: null, fabric: 'Cotton', mrp: 1500, price: 1350, costPrice: 900, taxRateId: null, unit: 'pc', lowStockAt: 1 }
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ colour: `Colour ${i}`, size: i % 3 ? 'M' : '', stock: i % 4 }))

test('saveDesign: 120 rows — every item, code, stock and history entry as one by one', async () => {
  const s = await withShop()
  try {
    // Codes already used: an earlier design, and a hand-typed in-store code further on.
    await s.call('products.saveDesign', { ...base, design: 'OLD-1', rows: rowsOf(3) })
    await s.call('products.save', { name: 'Hand coded', price: 10, barcode: '2000000005005' })
    let codes = (await listProducts<P>(s)).map((p) => p.barcode ?? '')
    const want: string[] = []
    for (let i = 0; i < 120; i++) { const bc = nextInStoreBarcode(codes); want.push(bc); codes = [...codes, bc] }

    const rows = rowsOf(120)
    const made = await s.call<P[]>('products.saveDesign', { ...base, design: 'NEW-120', rows })
    assert.equal(made.length, 120)
    assert.deepEqual(made.map((p) => p.barcode), want, 'same codes, in the same order')
    assert.deepEqual(made.map((p) => p.name), rows.map((r) => ['Cotton Saree', [r.colour, r.size].filter(Boolean).join(' / ')].join(' · ')))
    assert.deepEqual(made.map((p) => p.stock), rows.map((r) => r.stock))
    assert.deepEqual(made[1].details, { design: 'NEW-120', fabric: 'Cotton', colour: 'Colour 1', size: 'M' })
    assert.ok(made.every((p) => p.sku === 'NEW-120' && p.active))

    // One "opening" history entry for each item with stock, with its balance; none for 0 stock.
    const hist = await s.call<M[]>('inventory.movements', null, null, 500)
    const mine = hist.filter((m) => made.some((p) => p.id === m.productId))
    assert.equal(mine.length, rows.filter((r) => r.stock > 0).length)
    for (const m of mine) {
      const p = made.find((x) => x.id === m.productId)!
      assert.equal(m.qty, p.stock); assert.equal(m.balanceAfter, p.stock); assert.equal(m.note, 'Opening stock')
    }
    // The catalogue read gives the same items.
    const all = await listProducts<P>(s)
    assert.deepEqual(all.filter((p) => p.sku === 'NEW-120').map((p) => [p.id, p.barcode, p.stock]), made.map((p) => [p.id, p.barcode, p.stock]))
  } finally { s.close() }
})

test('saveDesign: duplicates checked against active items only; a refused design saves nothing', async () => {
  const s = await withShop()
  try {
    const made = await s.call<P[]>('products.saveDesign', { ...base, design: 'KS-9', rows: [{ colour: 'Red', size: '', stock: 1 }, { colour: 'Blue', size: 'L', stock: 2 }] })
    await assert.rejects(s.call('products.saveDesign', { ...base, design: 'ks-9', rows: [{ colour: 'Green', size: '', stock: 1 }, { colour: 'blue', size: 'l', stock: 1 }] }), /already exists/)
    // Turned off → the same design + colour can be made again.
    await s.call('products.save', { id: made[0].id, name: made[0].name, active: false })
    const again = await s.call<P[]>('products.saveDesign', { ...base, design: 'KS-9', rows: [{ colour: 'red', size: '', stock: 1 }] })
    assert.equal(again.length, 1)
    // Bad HSN on a 3-row design: nothing is saved.
    const before = (await listProducts<P>(s)).length
    await assert.rejects(s.call('products.saveDesign', { ...base, design: 'KS-10', hsn: '12', rows: rowsOf(3) }))
    assert.equal((await listProducts<P>(s)).length, before)
    const hist = await s.call<M[]>('inventory.movements', null, null, 500)
    assert.equal(hist.length, 3, 'only the opening stock of the 3 saved items')
  } finally { s.close() }
})

// The in-process memory store has no SQL (one-by-one path); the hrana fake server counts requests twice.
test('saveDesign: the same few round trips for 2 rows or 120', { skip: TEST_DB !== 'sqlite' }, async () => {
  const s = await withShop()
  try {
    const n = async (rows: number, design: string) => { const a = outgoing.n; await s.call('products.saveDesign', { ...base, design, rows: rowsOf(rows) }); return outgoing.n - a }
    const small = await n(2, 'R-2'), big = await n(120, 'R-120')
    assert.ok(big - small <= 2, `2 rows: ${small} requests, 120 rows: ${big}`)
    assert.ok(big <= 20, `120 rows: ${big} requests`)
  } finally { s.close() }
})
