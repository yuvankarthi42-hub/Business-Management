import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type Pur = { id: string; number: string; supplierName: string; supplierBillNo: string; date: string; status: string; total: number; tax: number; balance: number; lines: unknown[] }
type Page = { rows: Pur[]; next: { at: string; id: string } | null; count: number; month: { total: number; tax: number; unpaid: number; bills: number } }
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - n * 864e5))

test('purchases.page: pages joined = every bill of the branch (newest date first, many bills on one date), month cards, count, search; lines = purchases.get', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { gstin: '', billing: { taxEnabled: true, taxMode: 'exclusive' }, modules: { inventory: true } })
    const items: { id: string }[] = []
    for (let i = 0; i < 6; i++) items.push(await s.call('products.save', { name: `Item ${i}`, price: 100 + i, trackStock: true, stock: 1000 }))
    const supA = await s.call<{ id: string }>('suppliers.save', { name: 'Arani Weavers' })
    const supB = await s.call<{ id: string }>('suppliers.save', { name: 'Bangalore Mills', stateCode: '29' }) // IGST
    const annex = await s.call<{ id: string }>('branches.save', { name: 'Annex' })
    const made: Pur[] = []
    const buy = async (k: number, date: string) => made.push(await s.call<Pur>('purchases.create', {
      supplierId: k % 3 ? supA.id : supB.id, supplierBillNo: `SB-${k}`, date, paid: k % 3 === 0 ? 0 : k % 3 === 1 ? 5 : 9, method: 'cash',
      lines: items.slice(0, 1 + (k % 5)).map((p, j) => ({ productId: p.id, qty: 1 + j, cost: 10 + k + j * 0.5, taxRate: [0, 5, 12, 18][(k + j) % 4] })),
    }))
    for (let k = 0; k < 24; k++) await buy(k, day(0))        // many on one date (today)
    for (let k = 24; k < 40; k++) await buy(k, day(k % 5))   // a few dates this week
    for (let k = 40; k < 48; k++) await buy(k, day(35 + k))  // last month(s)
    s.setBranch(annex.id); for (let k = 48; k < 55; k++) await buy(k, day(1)); s.setBranch(null)
    for (const v of [made[2], made[30]]) await s.call('purchases.void', v.id, 'Entered twice')
    const month = day(0).slice(0, 7)
    for (const branch of ['all', null, annex.id]) {
      s.setBranch(branch)
      // The bills this branch view sees, each read on its own (voids included).
      const mine = branch === annex.id ? made.slice(48) : branch === 'all' ? made : made.slice(0, 48)
      const list = await Promise.all(mine.map((p) => s.call<Pur>('purchases.get', p.id)))
      const byId = new Map(list.map((p) => [p.id, p]))
      const walk = async (q = '') => { const out: Pur[] = []; let before: Page['next'] = null, last!: Page; do { last = await s.call<Page>('purchases.page', { q, month }, before, 7); out.push(...last.rows); before = last.next } while (before); return { out, last } }
      const { out, last } = await walk()
      assert.equal(new Set(out.map((p) => p.id)).size, out.length, `no bill twice · ${branch ?? 'Main'}`)
      assert.deepEqual(out.map((p) => p.id).sort(), list.map((p) => p.id).sort(), `pages joined = every bill · ${branch ?? 'Main'}`)
      for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].date >= out[i].date, 'newest bill date first')
      for (const p of out) assert.deepEqual(p, byId.get(p.id), 'each row = purchases.get')
      assert.equal(last.count, list.length)
      const fin = list.filter((p) => p.status === 'final' && p.date.startsWith(month))
      assert.deepEqual(last.month, { total: r2(fin.reduce((a, p) => a + p.total, 0)), tax: r2(fin.reduce((a, p) => a + p.tax, 0)), unpaid: r2(fin.reduce((a, p) => a + p.balance, 0)), bills: fin.length }, 'the month cards, as the screen added them up')
      for (const q of ['bangalore', 'SB-1', 'PUR-', 'zzz']) {
        const found = (await walk(q)).out.map((p) => p.id).sort()
        const want = list.filter((p) => [p.number, p.supplierName, p.supplierBillNo].some((x) => x.toLowerCase().includes(q.toLowerCase()))).map((p) => p.id).sort()
        assert.deepEqual(found, want, `search "${q}"`)
      }
    }
    s.setBranch(null)
    // Inventory off: an empty page.
    await s.call('business.update', { modules: { inventory: false } })
    assert.deepEqual(await s.call('purchases.page', { month }), { rows: [], next: null, count: 0, month: { total: 0, tax: 0, unpaid: 0, bills: 0 } })
  } finally { s.close() }
})
