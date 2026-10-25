import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gstinCheckChar } from '../../src/core/gst'
import { withShop } from './fixtures'

const gstin = (state: string, pan = 'AAATW1234Q') => { const first = `${state}${pan}1Z`; return first + gstinCheckChar(first) }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

type P = { id: string; stock: number; costPrice: number; hsn?: string | null }
type Sup = { id: string; name: string; stateCode: string | null; balance: number; purchases: number }
type Pur = { id: string; number: string; total: number; tax: number; taxable: number; roundOff: number; paid: number; balance: number; igst: boolean; status: string; lines: { qty: number; taxable: number; tax: number; hsn: string }[] }
type Ledger = { balance: number; rows: { kind: string; debit: number; credit: number; balance: number }[]; payments: { id: string; amount: number; voided: boolean }[] }

test('purchases: suppliers, purchase bill → stock + cost + input GST, part paid, ledger, payments', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { gstin: gstin('33', 'AABCS1234D'), billing: { taxEnabled: true } })
    await assert.rejects(s.call('suppliers.save', { name: '  ' }), /name/)
    await assert.rejects(s.call('suppliers.save', { name: 'Bad GST', gstin: '33AAATW1234Q1ZZ' }), /GSTIN/)
    const local = await s.call<Sup>('suppliers.save', { name: 'Arani Weavers', phone: '9800000301', gstin: gstin('33'), openingBalance: 5000 })
    assert.equal(local.stateCode, '33')
    assert.equal(local.balance, 5000)
    await assert.rejects(s.call('suppliers.save', { name: 'arani  weavers' }), /already exists/)
    const other = await s.call<Sup>('suppliers.save', { name: 'Surat Fabrics', gstin: gstin('24', 'AAGCS1234K') })

    const saree = await s.call<P>('products.save', { name: 'Arani Silk Saree', price: 6200, trackStock: true, stock: 2 })
    const milk = await s.call<P>('products.save', { name: 'Milk', price: 27, trackStock: true, trackExpiry: true })
    const base = { supplierId: local.id, supplierBillNo: 'AW/481', date: today(), method: 'bank' as const }

    await assert.rejects(s.call('purchases.create', { ...base, lines: [], paid: 0 }), /at least one item/)
    await assert.rejects(s.call('purchases.create', { ...base, lines: [{ productId: saree.id, qty: 0, cost: 4300, taxRate: 5 }], paid: 0 }), /quantity/)
    await assert.rejects(s.call('purchases.create', { ...base, date: '2999-01-01', lines: [{ productId: saree.id, qty: 1, cost: 4300, taxRate: 5 }], paid: 0 }), /future/)
    await assert.rejects(s.call('purchases.create', { ...base, lines: [{ productId: milk.id, qty: 10, cost: 22, taxRate: 0 }], paid: 0 }), /expiry/)
    await assert.rejects(s.call('purchases.create', { ...base, lines: [{ productId: saree.id, qty: 1, cost: 4300, taxRate: 5 }], paid: 99999 }), /more than the bill total/)

    const p1 = await s.call<Pur>('purchases.create', { ...base, lines: [{ productId: saree.id, qty: 10, cost: 4300.5, taxRate: 5, hsn: '5007' }, { productId: milk.id, qty: 20, cost: 22, taxRate: 0, batchNo: 'B1', expiry: '2099-01-31' }], paid: 30000 })
    assert.equal(p1.number, 'PUR-1')
    assert.equal(p1.taxable, 43005 + 440)
    assert.equal(p1.tax, 2150.25)
    assert.equal(p1.total, Math.round(43445 + 2150.25))
    assert.equal(p1.roundOff, -0.25)
    assert.deepEqual([p1.paid, p1.balance, p1.igst], [30000, p1.total - 30000, false])
    const list = await s.call<P[]>('products.list')
    const sar = list.find((p) => p.id === saree.id)!
    assert.deepEqual([sar.stock, sar.costPrice, sar.hsn], [12, 4300.5, '5007'], 'stock in, latest cost, HSN filled')
    assert.equal(list.find((p) => p.id === milk.id)!.stock, 20)
    const batch = (await s.db.select('stock_batches', { where: { product_id: milk.id } }))[0]
    assert.equal(batch.expiry_date, '2099-01-31')
    assert.ok(batch.purchase_item_id, 'batch linked to its purchase line')
    const moves = await s.db.select('stock_movements', { where: { product_id: saree.id, ref_type: 2 } })
    assert.equal(moves.length, 1)

    // Ledger: opening 5000 + bill − paid; pay later; void a payment.
    let led = await s.call<Ledger>('suppliers.ledger', local.id)
    assert.equal(led.balance, 5000 + p1.total - 30000)
    assert.deepEqual(led.rows.map((r) => r.kind), ['opening', 'purchase', 'payment'])
    const pay = await s.call<{ id: string }>('suppliers.pay', local.id, { amount: 10000, method: 'upi', reference: 'UTR123' })
    await assert.rejects(s.call('suppliers.pay', local.id, { amount: 0, method: 'cash' }), /amount/)
    led = await s.call<Ledger>('suppliers.ledger', local.id)
    assert.equal(led.balance, 5000 + p1.total - 40000)
    await s.call('suppliers.voidPayment', pay.id, 'Entered twice')
    led = await s.call<Ledger>('suppliers.ledger', local.id)
    assert.equal(led.balance, 5000 + p1.total - 30000)
    const sups = await s.call<Sup[]>('suppliers.list')
    assert.equal(sups.find((x) => x.id === local.id)!.purchases, 1)

    // Other-state supplier: IGST input credit.
    const p2 = await s.call<Pur>('purchases.create', { supplierId: other.id, supplierBillNo: 'SF-1', date: today(), method: 'cash', lines: [{ productId: saree.id, qty: 1, cost: 1000, taxRate: 5 }], paid: 0 })
    assert.equal(p2.igst, true)

    // Void: stock goes back out; not possible once the stock is sold.
    const v = await s.call<Pur>('purchases.void', p2.id, 'Wrong supplier')
    assert.equal(v.status, 'void')
    assert.equal((await s.call<P[]>('products.list')).find((p) => p.id === saree.id)!.stock, 12)
    await assert.rejects(s.call('purchases.void', p2.id, 'again'), /already voided/)
    assert.equal((await s.call<Sup[]>('suppliers.list')).find((x) => x.id === other.id)!.balance, 0)
    await s.call('inventory.adjust', milk.id, 'wastage', 15, 'spoilt')
    await assert.rejects(s.call('purchases.void', p1.id, 'test'), /only 5 left/)

    const all = await s.call<Pur[]>('purchases.list')
    assert.equal(all.length, 2)
  } finally { s.close() }
})
