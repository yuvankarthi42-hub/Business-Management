// Product admin: renewal reminders (sent to shop owners from Kadai Kalanjiyam's own WhatsApp number), the platform
// WhatsApp setup, and system.runDailyJobs (called once a day by a Catalyst Cron).
//
// Storage (no reminder log table):
//  · platform_settings 'reminders' = { enabled, daysBefore, supportContact, template, lastRunOn }
//  · platform_settings 'whatsapp'  = { businessNumber, wabaId, phoneNumberId, verified, updatedAt }; its token in
//    secrets (owner platform, business_id NULL); the reminder template in whatsapp_templates (business_id NULL)
//  · history = whatsapp_messages (sender platform, kind renewal_reminder, business_id = the customer)
//  · a reminder an admin sent by hand also gets an admin_audit_logs row (action reminder) whose detail ends in
//    "msg <whatsapp_messages ROWID>" — that is what makes it trigger 'manual' with the admin's name in the log.
import type { PlatformWhatsApp, ReminderLog, ReminderSettings } from '@/core/types'
import { daysText, REMINDER_SAMPLE, reminderTemplateErrors } from '@/core/reminders'
import type { AdminSession, Ctx } from '../../core/context'
import { ApiError } from '../../core/errors'
import { adminRead, adminWrite, define, publicWrite } from '../../core/registry'
import type { Row } from '../../db/types'
import { eachShop } from '../../domain/directory'
import { selectIn } from '../../domain/orders'
import { expirePoints } from '../../domain/points'
import { bumpEpoch, pricePerBranch } from '../../domain/session'
import { bizDay, bizDayStart, E, getPlatformSetting, putPlatformSetting, str, strOrNull } from '../../domain/util'
import { cleanPhone } from '../business'
import { checkAccount, dropToken, formatNumberForLog, liveTemplateStatus, saveToken, sendWhatsApp, tokenRow, VALID_WA } from '../whatsapp'
import { adminLog, businessLite, findBiz } from './shared'

const DAY = 86_400_000
const TZ = 'Asia/Kolkata' // the platform's calendar day (the daily job, "once a day")
const TEMPLATE_KEY = `platform:${E.WaTemplateKind.renewal_reminder}`
const MSG_REF = /msg (\d+)$/

type Stored = ReminderSettings & { lastRunOn?: string | null }
export const DEFAULT_REMINDERS: ReminderSettings = { enabled: true, daysBefore: 7, supportContact: '+91 70139 05970', template: REMINDER_SAMPLE.en }

const loadSettings = async (c: Ctx): Promise<Stored> => ({ ...DEFAULT_REMINDERS, ...(await getPlatformSetting<Partial<Stored>>(c.platform, 'reminders', {})) })
const publicSettings = ({ enabled, daysBefore, supportContact, template }: Stored): ReminderSettings => ({ enabled, daysBefore, supportContact, template })

type WaSetting = Omit<PlatformWhatsApp, 'tokenLast4' | 'template'>
/** The platform's WhatsApp, as the admin screens show it (template status is live: simulated Meta approval). */
async function platformWa(c: Ctx): Promise<{ config: PlatformWhatsApp; tpl: Row | null } | null> {
  const [w, token, tpl] = await Promise.all([
    getPlatformSetting<WaSetting | null>(c.platform, 'whatsapp', null),
    tokenRow(c, 'platform', null),
    c.platform.first('whatsapp_templates', { uniq_key: TEMPLATE_KEY }),
  ])
  if (!w) return null
  return {
    tpl,
    config: {
      businessNumber: w.businessNumber, wabaId: w.wabaId, phoneNumberId: w.phoneNumberId, tokenLast4: str(token?.last4), verified: w.verified ?? null,
      template: tpl ? { language: str(tpl.language) as 'en' | 'ta', status: liveTemplateStatus(tpl, c.now), submittedAt: strOrNull(tpl.submitted_at), ...(tpl.reject_reason ? { reason: str(tpl.reject_reason) } : {}) } : null,
      updatedAt: w.updatedAt,
    },
  }
}
/** Reminders go out only when the platform WhatsApp is tested and the template is approved. */
const isReady = (w: Awaited<ReturnType<typeof platformWa>>) => !!w?.config.verified && w.config.template?.status === 'approved'

const daysLeftOf = (endAt: string | null, now: Date) => (endAt ? Math.ceil((new Date(endAt).getTime() - now.getTime()) / DAY) : -1)
const istDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

/** The owner of each business, from the directory copies in the platform database (name, mobile). */
async function ownersOf(c: Ctx, ids: string[]) {
  const rows = await selectIn(c, 'businesses', 'ROWID', ids)
  const out = new Map<string, Row>()
  for (const b of rows) if (b.owner_phone || b.owner_name) out.set(b.ROWID, { ROWID: str(b.owner_user_id), CREATEDTIME: '', MODIFIEDTIME: '', name: b.owner_name, phone: b.owner_phone, username: b.owner_username })
  return out
}

function fillReminder(template: string, cfg: ReminderSettings, price: number, now: Date, b: Row | null, owner: Row | null) {
  const end = b?.subscription_end_at ? new Date(str(b.subscription_end_at)) : new Date(now.getTime() + 3 * DAY)
  const left = b ? Math.max(0, daysLeftOf(strOrNull(b.subscription_end_at), now)) : 3
  const branches = b ? Number(b.max_branches ?? 1) : 2
  return template.replaceAll('{owner}', owner ? str(owner.name).split(' ')[0] : 'Lakshmi').replaceAll('{business}', b ? str(b.name) : 'FreshMart Supermarket')
    .replaceAll('{date}', end.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }))
    .replaceAll('{days}', daysText(left, template)).replaceAll('{amount}', `₹${(branches * price).toLocaleString('en-IN')}`)
    .replaceAll('{support}', cfg.supportContact)
}

/** whatsapp_messages ids of reminders sent by hand since `since` → the admin who sent them. */
async function manualSends(c: Ctx, since: string) {
  const logs = await c.platform.select('admin_audit_logs', { where: { action: E.AdminAction.reminder, CREATEDTIME: { gte: since } }, limit: 5000 })
  const out = new Map<string, string>()
  for (const l of logs) { const m = MSG_REF.exec(str(l.detail)); if (m) out.set(m[1], str(l.admin_name)) }
  return out
}

/** Businesses that should get today's automatic reminder: from N days before the end date, once a day. */
async function candidates(c: Ctx, cfg: ReminderSettings, trigger: 'auto' | 'manual') {
  if (trigger === 'auto' && !cfg.enabled) return []
  const now = c.now.getTime()
  let rows = await c.platform.select('businesses', {
    where: { deleted_at: null, status: E.BusinessStatus.active, subscription_end_at: { gt: new Date(now).toISOString(), lte: new Date(now + cfg.daysBefore * DAY).toISOString() } },
  })
  rows = rows.filter((b) => { const left = daysLeftOf(strOrNull(b.subscription_end_at), c.now); return left >= 1 && left <= cfg.daysBefore })
  if (trigger === 'manual' || !rows.length) return rows
  rows = rows.filter((b) => !b.reminders_paused)
  const start = bizDayStart(c)
  const [today, manual] = await Promise.all([
    selectIn(c, 'whatsapp_messages', 'business_id', rows.map((b) => b.ROWID), { sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, CREATEDTIME: { gte: start } }, c.platform),
    manualSends(c, start),
  ])
  const done = new Set(today.filter((m) => !manual.has(m.ROWID)).map((m) => str(m.business_id)))
  return rows.filter((b) => !done.has(b.ROWID))
}

/** Sends reminders from the platform number (simulated in this phase, see sendWhatsApp) and records them. */
async function sendReminders(c: Ctx, opts: { trigger: 'auto' | 'manual'; business?: Row; admin?: AdminSession }) {
  const [cfg, w] = await Promise.all([loadSettings(c), platformWa(c)])
  if (!isReady(w)) {
    if (opts.trigger === 'manual') throw new ApiError('Set up WhatsApp first (Admin → WhatsApp): connect, test, and get the reminder template approved')
    return 0
  }
  const list = opts.business ? [opts.business] : await candidates(c, cfg, opts.trigger)
  if (!list.length) return 0
  const [owners, price, token] = await Promise.all([ownersOf(c, list.map((b) => b.ROWID)), pricePerBranch(c.platform), tokenRow(c, 'platform', null)])
  let sent = 0
  for (const b of list) {
    const owner = owners.get(b.ROWID) ?? null
    const to = str(owner?.phone)
    const valid = VALID_WA.test(to)
    if (!valid && opts.trigger === 'manual') throw new ApiError('Not sent — the owner has no valid mobile number')
    const body = fillReminder(cfg.template, cfg, price, c.now, b, owner)
    const res = valid
      ? await sendWhatsApp({ phoneNumberId: w!.config.phoneNumberId, token: str(token?.value), to, template: { name: 'renewal_reminder', language: w!.config.template!.language }, body, attachment: null })
      : { status: 'failed' as const, messageId: null, error: 'No valid mobile number for the owner' }
    const msg = await c.platform.insert('whatsapp_messages', {
      business_id: b.ROWID, sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, to_number: to.slice(0, 16), template_id: w!.tpl?.ROWID ?? null,
      body, meta_message_id: res.messageId, status: E.WaMessageStatus[res.status], error: res.error, status_at: c.now.toISOString(), created_by: null,
    })
    if (opts.admin) await adminLog(c, opts.admin, 'reminder', { id: b.ROWID, name: str(b.name) }, `Renewal reminder sent on WhatsApp to ${formatNumberForLog(to)} · msg ${msg.ROWID}`)
    if (res.status === 'sent') sent++
  }
  return sent
}

/** whatsapp_messages rows → the admin screens' ReminderLog. `known` = businesses already loaded. */
async function reminderLogs(c: Ctx, rows: Row[], known: Row[] = []): Promise<ReminderLog[]> {
  if (!rows.length) return []
  const oldest = rows.reduce((m, r) => (r.CREATEDTIME < m ? r.CREATEDTIME : m), rows[0].CREATEDTIME)
  const have = new Map(known.map((b) => [b.ROWID, b]))
  const missing = rows.map((r) => str(r.business_id)).filter((id) => id && !have.has(id))
  const [manual, more] = await Promise.all([
    manualSends(c, new Date(new Date(oldest).getTime() - 60_000).toISOString()),
    missing.length ? selectIn(c, 'businesses', 'ROWID', missing) : Promise.resolve([] as Row[]),
  ])
  for (const b of more) have.set(b.ROWID, b)
  return rows.map((r) => {
    const b = have.get(str(r.business_id))
    const admin = manual.get(r.ROWID)
    return {
      id: r.ROWID, businessId: str(r.business_id), businessName: str(b?.name), date: istDay(r.CREATEDTIME),
      // Days left when it was sent: the business's end date (unchanged unless renewed since) minus the send time.
      daysLeft: Math.max(0, daysLeftOf(strOrNull(b?.subscription_end_at), new Date(r.CREATEDTIME))), channel: 'whatsapp' as const, to: str(r.to_number), message: str(r.body),
      status: Number(r.status) === E.WaMessageStatus.failed ? 'failed' as const : 'sent' as const, ...(r.error ? { error: str(r.error) } : {}),
      trigger: admin ? 'manual' as const : 'auto' as const, ...(admin ? { adminName: admin } : {}), createdAt: r.CREATEDTIME,
    }
  })
}
const recentReminders = (c: Ctx, limit: number) => c.platform.select('whatsapp_messages', { where: { sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder }, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit })

/** The daily job: today's automatic reminders, at most once per (IST) day. Returns how many were sent. */
export async function runDailyJobs(c: Ctx) {
  // Sign-in names claimed by a new-user save that never finished (user_id 0) are freed after a day.
  const stale = await c.platform.select('login_names', { where: { user_id: '0', CREATEDTIME: { lt: new Date(c.now.getTime() - DAY).toISOString() } }, limit: 500 })
  if (stale.length) await c.platform.deleteMany('login_names', stale.map((r) => r.ROWID))
  const today = bizDay(c)
  // Loyalty points past their expiry date (safe to run more than once a day).
  const shops = await c.platform.select('businesses', { where: { deleted_at: null } })
  await eachShop(c, shops.map((b) => b.ROWID), async (bid, db) => { await expirePoints(db, bid, today) })
  if ((await loadSettings(c)).lastRunOn === today) return 0
  if (!isReady(await platformWa(c))) return 0
  // Claim the day first, inside one transaction, so a second run (retry, overlapping cron) doesn't send again.
  const claimed = await c.platformTx(async () => {
    const cfg = await loadSettings(c)
    if (cfg.lastRunOn === today) return false
    await putPlatformSetting(c.platform, 'reminders', { ...cfg, lastRunOn: today })
    return true
  })
  return claimed ? sendReminders(c, { trigger: 'auto' }) : 0
}

define('system', {
  /** Called by the daily Catalyst Cron with the CRON_KEY secret (no user or admin session). */
  runDailyJobs: publicWrite(async (c, key?: string) => {
    const want = process.env.CRON_KEY
    if (!want || String(key ?? '') !== want) throw new ApiError('Not allowed', 403, 'FORBIDDEN')
    return runDailyJobs(c)
  }),
})

define('admin', {
  // ---- renewal reminders ----
  renewals: adminRead('customers.view', async (c) => {
    const [cfg, w, price, bizRows] = await Promise.all([loadSettings(c), platformWa(c), pricePerBranch(c.platform), c.platform.select('businesses', { where: { deleted_at: null } })])
    const ids = bizRows.map((b) => b.ROWID)
    const since = new Date(c.now.getTime() - 90 * DAY).toISOString()
    const [owners, last, recent, due, logRows] = await Promise.all([
      ownersOf(c, ids),
      c.platform.aggregate('whatsapp_messages', { where: { sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder }, groupBy: ['business_id'], fns: { last: ['MAX', 'CREATEDTIME'] } }),
      c.platform.select('whatsapp_messages', { where: { sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, CREATEDTIME: { gte: since } }, limit: 5000 }),
      candidates(c, cfg, 'auto'),
      recentReminders(c, 200),
    ])
    const dueIds = new Set(due.map((b) => b.ROWID))
    const rows = bizRows.map((r) => {
      const b = businessLite(r)
      const owner = owners.get(r.ROWID)
      const endAt = b.st.endAt ?? null
      const from = endAt ? new Date(new Date(endAt).getTime() - (cfg.daysBefore + 1) * DAY).toISOString() : null
      return {
        id: b.id, name: b.name, state: b.st.state, endAt, daysLeft: endAt ? daysLeftOf(endAt, c.now) : null, paused: b.remindersPaused,
        ownerName: str(owner?.name), phone: str(owner?.phone), monthly: b.maxBranches * price,
        sentThisCycle: from ? recent.filter((m) => m.business_id === r.ROWID && m.CREATEDTIME > from).length : 0,
        lastSent: strOrNull(last.find((x) => x.business_id === r.ROWID)?.last as string),
        dueToday: dueIds.has(r.ROWID),
      }
    })
    return {
      settings: publicSettings(cfg),
      expiring: rows.filter((r) => r.state !== 'deactivated' && r.daysLeft !== null && r.daysLeft > 0 && r.daysLeft <= Math.max(cfg.daysBefore, 14)).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      expired: rows.filter((r) => r.state === 'expired' && r.daysLeft !== null && r.daysLeft > -30).sort((a, b) => (b.daysLeft ?? 0) - (a.daysLeft ?? 0)),
      log: await reminderLogs(c, logRows, bizRows),
      whatsapp: { ready: isReady(w), connected: !!w?.config.verified, templateStatus: w?.config.template?.status ?? null, preview: fillReminder(cfg.template, cfg, price, c.now, null, null) },
    }
  }),

  /** Today's automatic reminders, now (same rules as the daily job: once per customer per day). */
  runReminders: adminWrite('customers.renew', async (c) => sendReminders(c, { trigger: 'auto' }), { tx: 'none' }),

  sendReminder: adminWrite('customers.renew', async (c, businessId: string) => {
    const a = c.requireAdmin()
    const b = await findBiz(c, businessId)
    const n = await sendReminders(c, { trigger: 'manual', business: b, admin: a })
    if (!n) throw new ApiError('Not sent — the owner has no valid mobile number')
    return n
  }, { tx: 'none' }),

  pauseReminders: adminWrite('customers.renew', async (c, businessId: string, paused: boolean) => {
    const a = c.requireAdmin()
    const b = await findBiz(c, businessId)
    await c.platform.update('businesses', b.ROWID, { reminders_paused: !!paused })
    await adminLog(c, a, 'reminder', { id: b.ROWID, name: str(b.name) }, paused ? 'Renewal reminders paused' : 'Renewal reminders resumed')
    await bumpEpoch(c, b.ROWID) // Business.remindersPaused is part of the cached session
  }),

  updateReminderSettings: adminWrite('pricing.manage', async (c, patch: Partial<ReminderSettings>) => {
    const a = c.requireAdmin()
    const cur = await loadSettings(c)
    const p = patch ?? {}
    const next: Stored = {
      ...cur,
      ...(p.enabled !== undefined ? { enabled: !!p.enabled } : {}),
      ...(p.daysBefore !== undefined ? { daysBefore: Number(p.daysBefore) } : {}),
      ...(p.supportContact !== undefined ? { supportContact: String(p.supportContact).trim().slice(0, 40) } : {}),
      ...(p.template !== undefined ? { template: String(p.template).trim().slice(0, 1000) } : {}),
    }
    if (!(Number.isInteger(next.daysBefore) && next.daysBefore >= 1 && next.daysBefore <= 30)) throw new ApiError('Start between 1 and 30 days before')
    await putPlatformSetting(c.platform, 'reminders', next, a.id)
    await adminLog(c, a, 'settings', null, `Renewal reminders: ${next.enabled ? `on, from ${next.daysBefore} days before` : 'off'}`)
    return publicSettings(next)
  }),

  // ---- platform WhatsApp (sends renewal reminders from Kadai Kalanjiyam's own number) ----
  waStatus: adminRead('customers.view', async (c) => {
    const [w, cfg, price, sent7, logRows] = await Promise.all([
      platformWa(c), loadSettings(c), pricePerBranch(c.platform),
      c.platform.count('whatsapp_messages', { sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, status: { ne: E.WaMessageStatus.failed }, CREATEDTIME: { gte: new Date(c.now.getTime() - 7 * DAY).toISOString() } }),
      recentReminders(c, 50),
    ])
    const x = w?.config
    const step = !x?.phoneNumberId ? 1 : !x.verified ? 2 : !x.template || x.template.status === 'draft' ? 3 : 4
    return { config: x ?? null, step, ready: isReady(w), template: cfg.template, daysBefore: cfg.daysBefore, preview: fillReminder(cfg.template, cfg, price, c.now, null, null), sent7, log: await reminderLogs(c, logRows) }
  }),

  waConnect: adminWrite('pricing.manage', async (c, input: { businessNumber: string; wabaId: string; phoneNumberId: string; token?: string }) => {
    const a = c.requireAdmin()
    const { businessNumber, wabaId, phoneNumberId, token } = checkAccount(input ?? {}, 'IN', 'Enter the WhatsApp Business number')
    const hasToken = !!(await tokenRow(c, 'platform', null))
    if (!token && !hasToken) throw new ApiError('Paste the permanent access token')
    if (token) await saveToken(c, 'platform', null, token)
    const w = await getPlatformSetting<WaSetting | null>(c.platform, 'whatsapp', null)
    const changed = !w || w.businessNumber !== businessNumber || w.wabaId !== wabaId || w.phoneNumberId !== phoneNumberId || !!token
    const next: WaSetting = { businessNumber, wabaId, phoneNumberId, verified: changed ? null : w!.verified ?? null, updatedAt: c.now.toISOString() }
    await putPlatformSetting(c.platform, 'whatsapp', next, a.id)
    await adminLog(c, a, 'settings', null, `WhatsApp account saved (${formatNumberForLog(businessNumber)})`)
  }),

  /** Simulated GET /{phone-number-id}. */
  waTest: adminWrite('pricing.manage', async (c) => {
    const a = c.requireAdmin()
    const w = await getPlatformSetting<WaSetting | null>(c.platform, 'whatsapp', null)
    if (!w?.phoneNumberId || !(await tokenRow(c, 'platform', null))) throw new ApiError('Connect the account first')
    const verified = { name: 'Kadai Kalanjiyam', number: w.businessNumber, quality: 'High' as const, at: c.now.toISOString() }
    await putPlatformSetting(c.platform, 'whatsapp', { ...w, verified, updatedAt: c.now.toISOString() }, a.id)
    await adminLog(c, a, 'settings', null, 'WhatsApp connection tested — OK')
    return verified
  }),

  waSendTest: adminWrite('pricing.manage', async (c, to: string) => {
    const a = c.requireAdmin()
    const w = await getPlatformSetting<WaSetting | null>(c.platform, 'whatsapp', null)
    if (!w?.verified) throw new ApiError('Test the connection first')
    const num = cleanPhone(to, 'IN', 'Enter a mobile number')
    const token = await tokenRow(c, 'platform', null)
    const body = 'Test message from Kadai Kalanjiyam. The WhatsApp connection for renewal reminders works.'
    const res = await sendWhatsApp({ phoneNumberId: w.phoneNumberId, token: str(token?.value), to: num, template: null, body, attachment: null })
    await c.platform.insert('whatsapp_messages', {
      business_id: null, sender: E.WaSender.platform, kind: E.WaMessageKind.test, to_number: num.slice(0, 16), body, meta_message_id: res.messageId,
      status: E.WaMessageStatus[res.status], error: res.error, status_at: c.now.toISOString(), created_by: null,
    })
    await adminLog(c, a, 'settings', null, `WhatsApp test message sent to ${formatNumberForLog(num)}`)
    return num
  }, { tx: 'none' }),

  /** Save the renewal reminder template as a draft, or submit it to Meta for approval. */
  waSaveTemplate: adminWrite('pricing.manage', async (c, input: { language: 'en' | 'ta'; body: string }, submit: boolean) => {
    const a = c.requireAdmin()
    const w = await getPlatformSetting<WaSetting | null>(c.platform, 'whatsapp', null)
    if (!w?.verified) throw new ApiError('Connect and test the account first')
    const body = String(input?.body ?? '').trim()
    const errs = reminderTemplateErrors(body)
    if (submit && errs.length) throw new ApiError(`Fix the template first: ${errs.join(' · ')}`)
    if (!body) throw new ApiError('Write the message')
    const language = input.language === 'ta' ? 'ta' : 'en'
    await putPlatformSetting(c.platform, 'reminders', { ...(await loadSettings(c)), template: body.slice(0, 1000) }, a.id)
    const data = {
      language, body: body.slice(0, 1000), attach: false, meta_template_name: 'renewal_reminder', status: submit ? E.WaTemplateStatus.pending : E.WaTemplateStatus.draft,
      reject_reason: null, submitted_at: submit ? c.now.toISOString() : null, approved_at: null,
    }
    const ex = await c.platform.first('whatsapp_templates', { uniq_key: TEMPLATE_KEY })
    if (ex) await c.platform.update('whatsapp_templates', ex.ROWID, data)
    else await c.platform.insert('whatsapp_templates', { business_id: null, kind: E.WaTemplateKind.renewal_reminder, uniq_key: TEMPLATE_KEY, ...data })
    await adminLog(c, a, 'settings', null, submit ? 'Renewal reminder template sent to Meta for approval' : 'Renewal reminder template saved as draft')
  }),

  waDisconnect: adminWrite('pricing.manage', async (c) => {
    const a = c.requireAdmin()
    const [setting, tpl] = await Promise.all([c.platform.first('platform_settings', { setting_key: 'whatsapp' }), c.platform.first('whatsapp_templates', { uniq_key: TEMPLATE_KEY })])
    if (setting) await c.platform.delete('platform_settings', setting.ROWID)
    if (tpl) await c.platform.delete('whatsapp_templates', tpl.ROWID)
    await dropToken(c, 'platform', null)
    await adminLog(c, a, 'settings', null, 'WhatsApp disconnected — renewal reminders stopped')
  }),
})
