import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchCached } from '../../src/data/remote/livePatch'
import { shownStatus } from '../../src/core/waReceipts'

const now = new Date().toISOString()
const o = (id: string, x: Record<string, unknown> = {}) => ({ id, branchId: 'b1', status: 'open', source: 'qr', qrStatus: 'pending', createdAt: now, updatedAt: now, ...x }) as never

test('live list updates: add / replace / remove one record; out-of-order ignored; unsure → re-read', () => {
  // A new pending QR order appears; an accepted one leaves the pending list.
  const pending = [o('o1')]
  assert.deepEqual((patchCached('qr.pending', 'b1', '[]', pending, { orders: [o('o2')] }) as { id: string }[]).map((x) => x.id), ['o1', 'o2'])
  assert.deepEqual(patchCached('qr.pending', 'b1', '[]', pending, { orders: [o('o1', { qrStatus: 'accepted' })] }), [])
  // Another branch's order isn't added to a one-branch list; "all branches" takes it.
  assert.deepEqual(patchCached('orders.running', 'b1', '[]', [], { orders: [o('o3', { branchId: 'b2' })] }), [])
  assert.equal((patchCached('orders.running', 'all', '[]', [], { orders: [o('o3', { branchId: 'b2' })] }) as unknown[]).length, 1)
  // A paid order leaves the running list.
  assert.deepEqual(patchCached('orders.running', 'b1', '[]', [o('o4')], { orders: [o('o4', { status: 'completed' })] }), [])
  // An older copy arriving late doesn't replace the newer one.
  const newer = o('o5', { updatedAt: '2099-01-01T00:00:00.000Z', qrStatus: 'pending' })
  const res = patchCached('qr.pending', 'b1', '[]', [newer], { orders: [o('o5', { updatedAt: '2000-01-01T00:00:00.000Z', qrStatus: 'accepted' })] }) as { id: string }[]
  assert.deepEqual(res.map((x) => x.id), ['o5'])
  // Unknown branch, other arguments, other lists, or no records: re-read as before.
  assert.equal(patchCached('qr.pending', '', '[]', pending, { orders: [o('o2')] }), undefined)
  assert.equal(patchCached('orders.list', 'b1', '[]', pending, { orders: [o('o2')] }), undefined)
  assert.equal(patchCached('kitchen.list', 'b1', '[]', [], { orders: [o('o2')] }), undefined)
  assert.equal(patchCached('qr.pending', 'b1', '[{"x":1}]', pending, { orders: [o('o2')] }), undefined)
})

test('WhatsApp ticks move on the screen (simulated receipts) without asking the server', () => {
  const t = Date.now()
  const at = (ms: number) => new Date(t - ms).toISOString()
  assert.equal(shownStatus({ status: 'sent', simulated: true, createdAt: at(1000) }, t), 'sent')
  assert.equal(shownStatus({ status: 'sent', simulated: true, createdAt: at(5000) }, t), 'delivered')
  assert.equal(shownStatus({ status: 'delivered', simulated: true, createdAt: at(31000) }, t), 'read')
  // Real receipts (not simulated) and failures are shown as they are.
  assert.equal(shownStatus({ status: 'sent', createdAt: at(60000) }, t), 'sent')
  assert.equal(shownStatus({ status: 'failed', simulated: true, createdAt: at(60000) }, t), 'failed')
})

test('change feed timing: urgent screens every 30 s, the rest every 60 s', async () => {
  const { feedInterval } = await import('../../src/data/remote/feedTiming')
  for (const p of ['/kitchen', '/qr-orders', '/tables', '/billing', '/billing?cn=CN-1', '/m/order', '/customer-orders']) assert.equal(feedInterval(p), 30_000, p)
  for (const p of ['/dashboard', '/reports', '/products', '/settings/profile', '/', '/orders', '/kitchenware']) assert.equal(feedInterval(p), 60_000, p)
})
