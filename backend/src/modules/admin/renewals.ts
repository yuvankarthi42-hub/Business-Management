// Product admin: renewal reminders (sent to shop owners from Kadai Kalanjiyam's own WhatsApp number), the platform
// WhatsApp setup, and system.runDailyJobs (called once a day by a Catalyst Cron).
//
//  · platform_settings 'dailyJobs' = the hourly daily-jobs state (lease, round, batch in progress — see runDailyBatch)
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
import { selectIn } from '../../domain/orders'
import { expireCustomerPoints } from '../../domain/points'
import { mergeUsageCopy, usageFromRow, usageQuery, type ShopUsage } from '../../domain/usage'
import { outgoing, countRequest } from '../../core/meter'
import { idBefore } from '@/core/paging'
import { bumpEpoch, loadPricing, type Pricing } from '../../domain/session'
import { DEFAULT_PLANS, monthlyValue } from '@/core/plans'
import { bizDay, bizDayStart, E, getPlatformSetting, putPlatformSetting, str, strOrNull } from '../../domain/util'
import { cleanPhone } from '../business'
import { checkAccount, dropToken, formatNumberForLog, liveTemplateStatus, saveToken, sendWhatsApp, tokenRow, VALID_WA } from '../whatsapp'
import { adminLog, businessLite, customerPrice, findBiz } from './shared'
import { dateFormat } from '@/core/intl'

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
const istDay = (iso: string) => dateFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

/** The owner of each business, from the directory copies in the platform database (name, mobile). */
async function ownersOf(c: Ctx, ids: string[]) {
  const rows = await selectIn(c, 'businesses', 'ROWID', ids)
  const out = new Map<string, Row>()
  for (const b of rows) if (b.owner_phone || b.owner_name) out.set(b.ROWID, { ROWID: str(b.owner_user_id), CREATEDTIME: '', MODIFIEDTIME: '', name: b.owner_name, phone: b.owner_phone, username: b.owner_username })
  return out
}

function fillReminder(template: string, cfg: ReminderSettings, pricing: Pricing | null, now: Date, b: Row | null, owner: Row | null) {
  const end = b?.subscription_end_at ? new Date(str(b.subscription_end_at)) : new Date(now.getTime() + 3 * DAY)
  const left = b ? Math.max(0, daysLeftOf(strOrNull(b.subscription_end_at), now)) : 3
  const branches = b ? Number(b.max_branches ?? 1) : 2
  return template.replaceAll('{owner}', owner ? str(owner.name).split(' ')[0] : 'Lakshmi').replaceAll('{business}', b ? str(b.name) : 'FreshMart Supermarket')
    .replaceAll('{date}', end.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }))
    .replaceAll('{days}', daysText(left, template)).replaceAll('{amount}', `₹${monthlyValue(b && pricing ? customerPrice(pricing, b).price : (pricing?.plans.retail ?? DEFAULT_PLANS.retail), branches).toLocaleString('en-IN')}`)
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
  return (await sendReminderBatch(c, opts)).sent
}

/**
 * The reminders due now, up to `limit` (and while `canSend()` says there is room in this run's request budget).
 * Never twice: the message row is saved as "queued" BEFORE the WhatsApp request, so a run that stops between the
 * two leaves a row that already counts as today's reminder (see resolveStuckReminders) — it is not sent again.
 * `more` = reminders still due after this batch.
 */
async function sendReminderBatch(c: Ctx, opts: { trigger: 'auto' | 'manual'; business?: Row; admin?: AdminSession; limit?: number; canSend?: () => boolean }) {
  const [cfg, w] = await Promise.all([loadSettings(c), platformWa(c)])
  if (!isReady(w)) {
    if (opts.trigger === 'manual') throw new ApiError('Set up WhatsApp first (Admin → WhatsApp): connect, test, and get the reminder template approved')
    return { sent: 0, more: false, ready: false }
  }
  const due = opts.business ? [opts.business] : await candidates(c, cfg, opts.trigger)
  const list = due.slice(0, opts.limit ?? due.length)
  if (!list.length) return { sent: 0, more: false, ready: true }
  const [owners, price, token] = await Promise.all([ownersOf(c, list.map((b) => b.ROWID)), loadPricing(c.platform), tokenRow(c, 'platform', null)])
  let sent = 0, handled = 0
  for (const b of list) {
    if (opts.canSend && handled > 0 && !opts.canSend()) break
    handled++
    const owner = owners.get(b.ROWID) ?? null
    const to = str(owner?.phone)
    const valid = VALID_WA.test(to)
    if (!valid && opts.trigger === 'manual') throw new ApiError('Not sent — the owner has no valid mobile number')
    const body = fillReminder(cfg.template, cfg, price, c.now, b, owner)
    const row = {
      business_id: b.ROWID, sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, to_number: to.slice(0, 16), template_id: w!.tpl?.ROWID ?? null,
      body, created_by: null,
    }
    let msg: Row
    let status: 'sent' | 'failed'
    if (!valid) {
      msg = await c.platform.insert('whatsapp_messages', { ...row, meta_message_id: null, status: E.WaMessageStatus.failed, error: 'No valid mobile number for the owner', status_at: c.now.toISOString() })
      status = 'failed'
    } else {
      // Saved first ("queued"), then sent, then the result: a stop in between never sends a second message.
      msg = await c.platform.insert('whatsapp_messages', { ...row, meta_message_id: null, status: E.WaMessageStatus.queued, error: null, status_at: c.now.toISOString() })
      countRequest()
      const res = await sendWhatsApp({ phoneNumberId: w!.config.phoneNumberId, token: str(token?.value), to, template: { name: 'renewal_reminder', language: w!.config.template!.language }, body, attachment: null })
      await c.platform.update('whatsapp_messages', msg.ROWID, { meta_message_id: res.messageId, status: E.WaMessageStatus[res.status], error: res.error, status_at: c.now.toISOString() })
      status = res.status
    }
    if (opts.admin) await adminLog(c, opts.admin, 'reminder', { id: b.ROWID, name: str(b.name) }, `Renewal reminder sent on WhatsApp to ${formatNumberForLog(to)} · msg ${msg.ROWID}`)
    if (status === 'sent') sent++
  }
  return { sent, more: due.length > handled, ready: true }
}

/**
 * Reminders left "queued" by a run that stopped while sending (over 15 minutes ago): we can't know whether
 * WhatsApp got them, so they are marked failed with a note — never sent again automatically (no duplicates).
 */
async function resolveStuckReminders(c: Ctx) {
  const stuck = await c.platform.select('whatsapp_messages', { where: { sender: E.WaSender.platform, kind: E.WaMessageKind.renewal_reminder, status: E.WaMessageStatus.queued, CREATEDTIME: { lt: new Date(Date.now() - 15 * 60_000).toISOString() } }, limit: 50 })
  if (stuck.length) await c.platform.updateMany('whatsapp_messages', stuck.map((m) => ({ ROWID: m.ROWID, status: E.WaMessageStatus.failed, error: 'Not confirmed — the server stopped while sending. Not sent again automatically; send it by hand if needed.', status_at: new Date().toISOString() })))
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
// ---------- daily jobs, in hourly batches ----------
//
// Each run (hourly; Catalyst: the 09:00 cron repeats runs until all is done) takes a lease so only one run works at
// a time, then: frees unused sign-in names, sends due renewal reminders (from DAILY_REMINDER_HOUR, IST), and visits
// the next shops (expire points + count bills for Admin → Usage). Nothing is skipped:
//   • The claimed shops are saved as the run's batch BEFORE any work; a shop is marked done only after its work
//     succeeded. A run that stops (crash, time limit) leaves the batch; the next run (after the lease runs out)
//     does the shops not marked done. The work is safe to repeat, so redoing a shop is harmless.
//   • A shop that fails is tried again on the next runs; after 3 failed runs it is set aside (logged in the state's
//     `failed` list) so one broken shop can't hold up the others, and the next round tries it again.
//   • A run stops before the request budget (Cloudflare free: 50 outgoing requests per run) or the CPU budget runs
//     out; the shops left wait for the next run.
// Settings (env): DAILY_SHOPS_PER_RUN (20), DAILY_REMINDERS_PER_RUN (20), DAILY_REQUEST_BUDGET (40),
// DAILY_CPU_BUDGET_MS (7), DAILY_REMINDER_HOUR (9, IST).

const envInt = (name: string, def: number, min: number, max: number) => {
  const n = Math.floor(Number(process.env[name]))
  return Number.isFinite(n) && n >= min && n <= max ? n : def
}
export const dailySettings = () => ({
  shopsPerRun: envInt('DAILY_SHOPS_PER_RUN', 20, 1, 500),
  remindersPerRun: envInt('DAILY_REMINDERS_PER_RUN', 20, 1, 500),
  requestBudget: envInt('DAILY_REQUEST_BUDGET', 40, 10, 100_000),
  cpuBudgetMs: envInt('DAILY_CPU_BUDGET_MS', 7, 1, 600_000),
  reminderHour: envInt('DAILY_REMINDER_HOUR', 9, 0, 23),
})
const LEASE_MS = 10 * 60_000
const MAX_TRIES = 3
/** Requests a run keeps for its end: saving the batch, the usage copy and giving the lease back. */
const END_RESERVE = 8
/** Requests one customer's points expiry takes (one transaction). */
const PER_CUSTOMER = 7

interface DailyState {
  lease: { id: string; until: number } | null
  /** One pass over every shop: started (day + time), the last shop of the batches finished, finished (day). */
  round: { startedOn: string; startedAt: string; after: string | null; finishedOn: string | null }
  /** The shops claimed by the current (or a stopped) run; `done` only after a shop's work succeeded. */
  batch: { shops: string[]; done: string[]; tries: Record<string, number> } | null
  /** Shops set aside after MAX_TRIES failed runs (newest first, at most 50). */
  failed: { id: string; on: string; error: string }[]
  /** The day the renewal reminders were all sent (or WhatsApp wasn't set up). */
  remindersOn: string | null
  /** The day unused sign-in names were last freed. */
  cleanedOn?: string | null
}
const freshState = (c: Ctx): DailyState => ({ lease: null, round: { startedOn: bizDay(c), startedAt: c.now.toISOString(), after: null, finishedOn: null }, batch: null, failed: [], remindersOn: null })
const readDaily = async (c: Ctx) => ({ ...freshState(c), ...(await getPlatformSetting<Partial<DailyState>>(c.platform, 'dailyJobs', {})) }) as DailyState
const sqlOf = (c: Ctx) => (c.dbs.perShop && c.platform.sql ? c.platform.sql.bind(c.platform) : null)
const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/** Take the run's lease (null = another run holds it). Turso: one conditional UPDATE; otherwise a transaction. */
async function takeLease(c: Ctx, lease: { id: string; until: number }): Promise<DailyState | null> {
  const sql = sqlOf(c)
  if (sql) {
    for (let i = 0; i < 2; i++) {
      const r = await sql(`UPDATE "platform_settings" SET "value_json" = json_set("value_json", '$.lease', json(?)), "updated_at" = ${NOW_SQL}
        WHERE "setting_key" = 'dailyJobs' AND (json_extract("value_json", '$.lease') IS NULL OR json_extract("value_json", '$.lease.until') < ?) RETURNING "value_json"`, [JSON.stringify(lease), Date.now()])
      if (r.length) return { ...freshState(c), ...JSON.parse(String(r[0].value_json)) } as DailyState
      if (i > 0) return null
      // No state yet (first run ever): create it, then take the lease. Already there = another run holds the lease.
      const made = await sql(`INSERT INTO "platform_settings" ("setting_key", "value_json") VALUES ('dailyJobs', ?) ON CONFLICT ("setting_key") DO NOTHING RETURNING "id"`, [JSON.stringify({ ...freshState(c), lease: null })])
      if (!made.length) return null
    }
    return null
  }
  return c.platformTx(async () => {
    const st = await readDaily(c)
    if (st.lease && st.lease.until > Date.now()) return null
    st.lease = lease
    await putPlatformSetting(c.platform, 'dailyJobs', st)
    return st
  })
}
/** Save the state while this run still holds the lease (false = a newer run took over after ours ran out). */
async function saveDaily(c: Ctx, st: DailyState, leaseId: string): Promise<boolean> {
  const sql = sqlOf(c)
  if (sql) {
    const r = await sql(`UPDATE "platform_settings" SET "value_json" = ?, "updated_at" = ${NOW_SQL} WHERE "setting_key" = 'dailyJobs' AND json_extract("value_json", '$.lease.id') = ? RETURNING "id"`, [JSON.stringify(st), leaseId])
    return r.length > 0
  }
  return c.platformTx(async () => {
    const now = await readDaily(c)
    if (now.lease && now.lease.id !== leaseId) return false
    await putPlatformSetting(c.platform, 'dailyJobs', st)
    return true
  })
}
const istHour = (d: Date) => Number(dateFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(d))

/** The next shops after `after`, in id order. One database per shop: by id in the query; one database: in memory. */
async function nextShops(c: Ctx, after: string | null, n: number): Promise<string[]> {
  if (c.dbs.perShop) {
    const rows = await c.platform.select('businesses', { where: { deleted_at: null, ...(after ? { ROWID: { gt: after } } : {}) }, orderBy: [['ROWID', 'ASC']], limit: n })
    return rows.map((r) => r.ROWID)
  }
  const ids = (await c.platform.select('businesses', { where: { deleted_at: null } })).map((r) => r.ROWID).sort((a, b) => (idBefore(a, b) ? -1 : idBefore(b, a) ? 1 : 0))
  return ids.filter((id) => !after || idBefore(after, id)).slice(0, n)
}

export interface DailyRun { busy: boolean; sent: number; shops: number; idle: boolean }

/**
 * One run of the daily jobs (see above). `remindersFromHour` = from which IST hour reminders go (the Catalyst
 * daily cron passes 0: it already runs at 09:00). Returns what it did; `idle` = nothing left for today.
 */
export async function runDailyBatch(c: Ctx, opts: { remindersFromHour?: number } = {}): Promise<DailyRun> {
  const cfg = dailySettings()
  const startReq = outgoing.n
  const cpu0 = typeof process !== 'undefined' && typeof process.cpuUsage === 'function' ? process.cpuUsage() : null
  const used = () => outgoing.n - startReq
  const cpuMs = () => { if (!cpu0) return 0; const d = process.cpuUsage(cpu0); return (d.user + d.system) / 1000 }
  const room = (need: number) => used() + need + END_RESERVE <= cfg.requestBudget && cpuMs() <= cfg.cpuBudgetMs
  const today = bizDay(c)

  // Only one run at a time: take the lease (a stopped run's lease runs out after LEASE_MS).
  const lease = { id: Math.random().toString(36).slice(2), until: Date.now() + LEASE_MS }
  const st = await takeLease(c, lease)
  if (!st) return { busy: true, sent: 0, shops: 0, idle: false }
  st.lease = lease
  let sent = 0, shops = 0, remindersLeft = false
  try {
    // Once a day: sign-in names claimed by a new-user save that never finished (user_id 0) are freed after a day.
    if (st.cleanedOn !== today) {
      const stale = await c.platform.select('login_names', { where: { user_id: '0', CREATEDTIME: { lt: new Date(c.now.getTime() - DAY).toISOString() } }, limit: 500 })
      if (stale.length) await c.platform.deleteMany('login_names', stale.map((r) => r.ROWID))
      st.cleanedOn = today
    }

    // Renewal reminders: from the reminder hour, until all of today's are sent.
    if (st.remindersOn !== today && istHour(c.now) >= (opts.remindersFromHour ?? cfg.reminderHour)) {
      const rc = await loadSettings(c)
      if (rc.lastRunOn === today) st.remindersOn = today
      else {
        await resolveStuckReminders(c)
        const r = await sendReminderBatch(c, { trigger: 'auto', limit: cfg.remindersPerRun, canSend: () => room(4) })
        sent = r.sent
        remindersLeft = r.more
        if (!r.ready) st.remindersOn = today // WhatsApp not set up: nothing to send today (as the once-a-day job did)
        else if (!r.more) { st.remindersOn = today; await putPlatformSetting(c.platform, 'reminders', { ...rc, lastRunOn: today }) }
      }
    }

    // Shops: a new round once the last one is finished on an earlier day; an unfinished round carries on.
    if (st.round.finishedOn && st.round.finishedOn < today) st.round = { startedOn: today, startedAt: c.now.toISOString(), after: null, finishedOn: null }
    if (!st.round.finishedOn) {
      if (!st.batch) {
        const ids = await nextShops(c, st.round.after, cfg.shopsPerRun)
        if (!ids.length) st.round.finishedOn = today
        else st.batch = { shops: ids, done: [], tries: {} }
        // The claimed batch is saved before any work (in progress). Lost the lease meanwhile: stop, do nothing.
        if (!(await saveDaily(c, st, lease.id))) return { busy: true, sent, shops: 0, idle: false }
      }
      if (st.batch) {
        const b = st.batch
        const todo = b.shops.filter((id) => !b.done.includes(id))
        if (c.dbs.openMany && todo.length) await c.dbs.openMany(todo)
        const usage = new Map<string, ShopUsage>()
        for (const bid of todo) {
          if (shops > 0 && !room(2)) break // the rest wait for the next run
          try {
            const db = await c.shopDb(bid)
            const capFor = () => Math.max(shops > 0 ? 0 : 1, Math.floor((cfg.requestBudget - END_RESERVE - used() - 1) / PER_CUSTOMER))
            let due: string[], more = false
            if (c.dbs.perShop && db.sqlMany) {
              // One round trip: this shop's bill counts and who has expired points.
              const q = usageQuery(c, bid), cap = capFor()
              const [u, d] = await db.sqlMany([q, { sql: 'SELECT DISTINCT "customer_id" AS id FROM "customer_points" WHERE "business_id" = ? AND "remaining" > 0 AND "expires_on" < ? LIMIT ?', args: [Number(bid), today, cap + 1] }])
              usage.set(bid, usageFromRow(u[0]))
              due = d.map((r) => String(r.id))
              if (due.length > cap) { due = due.slice(0, cap); more = true }
            } else {
              const rows = await db.select('customer_points', { where: { business_id: bid, remaining: { gt: 0 }, expires_on: { lt: today } } })
              due = [...new Set(rows.map((r) => str(r.customer_id)))]
            }
            for (const cid of due) await expireCustomerPoints(db, bid, cid, today)
            shops++
            if (more) break // this shop has more expired points than this run has room for: it carries on next run
            b.done.push(bid)
          } catch (e) {
            const tries = (b.tries[bid] ?? 0) + 1
            b.tries[bid] = tries
            console.error(`[daily shop ${bid}] try ${tries}`, (e as Error).message)
            if (tries >= MAX_TRIES) {
              st.failed = [{ id: bid, on: today, error: String((e as Error).message).slice(0, 200) }, ...st.failed.filter((f) => f.id !== bid)].slice(0, 50)
              b.done.push(bid) // set aside for this round (the next round tries it again)
            }
          }
        }
        if (usage.size) await mergeUsageCopy(c, st.round.startedAt, usage)
        if (b.shops.every((id) => b.done.includes(id))) { st.round.after = b.shops[b.shops.length - 1]; st.batch = null }
      }
    }
  } finally {
    // Give the lease back (only if it is still ours) and save what was done.
    st.lease = null
    await saveDaily(c, st, lease.id).catch((e) => { console.error('[daily] save', e); return false })
  }
  // Nothing left for now: every shop done today and no reminder waiting for room (WhatsApp not set up = none to send).
  const idle = !!st.round.finishedOn && !remindersLeft
  return { busy: false, sent, shops, idle }
}

/**
 * Catalyst's daily cron (09:00 IST) and system.runDailyJobs: runs batch after batch until today's work is done
 * (Catalyst has no per-run CPU limit). Returns the reminders sent, as before.
 */
export async function runDailyJobs(c: Ctx) {
  let sent = 0
  for (let i = 0; i < 10_000; i++) {
    const r = await runDailyBatch(c, { remindersFromHour: 0 })
    sent += r.sent
    if (r.busy || r.idle) break
    if (!r.shops && !r.sent) {
      // Nothing moved (e.g. reminders not ready yet): stop instead of looping.
      const st = await readDaily(c)
      if (st.round.finishedOn || !st.batch) break
    }
  }
  return sent
}

define('system', {
  /** Called by the daily Catalyst Cron with the CRON_KEY secret (no user or admin session). */
  runDailyJobs: publicWrite(async (c, key?: string) => {
    const want = process.env.CRON_KEY
    if (!want || String(key ?? '') !== want) throw new ApiError('Not allowed', 403, 'FORBIDDEN')
    return runDailyJobs(c)
  }),
  /** One hourly run (an hourly scheduler, e.g. Cloudflare Cron): a batch of shops and reminders within the budgets. */
  runDailyBatch: publicWrite(async (c, key?: string) => {
    const want = process.env.CRON_KEY
    if (!want || String(key ?? '') !== want) throw new ApiError('Not allowed', 403, 'FORBIDDEN')
    return runDailyBatch(c)
  }),
})

define('admin', {
  // ---- renewal reminders ----
  renewals: adminRead('customers.view', async (c) => {
    const [cfg, w, price, bizRows] = await Promise.all([loadSettings(c), platformWa(c), loadPricing(c.platform), c.platform.select('businesses', { where: { deleted_at: null } })])
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
        ownerName: str(owner?.name), phone: str(owner?.phone), monthly: monthlyValue(customerPrice(price, r).price, b.maxBranches),
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
      platformWa(c), loadSettings(c), loadPricing(c.platform),
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
