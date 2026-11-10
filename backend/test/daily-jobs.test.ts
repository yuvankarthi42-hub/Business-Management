import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP, TEST_DB } from './helpers'
import { outgoing } from '../src/core/meter'
import { E } from '../src/domain/util'
import '../src/modules/admin/renewals'

type Run = { busy: boolean; sent: number; shops: number; idle: boolean }
type State = { lease: { id: string; until: number } | null; round: { startedOn: string; after: string | null; finishedOn: string | null }; batch: { shops: string[]; done: string[]; tries: Record<string, number> } | null; failed: { id: string }[] }
const KEY = 'test-cron-key-123-0123456789abcdef'
const line = (p: { id: string }, qty = 1) => ({ id: `tmp_${Math.random()}`, productId: p.id, name: 'x', variantId: null, variantName: null, addOns: [], qty, unit: 'pc', unitPrice: 1, taxRate: 0, notes: '', kotQty: 0 })
const draft = (items: unknown[], extra = {}) => ({ type: 'counter', tableId: null, customerId: null, items, discount: 0, notes: '', source: 'pos', ...extra })
const ENV = ['CRON_KEY', 'DAILY_SHOPS_PER_RUN', 'DAILY_REQUEST_BUDGET', 'DAILY_CPU_BUDGET_MS', 'DAILY_REMINDER_HOUR']

async function setup(extraShops: number) {
  const s = await withShop()
  process.env.CRON_KEY = KEY
  process.env.DAILY_CPU_BUDGET_MS = '600000' // the test database runs in this process: count requests only
  process.env.DAILY_REQUEST_BUDGET = '100000'
  s.setToken(s.adminToken)
  const ids = [s.businessId]
  for (let i = 1; i <= extraShops; i++) ids.push((await s.call<{ id: string }>('admin.createCustomer', { businessName: `Shop ${i}`, ownerName: 'O', username: `dj${i}shop`, password: 'shop1234', phone: `98700${String(i).padStart(5, '0')}`, validity: { months: 12 }, maxBranches: 1 })).id)
  s.setToken(null)
  const platform = await s.env.dbs.platform()
  const state = async (): Promise<State> => JSON.parse(String((await platform.first('platform_settings', { setting_key: 'dailyJobs' }))?.value_json ?? 'null'))
  const setState = async (st: unknown) => {
    const row = await platform.first('platform_settings', { setting_key: 'dailyJobs' })
    if (row) await platform.update('platform_settings', row.ROWID, { value_json: JSON.stringify(st) })
    else await platform.insert('platform_settings', { setting_key: 'dailyJobs', value_json: JSON.stringify(st) })
  }
  const shared = (s.env as unknown as { shared: { get(k: string): Promise<string | null>; del(k: string): Promise<void> } }).shared
  const copyShops = async () => Object.keys(JSON.parse((await shared.get('admin:usage')) ?? '{"shops":{}}').shops).sort()
  const run = () => s.call<Run>('system.runDailyBatch', KEY)
  return { s, ids, state, setState, shared, copyShops, run }
}
const done = () => { for (const k of ENV) delete process.env[k] }

test('daily jobs in batches: every shop once per day, the batch size is a setting, nothing left after the last batch', async () => {
  const { s, ids, state, copyShops, run } = await setup(24) // 25 shops
  try {
    await assert.rejects(s.call('system.runDailyBatch', 'wrong'), /Not allowed/)
    process.env.DAILY_SHOPS_PER_RUN = '10'
    const shops: number[] = []
    for (let i = 0; i < 10; i++) { const r = await run(); if (r.idle) break; shops.push(r.shops) }
    assert.deepEqual(shops, [10, 10, 5], `25 shops, 10 per run: ${shops}`)
    const st = await state()
    assert.ok(st.round.finishedOn && !st.batch && !st.lease)
    if (PER_SHOP) assert.deepEqual(await copyShops(), [...ids].sort(), 'every shop counted for Admin → Usage')
    const again = await run()
    assert.deepEqual([again.shops, again.idle], [0, true], 'a later run the same day does nothing')

    // A bad value falls back to 20 per run.
    process.env.DAILY_SHOPS_PER_RUN = 'abc'
    const st2 = await state(); st2.round.finishedOn = '2000-01-01'
    await (await s.env.dbs.platform()).update('platform_settings', (await (await s.env.dbs.platform()).first('platform_settings', { setting_key: 'dailyJobs' }))!.ROWID, { value_json: JSON.stringify(st2) })
    const next: number[] = []
    for (let i = 0; i < 10; i++) { const r = await run(); if (r.idle) break; next.push(r.shops) }
    assert.deepEqual(next, [20, 5], 'next day: a new round, 20 per run')
  } finally { done(); s.close() }
})

test('daily jobs: a stopped run is picked up (lease runs out), only unfinished shops are done again, a running lease is respected', async () => {
  const { s, ids, state, setState, shared, copyShops, run } = await setup(4) // 5 shops
  try {
    process.env.DAILY_SHOPS_PER_RUN = '5'
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const sorted = [...ids].sort((a, b) => Number(a) - Number(b))
    // A run claimed 3 shops, finished the first, then stopped (its lease is still running).
    const stopped = { lease: { id: 'old', until: Date.now() + 60_000 }, round: { startedOn: today, startedAt: new Date().toISOString(), after: null, finishedOn: null }, batch: { shops: sorted.slice(0, 3), done: [sorted[0]], tries: {} }, failed: [], remindersOn: today }
    await setState(stopped)
    await shared.del('admin:usage')
    assert.equal((await run()).busy, true, 'another run holds the lease: this one waits')
    assert.deepEqual((await state()).batch, stopped.batch, 'nothing changed')
    // The lease ran out: the next run does the 2 unfinished shops of that batch, then the rest.
    await setState({ ...stopped, lease: { id: 'old', until: Date.now() - 1 } })
    const r = await run()
    assert.equal(r.shops, 2)
    const st = await state()
    assert.deepEqual([st.batch, st.round.after, st.lease], [null, sorted[2], null])
    if (PER_SHOP) assert.deepEqual(await copyShops(), [sorted[1], sorted[2]].sort(), 'only the unfinished shops were done again')
    assert.equal((await run()).shops, 2, 'then the last 2 shops')
    assert.ok((await run()).idle)
  } finally { done(); s.close() }
})

test('daily jobs: a failing shop is retried on the next runs, then set aside so the others carry on', { skip: !PER_SHOP }, async () => {
  const { s, ids, state, run } = await setup(3) // 4 shops
  try {
    const bad = ids[2]
    const dbs = s.env.dbs as unknown as { shop(id: string): Promise<unknown>; openMany?: unknown }
    const real = dbs.shop.bind(dbs)
    dbs.shop = (id: string) => (id === bad ? Promise.reject(new Error('database down')) : real(id))
    const r1 = await run()
    assert.equal(r1.shops, 3, 'the other shops are done')
    let st = await state()
    assert.deepEqual([st.batch?.done.includes(bad), st.batch?.tries[bad], st.round.finishedOn], [false, 1, null], 'the failed shop waits for the next run')
    await run()
    assert.equal((await state()).batch?.tries[bad], 2)
    await run()
    st = await state()
    assert.equal(st.batch, null, 'after 3 failed runs it is set aside')
    assert.deepEqual(st.failed.map((f) => f.id), [bad])
    dbs.shop = real
  } finally { done(); s.close() }
})

// (hrana: the fake Turso server runs in this process and counts its own requests too, so the budget check runs on sqlite.)
test('daily jobs: stay inside the request budget; a shop with many expired points carries on over runs', { skip: !PER_SHOP || TEST_DB === 'hrana' }, async () => {
  const { s, state, run } = await setup(0)
  try {
    // 6 customers with points that expired.
    s.setToken(s.ownerToken)
    await s.call('business.update', { loyalty: { enabled: true }, billing: { taxEnabled: false } })
    const silk = await s.call<{ id: string }>('products.save', { name: 'Silk', price: 1000 })
    const custs: string[] = []
    for (let i = 0; i < 6; i++) {
      const cu = await s.call<{ id: string }>('customers.save', { name: `C${i}`, phone: `98000${String(i).padStart(5, '0')}` })
      custs.push(cu.id)
      await s.call('orders.checkout', draft([line(silk)], { customerId: cu.id }), [{ method: 'cash', amount: 1000 }])
    }
    const rows = await s.db.select('customer_points', { where: { business_id: s.businessId } })
    await s.db.updateMany('customer_points', rows.map((r) => ({ ROWID: r.ROWID, expires_on: '2000-01-01' })))
    s.setToken(null)
    process.env.DAILY_REQUEST_BUDGET = '30'
    const per: number[] = []
    for (let i = 0; i < 10; i++) {
      const before = outgoing.n
      const r = await run()
      per.push(outgoing.n - before)
      if (r.idle) break
    }
    assert.ok(per.every((n) => n <= 30), `every run within 30 requests: ${per.join(', ')}`)
    assert.ok(per.length > 2, 'the points took more than one run')
    s.setToken(s.ownerToken)
    const list = await s.call<{ id: string; pointsBalance: number }[]>('customers.list')
    assert.deepEqual(custs.map((id) => list.find((c) => c.id === id)!.pointsBalance), [0, 0, 0, 0, 0, 0], 'all expired, none missed')
    assert.ok((await state()).round.finishedOn)
  } finally { done(); s.close() }
})

test('daily jobs: renewal reminders a few per run, never twice — a message saved as "queued" before a stop is not sent again', async () => {
  const { s, ids, run } = await setup(2) // 3 shops, all ending in 3 days
  try {
    const platform = await s.env.dbs.platform()
    for (const id of ids) await platform.update('businesses', id, { subscription_end_at: new Date(Date.now() + 3 * 86_400_000).toISOString() })
    s.setToken(s.adminToken)
    await s.call('admin.waConnect', { businessNumber: '9000012345', wabaId: '1234567890', phoneNumberId: '1112223334', token: 'EAAG' + 'x'.repeat(40) + 'WXYZ' })
    await s.call('admin.waTest')
    await s.call('admin.waSaveTemplate', { language: 'en', body: 'Hi {owner}, your plan for {business} ends on {date} — {days} left. Call {support} to renew.' }, true)
    const tpl = await platform.first('whatsapp_templates', { uniq_key: `platform:${E.WaTemplateKind.renewal_reminder}` })
    await platform.update('whatsapp_templates', tpl!.ROWID, { submitted_at: new Date(Date.now() - 60_000).toISOString() })
    s.setToken(null)
    // A run stopped right after saving the first shop's reminder as "queued" (the WhatsApp request may have gone).
    await platform.insert('whatsapp_messages', { business_id: ids[0], sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, to_number: '+919876543210', body: 'x', status: E.WaMessageStatus.queued, status_at: new Date().toISOString() })
    process.env.DAILY_REMINDERS_PER_RUN = '1'
    process.env.DAILY_REMINDER_HOUR = '0'
    const sent: number[] = []
    for (let i = 0; i < 5; i++) sent.push((await run()).sent)
    assert.deepEqual(sent, [1, 1, 0, 0, 0], 'one per run, the two shops not yet reminded')
    const msgs = await platform.select('whatsapp_messages', { where: { kind: E.WaMessageKind.renewal_reminder } })
    const per = Object.fromEntries(ids.map((id) => [id, msgs.filter((m) => String(m.business_id) === id).length]))
    assert.deepEqual(per, Object.fromEntries(ids.map((id) => [id, 1])), 'every shop exactly one message — the queued one was not sent again')
    assert.ok(msgs.filter((m) => String(m.business_id) !== ids[0]).every((m) => Number(m.status) === E.WaMessageStatus.sent), 'saved as queued, then sent')
  } finally { done(); s.close() }
})
