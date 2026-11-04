import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP, listProducts } from './helpers'
import { TursoDb } from '../src/db/turso'

type P = { id: string; name: string; price: number; mrp: number | null }
const ERR = (e: unknown) => ({ error: (e as Error).message })

/** One shop with textile-style items; returns the shop and its items by name. */
async function shop() {
  const s = await withShop()
  await s.call('business.update', { billing: { taxEnabled: false } })
  const silk = await s.call<{ id: string }>('categories.save', { name: 'Silk', emoji: '' })
  const cotton = await s.call<{ id: string }>('categories.save', { name: 'Cotton', emoji: '' })
  const byName: Record<string, P> = {}
  const add = async (name: string, x: Record<string, unknown>) => { byName[name] = await s.call<P>('products.save', { name, ...x }) }
  for (let i = 0; i < 30; i++) await add(`Silk ${i}`, { price: 1000 + i * 37, mrp: 1200 + i * 41.5, categoryId: silk.id })
  for (let i = 0; i < 12; i++) await add(`Cotton ${i}`, { price: 300 + i, mrp: i % 3 ? 350 + i * 9.9 : null, categoryId: cotton.id }) // some without MRP
  await add('Sized kurta', { price: 500, mrp: 600, categoryId: cotton.id, variants: [{ id: 'v1', name: 'M', price: 500 }, { id: 'v2', name: 'L', price: 520 }] })
  await add('Old stock', { price: 900, mrp: 1000, categoryId: silk.id, active: false })
  await add('At MRP', { price: 800, mrp: 800, categoryId: silk.id })
  await add('No category', { price: 250, mrp: 299 })
  return { s, silk: silk.id, cotton: cotton.id, byName }
}

test('products.setDiscount: the light read + batched prices give exactly the old results and prices', { skip: !PER_SHOP }, async () => {
  const proto = TursoDb.prototype as unknown as { sqlMany?: unknown }
  const batch = proto.sqlMany
  const a = await shop(), b = await shop()
  try {
    const steps = (x: Awaited<ReturnType<typeof shop>>) => [
      { categoryId: x.silk, pct: 10, round: 1 }, { categoryId: x.cotton, pct: 33.3, round: 5 }, { categoryId: null, pct: 15, round: 10 },
      { productIds: [x.byName['Silk 3'].id, x.byName['Sized kurta'].id, x.byName['Old stock'].id, x.byName['Cotton 0'].id, 'abc'], pct: 20, round: 1 },
      { categoryId: x.silk, pct: 0, round: 1 },            // back to MRP
      { categoryId: x.silk, pct: 0, round: 1 },            // again: nothing changes
      { productIds: ['999999'], pct: 10, round: 1 },        // nothing matches
      { categoryId: x.silk, pct: 95, round: 1 },           // bad %
    ]
    const run = async (x: Awaited<ReturnType<typeof shop>>) => {
      const out: unknown[] = []
      for (const st of steps(x)) out.push(await x.s.call('products.setDiscount', st).catch(ERR))
      await x.s.call('products.setDiscount', { categoryId: '99999', pct: 10, round: 1 }).then(() => out.push('?'), (e) => out.push(ERR(e)))
      const prices = (await listProducts<P>(x.s)).map((p) => [p.name, p.price]).sort()
      return { out, prices }
    }
    const fast = await run(a)
    proto.sqlMany = undefined // the old way
    const slow = await run(b)
    proto.sqlMany = batch
    // Same answers (ids differ between the two shops: compare by item name).
    const names = (x: Awaited<ReturnType<typeof shop>>, o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'ids' ? (v as string[]).map((id) => Object.values(x.byName).find((p) => p.id === id)?.name ?? id) : v)))
    assert.deepEqual(names(a, fast.out), names(b, slow.out))
    assert.deepEqual(fast.prices, slow.prices)
    assert.ok((fast.out[0] as { updated: number }).updated > 20, 'prices really changed')
  } finally { proto.sqlMany = batch; a.s.close(); b.s.close() }
})

test('products.setDiscount: all items at once — every price saved in one request (100 per statement)', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const rows = Array.from({ length: 450 }, (_, i) => ({ row: i + 2, name: `Saree ${i}`, price: 1000 + i, mrp: 1500 + i * 3, categoryName: 'Sarees' }))
    await s.call('products.importMany', rows, { onExisting: 'skip', fileName: 'x.csv' })
    const r = await s.call<{ updated: number; ids: string[] }>('products.setDiscount', { categoryId: null, pct: 12.5, round: 10 })
    assert.equal(r.updated, 450)
    const list = await listProducts<P>(s)
    for (const p of list) assert.equal(p.price, Math.round(((p.mrp ?? 0) * (1 - 0.125)) / 10) * 10 || p.price, p.name)
  } finally { s.close() }
})
