// v18 demo data: staff pay + this month's attendance, contractor price list for the hardware shop.
import { REMINDER_SAMPLE } from '@/core/reminders'
import type { AttendanceStatus, Role, StaffPay, User } from '@/core/types'
import type { DB } from './db'
import { ownerOf } from './seedPlatform'

const PAY: Record<string, StaffPay> = {
  Manager: { type: 'monthly', amount: 22000, commissionPct: 1 },
  Cashier: { type: 'monthly', amount: 15000, commissionPct: 0.5 },
  Waiter: { type: 'daily', amount: 600, commissionPct: 1 },
  'Kitchen Staff': { type: 'monthly', amount: 18000, commissionPct: 0 },
}
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function seedStaffAndWholesale(d: DB) {
  d.attendance ??= []; d.advances ??= []; d.salaries ??= []
  const roleOf = (u: User): Role | undefined => d.roles.find((r) => r.id === u.roleId)
  const today = new Date()
  for (const b of d.businesses) {
    const owner = ownerOf(d, b)
    for (const u of d.users.filter((x) => x.businessId === b.id && x.active && x.id !== owner?.id)) {
      const role = roleOf(u)?.name ?? ''
      u.pay ??= PAY[role] ?? { type: 'monthly', amount: 14000, commissionPct: 0 }
      if (d.attendance.some((a) => a.userId === u.id)) continue
      // This month up to yesterday: mostly present, the odd half day, absence or leave.
      for (let day = 1; day < today.getDate(); day++) {
        const dt = new Date(today.getFullYear(), today.getMonth(), day)
        const h = (u.id.charCodeAt(u.id.length - 1) * 31 + day * 17) % 23
        const status: AttendanceStatus = h === 0 ? 'absent' : h === 7 ? 'half' : h === 13 ? 'leave' : 'present'
        d.attendance.push({
          id: `att_${u.id}_${day}`, businessId: b.id, branchId: u.branchId, userId: u.id, date: key(dt), status,
          checkIn: status === 'present' || status === 'half' ? `09:${String((h * 3) % 30).padStart(2, '0')}` : null,
          checkOut: status === 'present' ? `${18 + (h % 3)}:${String((h * 7) % 60).padStart(2, '0')}` : status === 'half' ? '13:30' : null,
          note: '', markedBy: owner?.id ?? u.id, markedAt: dt.toISOString(),
        })
      }
    }
  }
  // Hardware shop: contractor / electrician rate (about 8% below retail) and a contractor customer.
  const hw = d.businesses.find((x) => x.id === 'biz_murugan_hw')
  if (hw && !hw.billing.wholesale) {
    hw.billing.wholesale = { enabled: true, label: 'Contractor rate' }
    for (const p of d.products.filter((x) => x.businessId === hw.id && x.price >= 20)) {
      p.wholesalePrice = Math.round(p.price * 0.92)
      p.variants = p.variants.map((v) => ({ ...v, wholesalePrice: Math.round(v.price * 0.92) }))
    }
    const t = new Date().toISOString()
    if (!d.customers.some((c) => c.businessId === hw.id && /contractor/i.test(c.name))) {
      d.customers.push({ id: 'cus_hw_contractor', businessId: hw.id, name: 'Selvam Electricals (Contractor)', phone: '+919843210101', email: '', address: 'Ambattur, Chennai', notes: 'Electrical contractor', marketingOptIn: true, priceTier: 'wholesale', createdAt: t, createdBy: 'system', updatedAt: t, updatedBy: 'system' })
    }
  }
}

/** v19: the hardware shop's contractor / builder customers use the contractor rate. */
export function markContractors(d: DB) {
  for (const c of d.customers) if (c.businessId === 'biz_murugan_hw' && /contractor|builders|works/i.test(c.name)) c.priceTier ??= 'wholesale'
}

/** v20 demo: two support tickets (so the admin Support page has something to show). */
export function seedSupport(d: DB) {
  d.tickets ??= []; d.reminderLog ??= []
  // Never in the future: today's events are placed before the current time.
  const ago = (days: number, h = 11) => { const x = new Date(); x.setDate(x.getDate() - days); x.setHours(h, 20, 0, 0); if (x > new Date()) x.setTime(Date.now() - (24 - h) * 60_000 * 5); return x.toISOString() }
  const biz = (id: string) => d.businesses.find((b) => b.id === id)
  const fm = biz('biz_freshmart'), hw = biz('biz_murugan_hw')
  if (!d.tickets.length && fm && hw) {
    const fmOwner = ownerOf(d, fm)!, hwOwner = ownerOf(d, hw)!
    d.tickets.push({
      id: 'tkt_demo1', number: 'T-1001', businessId: fm.id, businessName: fm.name, userId: fmOwner.id, userName: fmOwner.name, userPhone: fmOwner.phone,
      subject: 'Bill not printing on the thermal printer', category: 'printer', priority: 'high', status: 'open', assignedTo: null,
      context: { page: '/billing', browser: 'Chrome 129', version: '1.0.0-mock' },
      messages: [{ id: 'tm_d1', from: 'customer', authorId: fmOwner.id, authorName: fmOwner.name, text: 'After payment the bill doesn’t come out of the TVS printer. Test print from Settings works. Started today morning.', images: [], at: ago(0, 9) }],
      createdAt: ago(0, 9), updatedAt: ago(0, 9), unreadForAdmin: true, unreadForCustomer: false,
    }, {
      id: 'tkt_demo2', number: 'T-1002', businessId: hw.id, businessName: hw.name, userId: hwOwner.id, userName: hwOwner.name, userPhone: hwOwner.phone,
      subject: 'How do I give contractor rate to one customer?', category: 'billing', priority: 'normal', status: 'waiting', assignedTo: 'adm_support',
      context: { page: '/customers', browser: 'Chrome 129', version: '1.0.0-mock' },
      messages: [
        { id: 'tm_d2', from: 'customer', authorId: hwOwner.id, authorName: hwOwner.name, text: 'Raja Electricals should always get contractor price. Where do I set it?', images: [], at: ago(2, 16) },
        { id: 'tm_d3', from: 'admin', authorId: 'adm_support', authorName: 'Arun (Support)', text: 'Open Customers → Raja Electricals → Edit → Price list → Contractor rate. Bills for him will use the contractor price automatically.', images: [], at: ago(2, 17) },
      ],
      createdAt: ago(2, 16), updatedAt: ago(2, 17), unreadForAdmin: false, unreadForCustomer: true,
    })
  }
}

/** v21: demo tickets that were saved with a time later today are moved to just before now. */
export function fixFutureDemoTimes(d: DB) {
  const now = Date.now()
  let i = 0
  for (const t of d.tickets ?? []) {
    for (const m of t.messages) if (new Date(m.at).getTime() > now) m.at = new Date(now - (++i) * 9 * 60_000).toISOString()
    if (new Date(t.createdAt).getTime() > now) t.createdAt = t.messages[0]?.at ?? new Date(now).toISOString()
    if (new Date(t.updatedAt).getTime() > now) t.updatedAt = t.messages.at(-1)?.at ?? t.createdAt
  }
}

/** v22: renewal reminders are WhatsApp only (SMS removed) and go out only after the admin connects WhatsApp. */
export function dropSmsReminders(d: DB) {
  d.reminderLog = (d.reminderLog ?? []).filter((l) => (l.channel as string) !== 'sms')
  const r = d.platform.reminders
  if (r) {
    delete (r as { channels?: unknown }).channels
    // Meta templates can't end with a field — the old default did.
    if (r.template.endsWith('Call or WhatsApp us: {support}')) r.template = REMINDER_SAMPLE.en
  }
}

/** v23: the Health page and its event log were removed. */
export function dropHealthEvents(d: DB) {
  delete (d as { healthEvents?: unknown }).healthEvents
}
