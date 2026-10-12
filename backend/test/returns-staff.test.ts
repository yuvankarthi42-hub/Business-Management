import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/modules/returns'
import '../src/modules/staff'
import { withShop } from './fixtures'

type P = { id: string; stock: number }
type O = { id: string; total: number; balance: number; items: { id: string; qty: number }[] }
type R = { id: string; number: string; total: number; dueAdjusted: number; refunded: number; refundMethod: string | null; creditIssued: number; creditRemaining: number; lines: { qty: number; restock: boolean; amount: number }[] }

const line = (p: P, qty: number) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const shopDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

test('returns: refund + restock, due first, credit note used as payment, over-return refused', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const milk = await s.call<P>('products.save', { name: 'Milk 500 ml', price: 27, trackStock: true, stock: 10, unit: 'pc' })
    const stockOf = async () => (await s.call<P[]>('products.list')).find((p) => p.id === milk.id)!.stock

    // Refund by UPI, back on the shelf.
    const o1 = await s.call<O>('orders.checkout', draft([line(milk, 4)]), [{ method: 'cash', amount: 108 }])
    assert.equal(await stockOf(), 6)
    const r1 = await s.call<R>('returns.create', { orderId: o1.id, lines: [{ orderItemId: o1.items[0].id, qty: 2, restock: true }], reason: 'quality', settle: 'refund', refundMethod: 'upi' })
    assert.equal(r1.number, 'CN-1001')
    assert.equal(r1.total, 54)
    assert.equal(r1.refunded, 54)
    assert.equal(r1.refundMethod, 'upi')
    assert.equal(r1.creditIssued, 0)
    assert.equal(await stockOf(), 8)
    const refunds = await s.db.select('payments', { where: { kind: 3 } })
    assert.equal(refunds.length, 1)
    assert.equal(refunds[0].amount_minor, 5400)
    assert.equal(refunds[0].method, 2)
    assert.equal(refunds[0].return_id, r1.id)
    const f = await s.call<{ returns: R[]; items: { returned: number; returnable: number }[]; ratio: number }>('returns.forOrder', o1.id)
    assert.equal(f.returns.length, 1)
    assert.deepEqual([f.items[0].returned, f.items[0].returnable], [2, 2])
    assert.equal(f.ratio, 1)
    await assert.rejects(s.call('returns.create', { orderId: o1.id, lines: [{ orderItemId: o1.items[0].id, qty: 3, restock: true }], reason: 'other', settle: 'refund' }), /Only 2 of/)
    await assert.rejects(s.call('returns.create', { orderId: o1.id, lines: [], reason: 'other', settle: 'refund' }), /at least one item/)
    // Damaged: not restocked.
    await s.call<R>('returns.create', { orderId: o1.id, lines: [{ orderItemId: o1.items[0].id, qty: 1, restock: false }], reason: 'damaged', settle: 'refund' })
    assert.equal(await stockOf(), 8)
    const o1after = (await s.db.get('orders', o1.id))!
    assert.equal(o1after.returned_minor, 8100)

    // A bill with a due: the due is reduced first, the rest becomes a credit note.
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Raja', phone: '9800011122' })
    const o2 = await s.call<O>('orders.checkout', draft([line(milk, 2)], { customerId: cust.id }), [{ method: 'cash', amount: 20 }])
    assert.equal(o2.balance, 34)
    const r2 = await s.call<R>('returns.create', { orderId: o2.id, lines: [{ orderItemId: o2.items[0].id, qty: 1, restock: true }], reason: 'not_needed', settle: 'credit_note' })
    assert.deepEqual([r2.dueAdjusted, r2.creditIssued, r2.refunded], [27, 0, 0])
    const r3 = await s.call<R>('returns.create', { orderId: o2.id, lines: [{ orderItemId: o2.items[0].id, qty: 1, restock: true }], reason: 'not_needed', settle: 'credit_note' })
    assert.deepEqual([r3.dueAdjusted, r3.creditIssued, r3.creditRemaining], [7, 20, 20])
    assert.equal((await s.call<{ order: O }>('orders.get', o2.id)).order.balance, 0)

    // Look up the credit note (any case; quotes stripped) and pay with it.
    const cn = await s.call<R>('returns.creditNote', r3.number.toLowerCase())
    assert.equal(cn.id, r3.id)
    await assert.rejects(s.call('returns.creditNote', "CN-1' OR 1=1"), /not found/)
    await s.call<O>('orders.checkout', draft([line(milk, 1)]), [{ method: 'credit_note', amount: 15, reference: r3.number }, { method: 'cash', amount: 12 }])
    assert.equal((await s.call<R>('returns.creditNote', r3.number)).creditRemaining, 5)
    await assert.rejects(s.call('orders.checkout', draft([line(milk, 1)]), [{ method: 'credit_note', amount: 10, reference: r3.number }, { method: 'cash', amount: 17 }]), /only ₹5.00 left/)

    const list = await s.call<R[]>('returns.list')
    assert.equal(list.length, 4)
    assert.equal(list[0].id, r3.id) // newest first
  } finally { s.close() }
})

type Row = { userId: string; name: string; role: string; present: number; half: number; absent: number; unmarked: number; daysInMonth: number; basePay: number; bills: number; sales: number; commission: number; advances: number; net: number; paid: { id: string; net: number; advances: number } | null }

test('staff: pay, attendance, advances, month numbers, salary', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    const roles = await s.call<{ id: string; name: string }[]>('roles.list')
    const ravi = await s.call<{ id: string }>('users.save', { name: 'Ravi', phone: '9800000001', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'ravi1234' })
    const staff = await s.call<{ id: string; role: string; pay: unknown }[]>('staff.list')
    const me = staff.find((x) => x.id !== ravi.id)!
    assert.equal(staff.length, 2)
    assert.equal(staff.find((x) => x.id === ravi.id)!.role, 'Cashier')
    assert.equal(staff.find((x) => x.id === ravi.id)!.pay, null)

    await assert.rejects(s.call('staff.setPay', ravi.id, { type: 'monthly', amount: 30000, commissionPct: 60 }), /between 0 and 50/)
    await s.call('staff.setPay', ravi.id, { type: 'monthly', amount: 30000, commissionPct: 1 })
    assert.deepEqual((await s.call<{ id: string; pay: unknown }[]>('staff.list')).find((x) => x.id === ravi.id)!.pay, { type: 'monthly', amount: 30000, commissionPct: 1 })

    // Attendance.
    const today = shopDay(), month = today.slice(0, 7), dayNo = Number(today.slice(8))
    const a1 = await s.call<{ id: string; status: string; checkIn: string }>('staff.mark', ravi.id, today, { status: 'present', checkIn: '09:30' })
    const a2 = await s.call<{ id: string; status: string; checkIn: string; checkOut: string }>('staff.mark', ravi.id, today, { checkOut: '18:00' })
    assert.equal(a2.id, a1.id)
    assert.deepEqual([a2.status, a2.checkIn, a2.checkOut], ['present', '09:30', '18:00'])
    await assert.rejects(s.call('staff.mark', ravi.id, today, { checkOut: '08:00' }), /before check-in/)
    await assert.rejects(s.call('staff.mark', ravi.id, today, { checkIn: '9.30' }), /like 09:30/)
    await assert.rejects(s.call('staff.mark', ravi.id, '2999-01-01', { status: 'present' }), /future date/)
    await assert.rejects(s.call('staff.markAll', '2999-01-01', [ravi.id]), /future date/)
    await assert.rejects(s.call('staff.mark', me.id, '2026-01-02', {}), /Choose present/)
    let absent = 0
    if (dayNo > 1) { await s.call('staff.mark', ravi.id, `${month}-01`, { status: 'absent' }); absent = 1 }
    assert.equal(await s.call('staff.markAll', today, [ravi.id, me.id, '999999']), 1) // only the owner was unmarked
    assert.equal((await s.call<unknown[]>('staff.day', today)).length, 2)

    // Ravi bills ₹2000; one shirt comes back → his net sales are ₹1000.
    const shirt = await s.call<P>('products.save', { name: 'Shirt', price: 1000 })
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000001', 'ravi1234')).token)
    const bill = await s.call<O>('orders.checkout', draft([line(shirt, 2)]), [{ method: 'cash', amount: 2000 }])
    s.setToken(s.ownerToken)
    await s.call('returns.create', { orderId: bill.id, lines: [{ orderItemId: bill.items[0].id, qty: 1, restock: false }], reason: 'other', settle: 'refund' })

    // Advance: an expense under Salary.
    await assert.rejects(s.call('staff.giveAdvance', ravi.id, { amount: 0, method: 'cash' }), /advance amount/)
    await s.call('staff.giveAdvance', ravi.id, { amount: 500, method: 'cash', note: 'festival' })
    const cats = await s.db.select('expense_categories', { where: { system_key: 2 } })
    assert.equal(cats.length, 1)
    let exps = await s.db.select('expenses')
    assert.equal(exps.length, 1)
    assert.equal(exps[0].amount_minor, 50000)
    assert.equal(exps[0].category_id, cats[0].ROWID)
    assert.equal((await s.db.select('staff_advances'))[0].expense_id, exps[0].ROWID)

    const rows = await s.call<Row[]>('staff.month', month)
    const r = rows.find((x) => x.userId === ravi.id)!
    const base = Math.round(30000 - (30000 / r.daysInMonth) * absent)
    assert.deepEqual(
      [r.role, r.present, r.absent, r.unmarked, r.basePay, r.bills, r.sales, r.commission, r.advances, r.net, r.paid],
      ['Cashier', 1, absent, dayNo - 1 - absent, base, 1, 1000, 10, 500, base + 10 - 500, null],
    )
    assert.equal(rows.find((x) => x.userId === me.id)!.present, 1)
    await assert.rejects(s.call('staff.month', '2026-1'), /Choose a month/)

    // Pay the salary: advance taken back, one more expense, no double pay.
    await assert.rejects(s.call('staff.paySalary', me.id, month, { method: 'cash' }), /Set the salary first/)
    const sp = await s.call<{ net: number; advances: number; bonus: number; payType: string; present: number; commissionSales: number }>('staff.paySalary', ravi.id, month, { bonus: 100, method: 'bank' })
    assert.deepEqual([sp.net, sp.advances, sp.bonus, sp.payType, sp.present, sp.commissionSales], [base + 10 + 100 - 500, 500, 100, 'monthly', 1, 1000])
    await assert.rejects(s.call('staff.paySalary', ravi.id, month, { method: 'bank' }), /already paid/)
    const after = (await s.call<Row[]>('staff.month', month)).find((x) => x.userId === ravi.id)!
    assert.equal(after.advances, 0)
    assert.equal(after.paid!.net, sp.net)
    assert.ok((await s.db.select('staff_advances'))[0].salary_payment_id)
    exps = await s.db.select('expenses')
    assert.equal(exps.length, 2)
    assert.equal((await s.db.select('salary_payments'))[0].expense_id, exps[1].ROWID)
  } finally { s.close() }
})
