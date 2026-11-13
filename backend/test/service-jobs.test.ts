// Service jobs (repairs, laundry, tailoring): take in → stages → deliver (the bill), close with the advance back,
// and the rules every module keeps: switched off = refused, permissions, branch view, retries, two devices.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'

type P = { id: string; stock: number }
type Card = { id: string; number: string; stage: string; advance: number; version: number; customerName: string }
type Job = Card & { events: { from: string | null; to: string }[]; orderId: string | null; invoiceNumber: string | null; total: number | null; closeReason: string }
type O = { id: string; status: string; total: number; paid: number; balance: number; invoiceNumber: string | null }
type Pay = { id: string; amount: number; kind: string; method: string; orderId: string | null }
const line = (p: { id: string }, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 })
const range = () => [new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString()] as const

async function repairShop() {
  const s = await withShop()
  await s.call('business.update', { subType: 'Repair', billing: { taxEnabled: false } })
  return s
}

test('Service jobs: switched off, the shop can’t use them (refused or empty, nothing saved)', async () => {
  const s = await withShop()
  try {
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Ravi', phone: '9876543210' })
    await assert.rejects(s.call('serviceJobs.create', { customerId: cust.id, item: 'Mobile', problem: 'Screen broken' }), /turned off/)
    assert.deepEqual(await s.call('serviceJobs.board', 'received'), { rows: [], next: null, count: 0 })
    assert.deepEqual(await s.call('serviceJobs.search', 'J-1001'), [])
    await assert.rejects(s.call('serviceJobs.counts'), /turned off/)
  } finally { s.close() }
})

test('Service jobs: take in with an advance → stages → deliver with parts and labour (the bill includes the advance)', async () => {
  const s = await repairShop()
  try {
    await s.call('business.update', { modules: { serviceJobs: true, inventory: true } })
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Ravi Kumar', phone: '9876543210' })
    const part = await s.call<P>('products.save', { name: 'Display combo', price: 1800, trackStock: true, stock: 5 })
    const labour = await s.call<P>('products.save', { name: 'Screen replacement (labour)', price: 400, kind: 'service' })
    const job = await s.call<Job>('serviceJobs.create', { customerId: cust.id, item: 'Mobile', brandModel: 'Redmi Note 12', serial: '86 123456 789012 3', problem: 'Screen cracked', accessories: 'Charger', estimate: 2200, advance: { amount: 500, method: 'upi' } })
    assert.equal(job.number, 'J-1001'); assert.equal(job.stage, 'received'); assert.equal(job.advance, 500); assert.equal(job.customerName, 'Ravi Kumar')
    // The advance is the customer's payment on the drop-off day.
    const pays0 = await s.call<{ rows: Pay[] }>('payments.page', { from: range()[0], to: range()[1], method: 'all' })
    assert.ok(pays0.rows.some((p) => p.amount === 500 && p.orderId === null), 'advance recorded as a payment')
    assert.equal((await s.call<{ paymentsReceived: number }>('reports.summary', ...range())).paymentsReceived, 500)

    // Stages: one call each; the answer is the moved card. Counts and the board follow.
    let card = await s.call<Card>('serviceJobs.setStage', job.id, 'parts', 'Display ordered', job.version)
    assert.equal(card.stage, 'parts')
    card = await s.call<Card>('serviceJobs.setStage', job.id, 'repairing', '', card.version)
    const counts = await s.call<{ stages: string[]; counts: Record<string, number> }>('serviceJobs.counts')
    assert.deepEqual(counts.stages, ['received', 'parts', 'repairing', 'ready', 'delivered'])
    assert.equal(counts.counts.repairing, 1)
    assert.deepEqual((await s.call<{ rows: Card[] }>('serviceJobs.board', 'repairing')).rows.map((r) => r.number), ['J-1001'])
    await assert.rejects(s.call('serviceJobs.setStage', job.id, 'washing'), /Choose a stage/, 'not a repair stage')
    await assert.rejects(s.call('serviceJobs.setStage', job.id, 'ready', '', job.version), /another device/, 'an old version is refused')

    // Search: job number, phone digits, serial.
    for (const q of ['j-1001', '43210', '789012']) assert.deepEqual((await s.call<Card[]>('serviceJobs.search', q)).map((r) => r.number), ['J-1001'], q)

    // Deliver: parts + labour = 2,200; 500 already paid; 1,700 now.
    card = await s.call<Card>('serviceJobs.setStage', job.id, 'ready', '', card.version)
    await assert.rejects(s.call('serviceJobs.deliver', job.id, { items: [line(part), line(labour)] }, [{ method: 'cash', amount: 2200 }]), /exceeds/, 'paying the advance again is refused')
    const done = await s.call<{ job: Job; order: O }>('serviceJobs.deliver', job.id, { items: [line(part), line(labour)] }, [{ method: 'cash', amount: 1700 }])
    assert.equal(done.order.status, 'completed'); assert.equal(done.order.total, 2200); assert.equal(done.order.paid, 2200); assert.equal(done.order.balance, 0)
    assert.match(done.order.invoiceNumber ?? '', /\S/)
    assert.equal(done.job.stage, 'delivered'); assert.equal(done.job.orderId, done.order.id); assert.equal(done.job.total, 2200)
    assert.deepEqual(done.job.events.map((e) => e.to), ['received', 'parts', 'repairing', 'ready', 'delivered'])
    const [p] = await s.call<P[]>('products.byIds', [part.id])
    assert.equal(p.stock, 4, 'the part left stock with the bill')
    // The advance payment now belongs to the bill; nothing was counted twice.
    const pays = (await s.call<{ rows: Pay[] }>('payments.page', { from: range()[0], to: range()[1], method: 'all' })).rows
    assert.equal(pays.filter((x) => x.orderId === done.order.id).reduce((a, x) => a + x.amount, 0), 2200)
    assert.equal((await s.call<{ paymentsReceived: number }>('reports.summary', ...range())).paymentsReceived, 2200)
    // Closed: no more changes.
    await assert.rejects(s.call('serviceJobs.setStage', job.id, 'repairing'), /already delivered/)
    const again = await s.call<{ job: Job }>('serviceJobs.deliver', job.id, { items: [line(part)] }, [{ method: 'cash', amount: 1 }])
    assert.equal(again.job.orderId, done.order.id, 'delivering twice changes nothing')
  } finally { s.close() }
})

test('Service jobs: cancelled / returned with the advance given back; laundry stages; retries; permissions; branch view', async () => {
  const s = await repairShop()
  try {
    await s.call('business.update', { modules: { serviceJobs: true } })
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Meena', phone: '9811122233' })
    const a = await s.call<Job>('serviceJobs.create', { customerId: cust.id, item: 'Mobile', problem: 'Battery', advance: { amount: 300, method: 'cash' } })
    const closed = await s.call<Job>('serviceJobs.close', a.id, 'returned', 'Board dead, not repairable', { method: 'cash' })
    assert.equal(closed.stage, 'returned'); assert.equal(closed.closeReason, 'Board dead, not repairable'); assert.equal(closed.advance, 0)
    assert.equal((await s.call<{ paymentsReceived: number }>('reports.summary', ...range())).paymentsReceived, 0, 'advance in, advance back')
    await assert.rejects(s.call('serviceJobs.deliver', a.id, { items: [] }, []), /parts or labour/)

    // The same request sent twice: one job.
    s.setRequestId('req-job-1')
    const j1 = await s.call<Job>('serviceJobs.create', { customerId: cust.id, item: 'Laptop', problem: 'No display' })
    const j2 = await s.call<Job>('serviceJobs.create', { customerId: cust.id, item: 'Laptop', problem: 'No display' })
    s.setRequestId(null)
    assert.equal(j1.id, j2.id)
    // Missing details are refused.
    await assert.rejects(s.call('serviceJobs.create', { customerId: cust.id, item: '', problem: 'x' }), /Enter the item/)
    await assert.rejects(s.call('serviceJobs.create', { customerId: cust.id, item: 'Mobile', problem: '' }), /Describe the problem/)
    await assert.rejects(s.call('serviceJobs.create', { customerId: '999999', item: 'Mobile', problem: 'x' }), /Choose the customer/)

    // A laundry shop's own stages.
    await s.call('business.update', { subType: 'Laundry' })
    assert.deepEqual((await s.call<{ stages: string[] }>('serviceJobs.counts')).stages, ['received', 'washing', 'ironing', 'ready', 'delivered'])
    await s.call('serviceJobs.setStage', j1.id, 'washing')

    // Kitchen staff (no "Service jobs" permission) can't see or change jobs.
    const roles = await s.call<{ id: string; name: string; permissions: string[] }[]>('roles.list')
    await s.call('users.save', { name: 'Kumar', phone: '9800000991', roleId: roles.find((r) => r.name === 'Kitchen Staff')!.id, password: 'Kumar#2026x' })
    const owner = s.ownerToken
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000991', 'Kumar#2026x')).token)
    await assert.rejects(s.call('serviceJobs.board', 'received'), (e) => (e as { code?: string }).code === 'FORBIDDEN')
    await assert.rejects(s.call('serviceJobs.setStage', j1.id, 'ready'), (e) => (e as { code?: string }).code === 'FORBIDDEN')
    s.setToken(owner)
    // A new shop's cashier role has it.
    assert.ok(roles.find((r) => r.name === 'Cashier')!.permissions.includes('jobs.manage'))

    // Branches: the board shows the branch in view; staff of another branch can't open this branch's job.
    const annex = await s.call<{ id: string }>('branches.save', { name: 'Annex' })
    s.setBranch(annex.id)
    assert.deepEqual((await s.call<{ rows: Card[] }>('serviceJobs.board', 'washing')).rows, [])
    s.setBranch(null)
    assert.equal((await s.call<Job>('serviceJobs.get', j1.id)).stage, 'washing')
    await s.call('users.save', { name: 'Annex cashier', phone: '9800000992', roleId: roles.find((r) => r.name === 'Cashier')!.id, password: 'Annex#2026x', branchIds: [annex.id] })
    s.setToken((await s.call<{ token: string }>('auth.login', '9800000992', 'Annex#2026x')).token)
    await assert.rejects(s.call('serviceJobs.get', j1.id), /Job not found/)
    await assert.rejects(s.call('serviceJobs.setStage', j1.id, 'ready'), /Job not found/)
    assert.deepEqual(await s.call('serviceJobs.search', j1.number), [])
    s.setToken(owner)
  } finally { s.close() }
})
