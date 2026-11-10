import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP, TEST_DB } from './helpers'
import { gstinCheckChar } from '../../src/core/gst'

type P = { id: string }
type O = { id: string; total: number; items: { id: string }[] }
const line = (p: P, qty = 1, extra = {}) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0, ...extra })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })

/** The same report twice: added up by the database (Turso) and by the full read (REPORTS_SQL=off). */
async function both<T>(fn: () => Promise<T>) {
  const fast = await fn()
  process.env.REPORTS_SQL = 'off'
  try { return { fast, full: await fn() } } finally { delete process.env.REPORTS_SQL }
}

test('reports.summary: the database totals equal the full calculation, field by field', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: true, taxMode: 'exclusive', defaultTaxRateId: null } })
    const cat = await s.call<P>('categories.save', { name: 'Food', emoji: '' })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 15, costPrice: 6, categoryId: cat.id })
    const rice = await s.call<P>('products.save', { name: 'Rice (loose)', price: 62.5, costPrice: 51, unit: 'kg', trackStock: true, stock: 500 })
    const cake = await s.call<P & { addOns: { id: string }[] }>('products.save', { name: 'Cake', price: 120, costPrice: 70, addOns: [{ id: 'a1', name: 'Candle', price: 10 }] })
    const cust = await s.call<P>('customers.save', { name: 'Anu', phone: '9811100001' })
    const annex = await s.call<P>('branches.save', { name: 'Annex' })
    const bill = async (items: unknown[], pays: { method: string; amount: number }[], extra = {}) => {
      const o = await s.call<{ order: O }>('orders.save', draft(items, extra))
      return (await s.call<O>('orders.settle', o.order.id, pays.map((p) => (p.amount < 0 ? { ...p, amount: o.order.total } : p))))
    }
    const all = -1 // pay the whole bill
    for (let i = 0; i < 6; i++) await bill([line(tea, 2), line(rice, 1.5)], [{ method: i % 2 ? 'upi' : 'cash', amount: all }])
    await bill([line(cake, 1, { addOns: [{ id: cake.addOns[0]?.id ?? 'a1', name: 'Candle', price: 10 }] })], [{ method: 'card', amount: all }], { type: 'takeaway' })
    await bill([line(rice, 0.25), line(tea, 3)], [{ method: 'cash', amount: all }], { type: 'delivery', discount: 5 })
    const credit = await bill([line(cake, 2)], [{ method: 'cash', amount: 100 }], { customerId: cust.id }) // part paid, rest on credit
    await s.call('customers.collectDue', cust.id, 50, 'upi')
    const back = await bill([line(tea, 4), line(rice, 2)], [{ method: 'upi', amount: all }])
    await s.call('returns.create', { orderId: back.id, lines: [{ orderItemId: back.items[0].id, qty: 1, restock: false }, { orderItemId: back.items[1].id, qty: 1, restock: true }], reason: 'other', settle: 'refund', refundMethod: 'cash' })
    const gone = await bill([line(tea)], [{ method: 'cash', amount: all }])
    await s.call('orders.cancel', gone.id, 'mistake')
    await s.call('orders.save', draft([line(tea)], { type: 'takeaway' })) // still running: not in the report
    await s.call('expenses.save', { amount: 500, category: 'rent', method: 'cash', notes: '' })
    await s.call('expenses.save', { amount: 120.5, category: 'electricity', method: 'upi', notes: '' })
    await s.call('expenses.save', { amount: 80, category: 'rent', method: 'cash', notes: '' })
    s.setBranch(annex.id)
    await bill([line(tea, 5)], [{ method: 'cash', amount: all }])
    await s.call('expenses.save', { amount: 60, category: 'transport', method: 'cash', notes: '' })
    await s.call('orders.save', draft([line(tea)], { type: 'takeaway' })) // running in Annex
    s.setBranch(null)
    await s.call('products.save', { name: 'Ghee', price: 300, costPrice: 250, trackStock: true, stock: 1, lowStockAt: 5 }) // low stock
    void credit

    const today0 = new Date(); today0.setHours(0, 0, 0, 0)
    const now = new Date(Date.now() + 1000).toISOString()
    const ranges: [string, string, string][] = [
      ['today (hourly)', today0.toISOString(), now],
      ['this week (daily)', new Date(today0.getTime() - 6 * 864e5).toISOString(), now],
      ['30 days', new Date(Date.now() - 30 * 864e5).toISOString(), now],
    ]
    for (const [name, from, to] of ranges) {
      for (const branch of ['all', null, annex.id]) {
        s.setBranch(branch)
        const { fast, full } = await both(() => s.call<Record<string, unknown>>('reports.summary', from, to))
        assert.deepEqual(fast, full, `${name} · ${branch === 'all' ? 'all branches' : branch ? 'Annex' : 'Main'}`)
      }
      s.setBranch(null)
      // The branch dashboard: every branch's summary plus running / QR / late KOTs / low stock, the same both ways.
      for (const branch of ['all', null]) {
        s.setBranch(branch)
        const { fast, full } = await both(() => s.call<unknown[]>('reports.byBranch', from, to))
        assert.deepEqual(fast, full, `byBranch ${name} · ${branch === 'all' ? 'all branches' : 'Main'}`)
        if (branch === 'all') assert.equal(fast.length, 2)
      }
      s.setBranch(null)
    }
    // Something was really counted (not two empty reports): Main has 10 bills, all branches 11.
    s.setBranch('all')
    const everywhere = await s.call<{ orderCount: number }>('reports.summary', today0.toISOString(), now)
    s.setBranch(null)
    assert.equal(everywhere.orderCount, 11)
    const r = await s.call<{ orderCount: number; returns: number; expenses: number; cancelled: number; topProducts: unknown[] }>('reports.summary', today0.toISOString(), now)
    assert.ok(r.orderCount === 10 && r.returns > 0 && r.expenses > 0 && r.cancelled === 1 && r.topProducts.length === 3)
  } finally { s.close() }
})

test('reports.gst: the database totals equal the line-by-line report (B2B, B2CL, B2CS, returns, HSN, purchases)', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  const gstin = (state: string, pan: string) => { const first = `${state}${pan}1Z`; return first + gstinCheckChar(first) }
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).slice(0, 7)
  try {
    const biz = await s.call<{ billing: { taxRates: { id: string; rate: number }[] } }>('business.update', { gstin: gstin('33', 'AABCS1234D'), billing: { taxEnabled: true, taxMode: 'exclusive', roundOff: false } })
    const rate = (n: number) => biz.billing.taxRates.find((t) => t.rate === n)!.id
    const silk = await s.call<P>('categories.save', { name: 'Silk', emoji: '', hsn: '5007' })
    const saree = await s.call<P>('products.save', { name: 'Silk Saree', price: 1234.57, categoryId: silk.id, taxRateId: rate(5) })
    const gold = await s.call<P>('products.save', { name: 'Zari Saree', price: 60_000, hsn: '5007', taxRateId: rate(5) })
    const cloth = await s.call<P>('products.save', { name: 'Cotton (metre)', price: 87.35, unit: 'mtr', hsn: '5208', taxRateId: rate(12) })
    const dal = await s.call<P>('products.save', { name: 'Dal', price: 143.3, unit: 'kg', hsn: '0713', taxRateId: rate(5) })
    const dalG = await s.call<P>('products.save', { name: 'Dal (loose g)', price: 0.17, unit: 'g', hsn: '0713', taxRateId: rate(5) })
    const bag = await s.call<P>('products.save', { name: 'Bag', price: 41.99, taxRateId: rate(18) }) // no HSN
    const local = await s.call<P>('customers.save', { name: 'Kumar Traders', phone: '9800000202', gstin: gstin('33', 'AAFCK1234L') })
    const other = await s.call<P>('customers.save', { name: 'Bangalore Silks', phone: '9800000203', gstin: gstin('29', 'AAFCB1234L') })
    const walkKa = await s.call<P>('customers.save', { name: 'Ravi (Bengaluru)', phone: '9800000204', stateCode: '29' })
    const pay = async (items: unknown[], extra = {}) => {
      const o = await s.call<{ order: O }>('orders.save', draft(items, extra))
      return s.call<O>('orders.settle', o.order.id, [{ method: 'cash', amount: o.order.total }])
    }
    // Many walk-in bills with odd paise, mixed rates, and kg / g / metre quantities that don't end in a whole 10 g.
    for (let i = 0; i < 12; i++) await pay([line(saree, 1 + (i % 3)), line(cloth, 1.125 + i * 0.333), line(dal, 0.125 * (i + 1)), line(bag, 1 + (i % 2))])
    await pay([line(dalG, 250), line(dal, 1.5)])
    await pay([line(cloth, 2.5)], { customerId: walkKa.id }) // walk-in, other state, small → B2CS inter-state
    const b2cl = await pay([line(gold, 2), line(bag)], { customerId: walkKa.id }) // other state above ₹1 lakh → B2CL
    const b2b = await pay([line(saree, 2), line(cloth, 3.3)], { customerId: other.id }) // B2B IGST
    await pay([line(saree), line(dal, 2)], { customerId: local.id }) // B2B same state
    const back = await pay([line(saree, 2), line(dal, 0.75), line(bag, 3)])
    await s.call('returns.create', { orderId: back.id, lines: [{ orderItemId: back.items[0].id, qty: 1, restock: true }, { orderItemId: back.items[2].id, qty: 2, restock: false }], reason: 'other', settle: 'refund', refundMethod: 'cash' })
    await s.call('returns.create', { orderId: b2b.id, lines: [{ orderItemId: b2b.items[1].id, qty: 1.1, restock: true }], reason: 'other', settle: 'refund', refundMethod: 'cash' })
    void b2cl
    const sup = await s.call<P>('suppliers.save', { name: 'No-GST Weavers' })
    await s.call('purchases.create', { supplierId: sup.id, supplierBillNo: 'W-1', date: new Date().toISOString().slice(0, 10), lines: [{ productId: cloth.id, qty: 10, cost: 50, taxRate: 12 }], paid: 0, method: 'cash' })
    const gone = await pay([line(bag)])
    await s.call('orders.cancel', gone.id, 'mistake')

    type G = { b2b: unknown[]; b2cl: unknown[]; b2cs: unknown[]; cdn: unknown[]; hsn: { hsn: string; qty: number }[]; docs: { count: number }; warnings: string[] }
    const { fast, full } = await both(() => s.call<G>('reports.gst', month))
    assert.deepEqual(fast, full)
    // Something was really counted: every table has rows.
    assert.ok(full.b2b.length === 3 && full.b2cl.length === 2 && full.b2cs.length >= 4 && full.cdn.length === 2 && full.docs.count === 18, JSON.stringify({ b2b: full.b2b.length, b2cl: full.b2cl.length, b2cs: full.b2cs.length, docs: full.docs }))
    assert.ok(full.warnings.some((w) => /no HSN/.test(w)) && full.warnings.some((w) => /without a GSTIN/.test(w)))
  } finally { s.close() }
})

test('reports.byBranch / summary: database way = full read — low stock edge cases, photos, tied revenues, profit right', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false }, modules: { inventory: true } })
    const annex = await s.call<P>('branches.save', { name: 'Annex' })
    const photo = await s.call<P>('products.save', { name: 'Photo cake', price: 100, costPrice: 40, imageUrl: 'https://example.com/cake.jpg', emoji: '🎂' })
    const twinA = await s.call<P>('products.save', { name: 'Twin A', price: 50, costPrice: 20.3 })
    const twinB = await s.call<P>('products.save', { name: 'Twin B', price: 50, costPrice: 21.7 })
    await s.call('products.save', { name: 'At level', price: 10, trackStock: true, stock: 5, lowStockAt: 5 })      // exactly at the level → low
    await s.call('products.save', { name: 'Above level', price: 10, trackStock: true, stock: 6, lowStockAt: 5 })   // not low (Main); no Annex row → 0 → low there
    await s.call('products.save', { name: 'Inactive low', price: 10, trackStock: true, stock: 0, lowStockAt: 5, active: false }) // never listed
    await s.call('products.save', { name: 'No level', price: 10, trackStock: true, stock: 0 })                     // 0 ≤ 0 → low
    await s.call('products.save', { name: 'Untracked', price: 10, trackStock: false })                              // never listed
    const loose = await s.call<P>('products.save', { name: 'Loose rice', price: 62.5, costPrice: 51.25, unit: 'kg', trackStock: true, stock: 100, lowStockAt: 2 })
    const sell = async (items: unknown[]) => { const o = await s.call<{ order: O }>('orders.save', draft(items)); return s.call<O>('orders.settle', o.order.id, [{ method: 'cash', amount: o.order.total }]) }
    await sell([line(photo, 2), line(twinA, 3), line(twinB, 3), line(loose, 1.25)]) // twins tie on revenue
    await sell([line(twinB, 1), line(twinA, 1), line(loose, 0.75)])
    s.setBranch(annex.id)
    await sell([line(twinA, 2), line(photo, 1)])
    s.setBranch(null)
    const today0 = new Date(); today0.setHours(0, 0, 0, 0)
    const range = [today0.toISOString(), new Date(Date.now() + 1000).toISOString()]
    for (const branch of ['all', null, annex.id]) {
      s.setBranch(branch)
      const a = await both(() => s.call<unknown[]>('reports.byBranch', ...range))
      assert.deepEqual(a.fast, a.full, `byBranch · ${branch ?? 'Main'}`)
      const b = await both(() => s.call<Record<string, unknown>>('reports.summary', ...range))
      assert.deepEqual(b.fast, b.full, `summary · ${branch ?? 'Main'}`)
    }
    s.setBranch('all')
    const rows = await s.call<{ branch: { id: string }; lowStock: { name: string }[]; summary: { topProducts: { name: string; imageUrl: string | null; emoji: string }[]; cogs: number } }[]>('reports.byBranch', ...range)
    const main = rows.find((r) => r.branch.id !== annex.id)!, ann = rows.find((r) => r.branch.id === annex.id)!
    assert.deepEqual(main.lowStock.map((x) => x.name), ['At level', 'No level'])
    assert.ok(ann.lowStock.some((x) => x.name === 'Above level') && !ann.lowStock.some((x) => /Inactive|Untracked/.test(x.name)), 'no stock row in a branch counts as 0')
    const cake = main.summary.topProducts.find((p) => p.name === 'Photo cake')!
    assert.ok(cake.imageUrl && cake.emoji === '🎂', 'photo and emoji')
    assert.ok(main.summary.cogs > 0)
    // A cashier (no "view profit"): the same, with cost of goods hidden — both ways.
    s.setBranch(null)
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    const mgr = roles.find((r) => r.name === 'Manager') ?? roles[1]
    await s.call('users.save', { name: 'Mani', phone: '9800000777', roleId: mgr.id, password: 'mani1234' })
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000777', 'mani1234')).token)
    const c = await both(() => s.call<Record<string, unknown>>('reports.summary', ...range))
    assert.deepEqual(c.fast, c.full)
  } finally { s.close() }
})

test('reports.gst: database split = line-by-line report on many bills with varied amounts (every rounding pattern)', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  const gstin = (state: string, pan: string) => { const first = `${state}${pan}1Z`; return first + gstinCheckChar(first) }
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).slice(0, 7)
  try {
    const biz = await s.call<{ billing: { taxRates: { id: string; rate: number }[] } }>('business.update', { gstin: gstin('33', 'AABCS1234D'), billing: { taxEnabled: true, taxMode: 'inclusive', roundOff: false } })
    const rates = biz.billing.taxRates.map((t) => t.id)
    const annex = await s.call<P>('branches.save', { name: 'Annex' })
    const items: P[] = []
    for (let i = 0; i < 24; i++) items.push(await s.call<P>('products.save', { name: `Item ${i}`, price: Math.round((7 + i * 13.37) * 100) / 100, hsn: i % 5 ? ['1006', '2106', '0402'][i % 3] : undefined, unit: i % 4 === 0 ? 'kg' : 'pc', taxRateId: rates[i % rates.length] }))
    const walkKa = await s.call<P>('customers.save', { name: 'Ravi KA', phone: '9800000501', stateCode: '29' })
    const b2b = await s.call<P>('customers.save', { name: 'Kumar Traders', phone: '9800000502', gstin: gstin('33', 'AAFCK1234L') })
    const pay = async (lines: unknown[], extra = {}) => { const o = await s.call<{ order: O }>('orders.save', draft(lines, extra)); return s.call<O>('orders.settle', o.order.id, [{ method: 'cash', amount: o.order.total }]) }
    for (let i = 0; i < 90; i++) {
      if (i === 60) s.setBranch(annex.id)
      const ls = Array.from({ length: 1 + (i % 4) }, (_, k) => { const at = (i * 5 + k * 7) % items.length; const p = items[at]; return line(p, (i + k) % 4 === 0 && at % 4 === 0 ? [0.125, 0.333, 1.75, 2.5][k % 4] : 1 + ((i + k) % 3)) })
      await pay(ls, { ...(i % 9 === 0 ? { customerId: walkKa.id } : i % 13 === 0 ? { customerId: b2b.id } : {}), discount: i % 7 === 0 ? 3.33 : 0 })
    }
    s.setBranch(null)
    const { fast, full } = await both(() => s.call<{ b2cs: unknown[]; hsn: unknown[]; summary: unknown }>('reports.gst', month))
    assert.deepEqual(fast, full)
    assert.ok(full.b2cs.length >= 4 && full.hsn.length >= 6, JSON.stringify({ b2cs: full.b2cs.length, hsn: full.hsn.length }))
  } finally { s.close() }
})

test('reports.summary: credit / part payments / dues / voided / late payments equal the full read; top N = first N; one request for the totals', { skip: !PER_SHOP }, async () => {
  const { outgoing } = await import('../src/core/meter')
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const tea = await s.call<P>('products.save', { name: 'Tea', price: 15 })
    const cake = await s.call<P>('products.save', { name: 'Cake', price: 120 })
    const items: P[] = []
    for (let i = 0; i < 12; i++) items.push(await s.call<P>('products.save', { name: `Snack ${i}`, price: 10 + i * 3 }))
    const cust = await s.call<P>('customers.save', { name: 'Anu', phone: '9811100001' })
    const cust2 = await s.call<P>('customers.save', { name: 'Bala', phone: '9811100002' })
    const annex = await s.call<P>('branches.save', { name: 'Annex' })
    const bill = async (lines: unknown[], pays: { method: string; amount: number }[], extra = {}) => { const o = await s.call<{ order: O }>('orders.save', draft(lines, extra)); return s.call<O>('orders.settle', o.order.id, pays.map((p) => (p.amount < 0 ? { ...p, amount: o.order.total } : p))) }
    for (let i = 0; i < 12; i++) await bill([line(items[i], 1 + (i % 3)), line(tea, i % 2 + 1)], [{ method: i % 2 ? 'upi' : 'cash', amount: -1 }])
    await bill([line(cake, 2)], [{ method: 'cash', amount: 100 }], { customerId: cust.id })                    // part paid, rest on credit
    await bill([line(cake, 1)], [], { customerId: cust2.id })                                                     // all on credit
    await bill([line(cake, 3)], [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 100 }], { customerId: cust.id }) // two payments, still owes
    await s.call('customers.collectDue', cust.id, 50, 'upi')                                                      // due collected later (not a sale payment)
    const gone = await bill([line(cake, 1)], [{ method: 'card', amount: -1 }])
    await s.call('orders.cancel', gone.id, 'mistake')                                                             // its payment is voided
    s.setBranch(annex.id)
    await bill([line(tea, 4)], [{ method: 'cash', amount: 20 }], { customerId: cust2.id })
    s.setBranch(null)
    const today0 = new Date(); today0.setHours(0, 0, 0, 0)
    // The window ends before the last bills: their payments land just after it (within the late-payment allowance).
    const mid = new Date(Date.now() - 400).toISOString()
    for (const [from, to] of [[today0.toISOString(), new Date(Date.now() + 1000).toISOString()], [today0.toISOString(), mid]]) {
      for (const branch of ['all', null, annex.id]) {
        s.setBranch(branch)
        const { fast, full } = await both(() => s.call<{ salesByMethod: Record<string, number> }>('reports.summary', from, to))
        assert.deepEqual(fast, full, `summary ${to === mid ? '(window ends mid-way)' : ''} · ${branch ?? 'Main'}`)
      }
    }
    s.setBranch('all')
    const range = [today0.toISOString(), new Date(Date.now() + 1000).toISOString()]
    const all = await s.call<{ topProducts: { productId: string }[]; salesByMethod: Record<string, number> }>('reports.summary', ...range)
    assert.ok(all.salesByMethod.credit > 0, 'credit counted')
    const top5 = await s.call<{ topProducts: { productId: string }[] }>('reports.summary', ...range, { top: 5 })
    assert.deepEqual(top5, { ...all, topProducts: all.topProducts.slice(0, 5) }, 'top 5 = the first 5 of the full list, everything else the same')
    assert.deepEqual(await s.call('reports.summary', ...range, { top: 'x' }), all, 'a bad value = the full list')
    // The twelve totals come in one request (plus the light item lookup and categories).
    const before = outgoing.n
    await s.call('reports.summary', ...range)
    // (hrana: the in-process test server counts its own steps too — checked on sqlite.)
    if (TEST_DB === 'sqlite') assert.ok(outgoing.n - before <= 8, `requests for one summary: ${outgoing.n - before}`)
  } finally { s.close() }
})
