import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/modules/support'
import '../src/modules/whatsapp'
import '../src/modules/admin/renewals'
import { E } from '../src/domain/util'
import { withShop } from './fixtures'

type Ticket = { id: string; number: string; status: string; subject: string; businessName: string; userName: string; unreadForAdmin: boolean; unreadForCustomer: boolean; assignedTo: string | null; priority: string; messages: { from: string; text: string; images: string[]; authorName: string }[]; imageCount?: number }
const png = (bytes: number) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes)]).toString('base64')}`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

test('support tickets: customer and admin, screenshots, expired accounts', async () => {
  const s = await withShop()
  try {
    // Screenshots: stored, and the size limit is checked again on the server.
    const shot = await s.call<{ url: string; bytes: number }>('support.storeScreenshot', { image: png(1000) })
    assert.match(shot.url, new RegExp(`/uploads/${s.businessId}/tickets/`))
    await assert.rejects(s.call('support.storeScreenshot', { image: png(210 * 1024) }), /too large/)
    await assert.rejects(s.call('support.storeScreenshot', { image: 'data:image/png;base64,AAAA' }), /not a supported image/)

    await assert.rejects(s.call('support.create', { subject: 'Hi', category: 'billing', message: 'Something broke' }), /short title/)
    const t1 = await s.call<Ticket>('support.create', { subject: 'Bill not printing', category: 'printer', message: 'The printer stays silent', images: [shot.url], page: '/pos' })
    assert.equal(t1.number, 'T-1001')
    assert.equal(t1.status, 'open')
    assert.equal(t1.businessName, 'Test Mart')
    assert.equal(t1.userName, 'Lakshmi')
    assert.deepEqual(t1.messages[0].images, [shot.url])
    await assert.rejects(s.call('support.create', { subject: 'Another one', category: 'other', message: 'Foreign image', images: ['/uploads/999/tickets/x.png'] }), /Upload the screenshot again/)

    // Expired subscription: the account is read-only, but tickets still work.
    await s.db.update('businesses', s.businessId, { subscription_end_at: ago(86_400_000) })
    await s.bump(s.businessId)
    await assert.rejects(s.call('customers.save', { name: 'Raja' }), /read-only/)
    const t2 = await s.call<Ticket>('support.create', { subject: 'Please renew', category: 'account', priority: 'high', message: 'Our plan has ended' })
    assert.equal(t2.number, 'T-1002')
    assert.equal((await s.call<Ticket[]>('support.mine')).length, 2)

    // Admin inbox.
    s.setToken(s.adminToken)
    const list = await s.call<Ticket[]>('admin.tickets')
    assert.equal(list.length, 2)
    assert.equal(list.find((t) => t.id === t1.id)!.imageCount, 1)
    const adminShot = await s.call<{ url: string }>('admin.storeScreenshot', { image: png(500) })
    assert.match(adminShot.url, /\/uploads\/platform\/tickets\//)
    await assert.rejects(s.call('admin.replyTicket', t1.id, 'Try this', [shot.url]), /Upload the screenshot again/)
    const one = await s.call<Ticket & { business: { state: string }; admins: { id: string; name: string }[] }>('admin.ticket', t1.id)
    assert.equal(one.unreadForAdmin, false)
    assert.equal(one.business.state, 'expired')
    assert.equal(one.admins[0].name, 'Admin')
    await s.call('admin.replyTicket', t1.id, 'Please restart the printer', [adminShot.url])
    await s.call('admin.updateTicket', t2.id, { priority: 'urgent', assignedTo: one.admins[0].id })
    await assert.rejects(s.call('admin.updateTicket', t2.id, { status: 'bogus' }), /Unknown status/)
    const after = await s.call<Ticket[]>('admin.tickets')
    const a1 = after.find((t) => t.id === t1.id)!
    assert.equal(a1.status, 'waiting')
    assert.equal(a1.assignedTo, one.admins[0].id)
    assert.equal(a1.unreadForCustomer, true)
    assert.equal(after.find((t) => t.id === t2.id)!.priority, 'urgent')

    // Customer reads the reply, answers (re-opens), then marks it solved.
    s.setToken(s.ownerToken)
    let mine = await s.call<Ticket[]>('support.mine')
    let m1 = mine.find((t) => t.id === t1.id)!
    assert.equal(m1.messages.length, 2)
    assert.equal(m1.messages[1].from, 'admin')
    assert.deepEqual(m1.messages[1].images, [adminShot.url])
    await s.call('support.markRead', t1.id)
    await s.call('support.reply', t1.id, 'Still silent')
    mine = await s.call<Ticket[]>('support.mine')
    m1 = mine.find((t) => t.id === t1.id)!
    assert.equal(m1.unreadForCustomer, false)
    assert.equal(m1.status, 'open')
    assert.equal(m1.unreadForAdmin, true)
    await s.call('support.resolve', t1.id)
    assert.equal((await s.call<Ticket[]>('support.mine')).find((t) => t.id === t1.id)!.status, 'resolved')
    await assert.rejects(s.call('support.reply', '123', 'x'), /Ticket not found/)
  } finally { s.close() }
})

type WaStatus = { feature: boolean; state: string; step: number; ready: { offer: boolean; bill: boolean }; config: null | { tokenLast4: string; verified: unknown; templates: Record<string, { status: string }>; finishedAt: string | null } }
type WaMsg = { kind: string; to: string; status: string; body: string; customerName: string; attachment: string | null }
const TOKEN = 'EAAG' + 'x'.repeat(40) + 'WXYZ'

test('whatsapp: feature release, setup, bills, offers, campaigns', async () => {
  const s = await withShop()
  try {
    await s.call('business.update', { billing: { taxEnabled: false } })
    await assert.rejects(s.call('whatsapp.enable'), /isn’t available/)
    assert.equal((await s.call<WaStatus>('whatsapp.status')).state, 'off')

    // The product admin releases WhatsApp to everyone.
    await s.db.insert('feature_flags', { feature_key: 'whatsapp', name: 'WhatsApp integration', rollout: E.Rollout.all })
    await s.bump('global')
    let st = await s.call<WaStatus>('whatsapp.status')
    assert.deepEqual([st.feature, st.state, st.step, st.config], [true, 'not_set_up', 1, null])

    await assert.rejects(s.call('whatsapp.connect', { businessNumber: '9876500000', wabaId: '1234567890', phoneNumberId: '9876543210', token: TOKEN }), /Turn on WhatsApp first/)
    await s.call('whatsapp.enable')
    assert.equal((await s.call<WaStatus>('whatsapp.status')).step, 2)
    await assert.rejects(s.call('whatsapp.connect', { businessNumber: '9876500000', wabaId: '123', phoneNumberId: '9876543210', token: TOKEN }), /Business Account ID/)
    await assert.rejects(s.call('whatsapp.connect', { businessNumber: '9876500000', wabaId: '1234567890', phoneNumberId: '9876543210' }), /access token/)
    await s.call('whatsapp.connect', { businessNumber: '9876500000', wabaId: '1234567890', phoneNumberId: '9876543210', token: TOKEN })
    st = await s.call<WaStatus>('whatsapp.status')
    assert.equal(st.step, 3)
    assert.equal(st.config!.tokenLast4, 'WXYZ')
    assert.ok(!JSON.stringify(st).includes(TOKEN), 'token never reaches the browser')
    const secret = await s.db.first('secrets', { uniq_key: `2:${s.businessId}:1` })
    assert.equal(secret?.value, TOKEN)

    await assert.rejects(s.call('whatsapp.saveTemplate', 'bill', { language: 'en', body: 'Hi', attach: true }, true), /Connect and test/)
    const v = await s.call<{ name: string; quality: string }>('whatsapp.test')
    assert.equal(v.quality, 'High')
    const testMsg = await s.call<WaMsg>('whatsapp.sendTest')
    assert.equal(testMsg.kind, 'test')
    assert.equal(testMsg.status, 'sent')
    await assert.rejects(s.call('whatsapp.saveTemplate', 'bill', { language: 'en', body: '{{bill_no}}', attach: true }, true), /Fix the template first/)
    await assert.rejects(s.call('whatsapp.finishSetup'), /Submit at least one template/)
    await s.call('whatsapp.saveTemplate', 'bill', { language: 'en', body: 'Dear {{customer_name}}, your bill {{bill_no}} for {{amount}} is attached.', attach: true }, true)
    await s.call('whatsapp.saveTemplate', 'offer', { language: 'en', body: 'Hi {{customer_name}}! Today at {{shop_name}}: {{offer_details}}. Visit us!', attach: false }, true)
    await s.call('whatsapp.finishSetup')
    st = await s.call<WaStatus>('whatsapp.status')
    assert.deepEqual([st.state, st.step, st.config!.templates.bill.status, st.ready.bill], ['connected', 5, 'pending', false])

    // A bill to send.
    const cust = await s.call<{ id: string }>('customers.save', { name: 'Revathi Kumar', phone: '9800011122' })
    const prod = await s.call<{ id: string }>('products.save', { name: 'Milk', price: 27 })
    const line = { id: 'a', productId: prod.id, name: '', variantId: null, variantName: null, addOns: [], qty: 2, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 }
    const order = await s.call<{ id: string; invoiceNumber: string }>('orders.checkout', { type: 'counter', tableId: null, customerId: cust.id, items: [line], discount: 0, notes: '', source: 'pos' }, [{ method: 'cash', amount: 54 }])
    await assert.rejects(s.call('whatsapp.sendBill', order.id), /aren’t set up yet/)

    // Meta approves ~20 s after submitting (simulated): move the submit time back.
    for (const t of await s.db.select('whatsapp_templates', { where: { business_id: s.businessId } })) await s.db.update('whatsapp_templates', t.ROWID, { submitted_at: ago(60_000) })
    st = await s.call<WaStatus>('whatsapp.status')
    assert.deepEqual(st.ready, { offer: true, bill: true })
    const billMsg = await s.call<WaMsg>('whatsapp.sendBill', order.id)
    assert.equal(billMsg.to, '+919800011122')
    assert.equal(billMsg.body, `Dear Revathi, your bill ${order.invoiceNumber} for ₹54.00 is attached.`)
    assert.equal(billMsg.attachment, `${order.invoiceNumber}.pdf`)
    await assert.rejects(s.call('whatsapp.sendBill', '42'), /Bill not found/)

    // Offers skip customers who said no, have no mobile, or already got one today.
    const optOut = await s.call<{ id: string }>('customers.save', { name: 'Arun', phone: '9800011133', marketingOptIn: false })
    const noPhone = await s.call<{ id: string }>('customers.save', { name: 'Guest' })
    const r = await s.call<{ sent: number; skipped: number }>('whatsapp.sendOffer', { details: 'Milk ₹25\nCurd ₹30', customerIds: [cust.id, optOut.id, noPhone.id, '999'], productIds: [prod.id], poster: false })
    assert.deepEqual(r, { sent: 1, skipped: 3 })
    await assert.rejects(s.call('whatsapp.sendOffer', { details: 'Again', customerIds: [cust.id], productIds: [], poster: false }), /No one to send to/)

    const msgs = await s.call<WaMsg[]>('whatsapp.messages', 100)
    assert.deepEqual(msgs.map((m) => m.kind), ['offer', 'bill', 'test'])
    assert.equal(msgs[0].body, 'Hi Revathi! Today at Test Mart: Milk ₹25 · Curd ₹30. Visit us!')
    assert.equal(msgs[0].customerName, 'Revathi Kumar')
    assert.equal(msgs[2].customerName, 'Lakshmi')
    // Receipts follow the message's age (simulated webhook): just sent → 'sent'.
    assert.ok(msgs.every((m) => m.status === 'sent'))

    // Campaigns: the sendOffer run is today's campaign; a manual share is tracked once per customer.
    type Camp = { id: string; message: string; productIds: string[]; sends: { customerId: string }[] }
    let camps = await s.call<Camp[]>('campaigns.today')
    assert.equal(camps.length, 1)
    assert.deepEqual(camps[0].sends.map((x) => x.customerId), [cust.id])
    const made = await s.call<Camp>('campaigns.create', { message: 'Diwali sweets 10% off', productIds: [prod.id] })
    await s.call('campaigns.update', made.id, 'Diwali sweets 15% off', [prod.id])
    await s.call('campaigns.markSent', made.id, optOut.id)
    await s.call('campaigns.markSent', made.id, optOut.id)
    camps = await s.call<Camp[]>('campaigns.today')
    const c2 = camps.find((x) => x.id === made.id)!
    assert.equal(c2.message, 'Diwali sweets 15% off')
    assert.equal(c2.sends.length, 1)
    assert.equal((await s.call<WaMsg[]>('whatsapp.messages')).length, 3, 'hand-shared offers are not API messages')

    await s.call('whatsapp.setAutoSendBill', true)
    await s.call('whatsapp.disconnect')
    st = await s.call<WaStatus>('whatsapp.status')
    assert.deepEqual([st.state, st.step, st.config], ['not_set_up', 1, null])
    assert.equal(await s.db.first('secrets', { uniq_key: `2:${s.businessId}:1` }), null)
  } finally { s.close() }
})

type Renewals = { settings: { daysBefore: number }; expiring: { id: string; dueToday: boolean; paused: boolean; sentThisCycle: number }[]; log: { businessId: string; trigger: string; adminName?: string; daysLeft: number; status: string; message: string }[]; whatsapp: { ready: boolean; templateStatus: string | null } }

test('renewal reminders: platform WhatsApp, manual and daily sends, pause', async () => {
  const s = await withShop()
  process.env.CRON_KEY = 'cron-key-1234567890'
  try {
    s.setToken(s.adminToken)
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
    const other = await s.call<{ id: string }>('admin.createCustomer', { businessName: 'Paused Shop', ownerName: 'Kumar', username: 'kumar1', password: 'shop1234', phone: '9876500011', validity: { endDate: day(3) }, maxBranches: 1 })
    await s.db.update('businesses', s.businessId, { subscription_end_at: new Date(Date.now() + 3 * 86_400_000).toISOString() })

    await assert.rejects(s.call('admin.sendReminder', s.businessId), /Set up WhatsApp first/)
    assert.equal(await s.call('admin.runReminders'), 0)

    // Platform WhatsApp: connect → test → template submitted → approved (simulated, ~20 s).
    let wa = await s.call<{ step: number; config: unknown }>('admin.waStatus')
    assert.deepEqual([wa.step, wa.config], [1, null])
    await assert.rejects(s.call('admin.waTest'), /Connect the account first/)
    await s.call('admin.waConnect', { businessNumber: '9000012345', wabaId: '1234567890', phoneNumberId: '1112223334', token: TOKEN })
    await s.call('admin.waTest')
    assert.equal(await s.call('admin.waSendTest', '9876543210'), '+919876543210')
    await assert.rejects(s.call('admin.waSaveTemplate', { language: 'en', body: 'Renew {owner}' }, true), /Fix the template first/)
    await s.call('admin.waSaveTemplate', { language: 'en', body: 'Hi {owner}, your plan for {business} ends on {date} — {days} left. Call {support} to renew.' }, true)
    wa = await s.call<{ step: number; config: { template: { status: string }; tokenLast4: string } }>('admin.waStatus')
    assert.equal(wa.step, 4)
    assert.equal((wa.config as { template: { status: string } }).template.status, 'pending')
    const platform = await s.env.dbs.platform()
    const tpl = await platform.first('whatsapp_templates', { uniq_key: `platform:${E.WaTemplateKind.renewal_reminder}` })
    await platform.update('whatsapp_templates', tpl!.ROWID, { submitted_at: ago(60_000) })

    let rn = await s.call<Renewals>('admin.renewals')
    assert.equal(rn.whatsapp.ready, true)
    assert.deepEqual(rn.expiring.map((r) => [r.id, r.dueToday]).sort(), [[other.id, true], [s.businessId, true]].sort())

    // Manual send: logged with the admin's name; the customer still gets today's automatic one.
    assert.equal(await s.call('admin.sendReminder', s.businessId), 1)
    rn = await s.call<Renewals>('admin.renewals')
    assert.equal(rn.log.length, 1)
    assert.deepEqual([rn.log[0].trigger, rn.log[0].adminName, rn.log[0].daysLeft, rn.log[0].status], ['manual', 'Admin', 3, 'sent'])
    assert.match(rn.log[0].message, /^Hi Lakshmi, your plan for Test Mart ends on .* — 3 days left\. Call \+91 90000 12345 to renew\.$/)
    assert.equal(rn.expiring.find((r) => r.id === s.businessId)!.dueToday, true)

    // Pause one customer: the daily job skips it.
    await s.call('admin.pauseReminders', other.id, true)
    rn = await s.call<Renewals>('admin.renewals')
    assert.deepEqual([rn.expiring.find((r) => r.id === other.id)!.paused, rn.expiring.find((r) => r.id === other.id)!.dueToday], [true, false])

    // The daily job: needs the cron key, sends once, and never twice on the same day.
    s.setToken(null)
    await assert.rejects(s.call('system.runDailyJobs', 'wrong'), /Not allowed/)
    assert.equal(await s.call('system.runDailyJobs', process.env.CRON_KEY), 1)
    assert.equal(await s.call('system.runDailyJobs', process.env.CRON_KEY), 0)
    s.setToken(s.adminToken)
    assert.equal(await s.call('admin.runReminders'), 0, 'already sent today')
    rn = await s.call<Renewals>('admin.renewals')
    assert.deepEqual(rn.log.map((l) => [l.businessId, l.trigger]), [[s.businessId, 'auto'], [s.businessId, 'manual']])
    assert.equal(rn.expiring.find((r) => r.id === s.businessId)!.sentThisCycle, 2)
    const status = await s.call<{ sent7: number; log: unknown[] }>('admin.waStatus')
    assert.equal(status.sent7, 2)

    // Settings.
    await assert.rejects(s.call('admin.updateReminderSettings', { daysBefore: 45 }), /between 1 and 30/)
    const saved = await s.call<Record<string, unknown>>('admin.updateReminderSettings', { daysBefore: 10, enabled: false })
    assert.deepEqual(Object.keys(saved).sort(), ['daysBefore', 'enabled', 'supportContact', 'template'])
    await s.call('admin.pauseReminders', other.id, false)
    assert.equal(await s.call('admin.runReminders'), 0, 'reminders turned off')

    await s.call('admin.waDisconnect')
    assert.equal((await s.call<{ config: unknown }>('admin.waStatus')).config, null)
    assert.equal(await s.db.first('secrets', { uniq_key: '1:0:1' }), null)
  } finally { s.close() }
})
