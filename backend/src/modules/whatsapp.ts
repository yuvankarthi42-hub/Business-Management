// The shop's own WhatsApp Business (Meta Cloud API): setup steps, bill / offer templates, sending bills and
// offers, the message log — and offer campaigns. Tables: whatsapp_accounts, whatsapp_templates,
// whatsapp_messages, campaigns, secrets (the access token, never returned to the browser).
//
// Meta is SIMULATED in this phase, exactly like the app's demo: a submitted template is approved ~20 s later,
// delivered / read receipts follow from the message's age. Everything that leaves Kadai Kalanjiyam goes through
// sendWhatsApp() below, so the real Cloud API call is plugged in at one place.
import { randomBytes } from 'node:crypto'
import { renderTemplate, templateErrors, WA_KIND, type WaLang, type WaTemplateKind } from '@/core/whatsapp'
import type { WaMessageQuery } from '@/core/waReceipts'
import type { Campaign, WaMessage, WaTemplate, WhatsAppConfig } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row } from '../db/types'
import { selectIn } from '../domain/orders'
import { audit, bizDay, bizDayStart, E, fromMinor, isId, json, nameOf, own, str, strOrNull } from '../domain/util'
import { cleanPhone } from './business'

export const META_REVIEW_MS = 20_000 // simulated: Meta approves a valid template ~20 s after it is submitted
export const VALID_WA = /^\+\d{8,15}$/
export const formatNumberForLog = (e164: string) => e164.replace(/(\d{2})\d+(\d{3})$/, '$1•••$2')

// ---------- sending ----------
export interface WaOutgoing {
  /** The sender's Meta phone number id and access token (from secrets). */
  phoneNumberId: string
  token: string
  /** E.164 */
  to: string
  /** The approved template and its rendered text (the text is what we keep in whatsapp_messages.body). */
  template: { name: string; language: string } | null
  body: string
  attachment: string | null
}
export interface WaSent { status: 'sent' | 'failed'; messageId: string | null; error: string | null }

/**
 * The one place a WhatsApp message leaves Kadai Kalanjiyam (shop bills / offers / tests and the platform's renewal
 * reminders). The server will call Meta here: POST https://graph.facebook.com/<version>/<phoneNumberId>/messages
 * with the template name, language and parameters, authorised by the token, and keep the returned message id
 * (wamid) so the status webhook can update the row. In this phase the call is simulated like the app's demo:
 * a valid number is accepted and gets a simulated message id; receipts then follow from the message's age.
 */
export async function sendWhatsApp(m: WaOutgoing): Promise<WaSent> {
  if (!VALID_WA.test(m.to)) return { status: 'failed', messageId: null, error: 'Not a valid WhatsApp number' }
  return { status: 'sent', messageId: `sim.${randomBytes(12).toString('hex')}`, error: null }
}

/** Delivery receipts: Meta's webhook will update the row; until then they follow from the message's age. */
export function liveStatus(r: Row, now: Date): WaMessage['status'] {
  const st = nameOf(E.WaMessageStatus, r.status)
  if (st === 'failed') return 'failed'
  if (st === 'delivered' || st === 'read') return st
  if (!r.meta_message_id) return 'sent' // never went through the API (shared from the phone) — no receipts
  const age = now.getTime() - new Date(r.CREATEDTIME).getTime()
  return age > 30_000 ? 'read' : age > 4_000 ? 'delivered' : 'sent'
}
/** A "sent" row without a Meta message id was shared by hand (wa.me link, campaigns.markSent), not by the API. */
export const isManualShare = (r: Row) => Number(r.status) === E.WaMessageStatus.sent && !r.meta_message_id

// ---------- secrets (access tokens) ----------
type Owner = keyof typeof E.SecretOwner
const secretKey = (owner: Owner, businessId: string | null) => `${E.SecretOwner[owner]}:${businessId ?? 0}:${E.SecretKind.whatsapp_token}`
/** The platform's own token is in the platform database; a shop's in the shop's database. */
const secretsDb = (c: Ctx, owner: Owner) => (owner === 'platform' ? c.platform : c.db)
export const tokenRow = (c: Ctx, owner: Owner, businessId: string | null) => secretsDb(c, owner).first('secrets', { uniq_key: secretKey(owner, businessId) })
export async function saveToken(c: Ctx, owner: Owner, businessId: string | null, token: string): Promise<Row> {
  const db = secretsDb(c, owner)
  const patch = { value: token, last4: token.slice(-4) }
  const ex = await tokenRow(c, owner, businessId)
  if (ex) return db.update('secrets', ex.ROWID, patch)
  try {
    return await db.insert('secrets', { owner_type: E.SecretOwner[owner], business_id: businessId, kind: E.SecretKind.whatsapp_token, uniq_key: secretKey(owner, businessId), ...patch })
  } catch (e) {
    if (!(e instanceof DuplicateError)) throw e
    const again = await tokenRow(c, owner, businessId)
    if (!again) throw e
    return db.update('secrets', again.ROWID, patch)
  }
}
export async function dropToken(c: Ctx, owner: Owner, businessId: string | null) {
  const ex = await tokenRow(c, owner, businessId)
  if (ex) await secretsDb(c, owner).delete('secrets', ex.ROWID)
}

export function checkAccount(input: { businessNumber?: string; wabaId?: string; phoneNumberId?: string; token?: string }, iso: string, numberRequired: string) {
  const businessNumber = cleanPhone(input?.businessNumber, iso, numberRequired)
  const wabaId = String(input.wabaId ?? '').trim(), phoneNumberId = String(input.phoneNumberId ?? '').trim()
  if (!/^\d{10,20}$/.test(wabaId)) throw new ApiError('WhatsApp Business Account ID is a 10–20 digit number (Meta Business Suite → WhatsApp accounts)')
  if (!/^\d{10,20}$/.test(phoneNumberId)) throw new ApiError('Phone number ID is a 10–20 digit number (WhatsApp Manager → API setup)')
  const token = String(input.token ?? '').trim()
  if (token && (token.length < 30 || /\s/.test(token))) throw new ApiError('That doesn’t look like an access token — copy the whole token without spaces')
  return { businessNumber, wabaId, phoneNumberId, token }
}

/** pending → approved once Meta's (simulated) review time has passed. */
export function liveTemplateStatus(r: Row, now: Date): WaTemplate['status'] {
  const st = nameOf(E.WaTemplateStatus, r.status) as WaTemplate['status']
  const sub = strOrNull(r.submitted_at)
  return st === 'pending' && sub && now.getTime() - new Date(sub).getTime() > META_REVIEW_MS ? 'approved' : st
}

// ---------- the shop's account ----------
const QUALITY = { high: 'High', medium: 'Medium', low: 'Low' } as const
const tplKey = (businessId: string, kind: WaTemplateKind) => `${businessId}:${E.WaTemplateKind[kind]}`

interface Wa { acc: Row | null; templates: Row[]; token: Row | null }
async function loadWa(c: Ctx): Promise<Wa> {
  const [acc, templates, token] = await Promise.all([
    c.db.first('whatsapp_accounts', { business_id: c.businessId }),
    c.db.select('whatsapp_templates', { where: { business_id: c.businessId } }),
    tokenRow(c, 'business', c.businessId),
  ])
  return { acc, templates, token }
}
const enabledOf = (acc: Row | null) => !!acc && Number(acc.status) !== E.WaAccountStatus.disconnected

function templateFrom(r: Row, now: Date): WaTemplate {
  return {
    kind: nameOf(E.WaTemplateKind, r.kind) as WaTemplateKind, language: str(r.language) as WaLang, body: str(r.body), attach: !!r.attach,
    status: liveTemplateStatus(r, now), ...(r.reject_reason ? { reason: str(r.reject_reason) } : {}), submittedAt: strOrNull(r.submitted_at), updatedAt: r.MODIFIEDTIME,
  }
}
function configFrom(w: Wa, now: Date): WhatsAppConfig | null {
  const a = w.acc
  if (!enabledOf(a)) return null
  const templates: WhatsAppConfig['templates'] = {}
  for (const r of w.templates) { const t = templateFrom(r, now); if (t.kind === 'bill' || t.kind === 'offer') templates[t.kind] = t }
  return {
    enabled: true, provider: 'meta_cloud', businessNumber: str(a!.business_number), wabaId: str(a!.waba_id), phoneNumberId: str(a!.phone_number_id),
    tokenLast4: str(w.token?.last4),
    verified: a!.verified_at ? { name: str(a!.verified_name), number: str(a!.business_number), quality: QUALITY[a!.quality ? nameOf(E.WaQuality, a!.quality) : 'high'], at: str(a!.verified_at) } : null,
    templates, autoSendBill: !!a!.auto_send_bill, finishedAt: strOrNull(a!.setup_done_at), updatedAt: a!.MODIFIEDTIME,
  }
}
/** Where the setup is: 1 enable · 2 connect · 3 test · 4 templates · 5 connected. */
function waState(w: WhatsAppConfig | null) {
  const step = !w?.enabled ? 1 : !w.phoneNumberId ? 2 : !w.verified ? 3 : !w.finishedAt ? 4 : 5
  const live = !!w?.enabled && !!w.verified
  return {
    state: (!w?.enabled ? 'not_set_up' : step < 5 ? 'incomplete' : 'connected') as 'not_set_up' | 'incomplete' | 'connected',
    step,
    ready: { offer: live && w!.templates.offer?.status === 'approved', bill: live && w!.templates.bill?.status === 'approved' },
  }
}

/** Only when the product admin released WhatsApp to this business. */
function waBiz(c: Ctx) {
  if (!c.s.features.whatsapp) throw new ApiError('WhatsApp integration isn’t available for your account yet')
}
/** For sending: the account, ready for this kind of message (approved template on a tested connection). */
async function waReady(c: Ctx, kind: 'bill' | 'offer') {
  waBiz(c)
  const w = await loadWa(c)
  const cfg = configFrom(w, c.now)
  if (!cfg || !waState(cfg).ready[kind]) throw new ApiError(`WhatsApp ${kind} messages aren’t set up yet (Settings → Integrations)`)
  return { w, cfg, tpl: cfg.templates[kind]!, tplRow: w.templates.find((x) => Number(x.kind) === E.WaTemplateKind[kind])! }
}
async function waConfig(c: Ctx) {
  waBiz(c)
  const w = await loadWa(c)
  const cfg = configFrom(w, c.now)
  if (!cfg) throw new ApiError('Turn on WhatsApp first')
  return { w, cfg, acc: w.acc! }
}

/** Sends one message from the shop's number and records it in whatsapp_messages. */
async function logWa(c: Ctx, w: Wa, m: { kind: WaMessage['kind']; to: string; customerName: string; customerId: string | null; orderId?: string | null; campaignId?: string | null; templateId?: string | null; template?: { name: string; language: string } | null; body: string; attachment: string | null }): Promise<WaMessage> {
  const res = await sendWhatsApp({ phoneNumberId: str(w.acc?.phone_number_id), token: str(w.token?.value), to: m.to, template: m.template ?? null, body: m.body, attachment: m.attachment })
  const r = await c.db.insert('whatsapp_messages', {
    business_id: c.businessId, sender: E.WaSender.business, kind: E.WaMessageKind[m.kind], to_number: m.to.slice(0, 16), customer_id: m.customerId,
    order_id: m.orderId ?? null, campaign_id: m.campaignId ?? null, template_id: m.templateId ?? null, body: m.body, meta_message_id: res.messageId,
    status: E.WaMessageStatus[res.status], error: res.error, status_at: c.now.toISOString(), created_by: c.actorId,
  })
  return { id: r.ROWID, businessId: c.businessId, kind: m.kind, to: m.to, customerName: m.customerName, customerId: m.customerId, refId: m.orderId ?? m.campaignId ?? null, body: m.body, attachment: m.attachment, status: res.status, ...(res.error ? { error: res.error } : {}), createdAt: r.CREATEDTIME, createdBy: c.userId }
}

/** The message log rows → the app's WaMessage (names come from customers / bills / staff; attachment from the template). */
async function messagesFrom(c: Ctx, rows: Row[]): Promise<WaMessage[]> {
  const ids = (col: string) => rows.map((r) => str(r[col])).filter(Boolean)
  const [customers, orders, users, templates] = await Promise.all([
    selectIn(c, 'customers', 'ROWID', ids('customer_id'), { business_id: c.businessId }),
    selectIn(c, 'orders', 'ROWID', ids('order_id'), { business_id: c.businessId }),
    selectIn(c, 'users', 'ROWID', rows.filter((r) => Number(r.kind) === E.WaMessageKind.test).map((r) => str(r.created_by)).filter(Boolean), { business_id: c.businessId }),
    selectIn(c, 'whatsapp_templates', 'ROWID', ids('template_id'), {}, c.db),
  ])
  const by = (list: Row[]) => new Map(list.map((x) => [x.ROWID, x]))
  const cm = by(customers), om = by(orders), um = by(users), tm = by(templates)
  return rows.map((r) => {
    const kind = nameOf(E.WaMessageKind, r.kind) as WaMessage['kind']
    const o = om.get(str(r.order_id)), t = tm.get(str(r.template_id))
    const name = str(cm.get(str(r.customer_id))?.name) || str(o?.customer_name) || (kind === 'test' ? str(um.get(str(r.created_by))?.name) : '')
    const attachment = !t?.attach ? null : kind === 'bill' ? `${str(o?.invoice_number) || 'bill'}.pdf` : kind === 'offer' ? 'offer-poster.png' : null
    return {
      id: r.ROWID, businessId: str(r.business_id), kind, to: str(r.to_number), customerName: name, customerId: strOrNull(r.customer_id),
      refId: strOrNull(r.order_id) ?? strOrNull(r.campaign_id), body: str(r.body), attachment, status: liveStatus(r, c.now),
      ...(str(r.meta_message_id).startsWith('sim.') ? { simulated: true } : {}),
      ...(r.error ? { error: str(r.error) } : {}), createdAt: r.CREATEDTIME, createdBy: str(r.created_by),
    }
  })
}

const fmtDate = (c: Ctx, iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: c.business.timezone || 'Asia/Kolkata' })

define('whatsapp', {
  status: userRead(async (c) => {
    const on = !!c.s.features.whatsapp
    if (!on) return { feature: false, state: 'off' as const, step: 0, ready: { offer: false, bill: false }, config: null }
    const cfg = configFrom(await loadWa(c), c.now)
    return { feature: true, ...waState(cfg), config: cfg }
  }),

  enable: userWrite(async (c) => {
    waBiz(c)
    const acc = await c.db.first('whatsapp_accounts', { business_id: c.businessId })
    if (enabledOf(acc)) return
    // A fresh start (also after a disconnect): no numbers, not verified, no templates.
    const fresh = { provider: E.WaProvider.meta_cloud, business_number: '', waba_id: '', phone_number_id: '', secret_id: null, verified_name: null, quality: null, verified_at: null, auto_send_bill: false, setup_done_at: null, status: E.WaAccountStatus.setup }
    if (acc) await c.db.update('whatsapp_accounts', acc.ROWID, fresh)
    else {
      try { await c.db.insert('whatsapp_accounts', { business_id: c.businessId, ...fresh }) } catch (e) { if (!(e instanceof DuplicateError)) throw e }
    }
    await audit(c, 'whatsapp', c.businessId, 'enable')
  }, { perm: 'settings.manage' }),

  connect: userWrite(async (c, input: { businessNumber: string; wabaId: string; phoneNumberId: string; token?: string }) => {
    const { w, cfg, acc } = await waConfig(c)
    const { businessNumber, wabaId, phoneNumberId, token } = checkAccount(input ?? {}, c.business.defaultCountry || 'IN', 'Enter your WhatsApp Business number')
    if (!token && !w.token) throw new ApiError('Paste the permanent access token')
    const secret = token ? await saveToken(c, 'business', c.businessId, token) : w.token
    const changed = cfg.businessNumber !== businessNumber || cfg.wabaId !== wabaId || cfg.phoneNumberId !== phoneNumberId || !!token
    await c.db.update('whatsapp_accounts', acc.ROWID, {
      business_number: businessNumber, waba_id: wabaId, phone_number_id: phoneNumberId, secret_id: secret?.ROWID ?? null,
      ...(changed ? { verified_name: null, quality: null, verified_at: null, setup_done_at: null, status: E.WaAccountStatus.setup } : {}),
    })
    await audit(c, 'whatsapp', c.businessId, 'connect', formatNumberForLog(businessNumber))
  }, { perm: 'settings.manage' }),

  /** Simulated GET /{phone-number-id}: Meta returns the verified business name, number and quality. */
  test: userWrite(async (c) => {
    const { w, cfg, acc } = await waConfig(c)
    if (!cfg.phoneNumberId || !w.token) throw new ApiError('Connect your account first')
    const at = c.now.toISOString()
    await c.db.update('whatsapp_accounts', acc.ROWID, { verified_name: c.business.name.slice(0, 120), quality: E.WaQuality.high, verified_at: at })
    await audit(c, 'whatsapp', c.businessId, 'test', 'Connection OK')
    return { name: c.business.name, number: cfg.businessNumber, quality: 'High' as const, at }
  }, { perm: 'settings.manage' }),

  sendTest: userWrite(async (c) => {
    const { w, cfg } = await waConfig(c)
    if (!cfg.verified) throw new ApiError('Test the connection first')
    const to = c.s.user.phone
    if (!to) throw new ApiError('Add your mobile number to your profile first')
    return logWa(c, w, { kind: 'test', to, customerName: c.s.user.name, customerId: null, body: `Test message from ${c.business.name} on Kadai Kalanjiyam. Your WhatsApp integration works.`, attachment: null })
  }, { perm: 'settings.manage', tx: 'none' }),

  /** Save a template as a draft, or submit it to Meta for approval. */
  saveTemplate: userWrite(async (c, kind: WaTemplateKind, input: { language: WaLang; body: string; attach: boolean }, submit: boolean) => {
    const { cfg } = await waConfig(c)
    if (!cfg.verified) throw new ApiError('Connect and test your account first')
    if (kind !== 'bill' && kind !== 'offer') throw new ApiError('Unknown template')
    if (!['en', 'ta'].includes(input?.language)) throw new ApiError('Choose a language')
    const body = String(input.body ?? '').trim()
    if (submit) { const errs = templateErrors(kind, body); if (errs.length) throw new ApiError(`Fix the template first: ${errs.join(' · ')}`) }
    if (body.length > 10_000) throw new ApiError('The message is too long')
    const data = {
      language: input.language, body, attach: !!input.attach, meta_template_name: WA_KIND[kind].name, status: submit ? E.WaTemplateStatus.pending : E.WaTemplateStatus.draft,
      reject_reason: null, submitted_at: submit ? c.now.toISOString() : null, approved_at: null,
    }
    const key = tplKey(c.businessId, kind)
    const ex = await c.db.first('whatsapp_templates', { uniq_key: key })
    const row = ex ? await c.db.update('whatsapp_templates', ex.ROWID, data) : await c.db.insert('whatsapp_templates', { business_id: c.businessId, kind: E.WaTemplateKind[kind], uniq_key: key, ...data })
    await audit(c, 'whatsapp', c.businessId, submit ? 'template_submit' : 'template_save', WA_KIND[kind].name)
    return templateFrom(row, c.now)
  }, { perm: 'settings.manage' }),

  finishSetup: userWrite(async (c) => {
    const { cfg, acc } = await waConfig(c)
    if (!cfg.verified) throw new ApiError('Connect and test your account first')
    if (!Object.values(cfg.templates).some((t) => t && t.status !== 'draft')) throw new ApiError('Submit at least one template')
    await c.db.update('whatsapp_accounts', acc.ROWID, { setup_done_at: c.now.toISOString(), status: E.WaAccountStatus.connected })
  }, { perm: 'settings.manage' }),

  setAutoSendBill: userWrite(async (c, on: boolean) => {
    const { acc } = await waConfig(c)
    await c.db.update('whatsapp_accounts', acc.ROWID, { auto_send_bill: !!on })
  }, { perm: 'settings.manage' }),

  /** Removes the connection, the token and the templates. Sent messages stay in the log. */
  disconnect: userWrite(async (c) => {
    waBiz(c)
    const acc = await c.db.first('whatsapp_accounts', { business_id: c.businessId })
    if (acc) await c.db.update('whatsapp_accounts', acc.ROWID, { status: E.WaAccountStatus.disconnected, secret_id: null, verified_name: null, quality: null, verified_at: null, setup_done_at: null, auto_send_bill: false })
    await dropToken(c, 'business', c.businessId)
    const tpls = await c.db.select('whatsapp_templates', { where: { business_id: c.businessId } })
    if (tpls.length) await c.db.deleteMany('whatsapp_templates', tpls.map((t) => t.ROWID))
    await audit(c, 'whatsapp', c.businessId, 'disconnect')
  }, { perm: 'settings.manage' }),

  sendBill: userWrite(async (c, orderId: string) => {
    const { w, tpl: t, tplRow: tRow } = await waReady(c, 'bill')
    const o = isId(orderId) ? await c.db.first('orders', { ROWID: orderId, business_id: c.businessId }) : null
    if (!o || !o.invoice_number) throw new ApiError('Bill not found')
    const cust = o.customer_id ? await c.db.first('customers', { ROWID: str(o.customer_id), business_id: c.businessId }) : null
    const to = str(cust?.phone) || str(o.customer_phone)
    if (!to) throw new ApiError('This bill has no customer mobile number')
    const name = str(cust?.name) || str(o.customer_name)
    const values = {
      customer_name: (name || 'Customer').split(' ')[0], shop_name: c.business.name, bill_no: str(o.invoice_number),
      amount: `${c.business.currencySymbol}${fromMinor(o.total_minor).toFixed(2)}`, date: fmtDate(c, str(o.billed_at) || o.CREATEDTIME),
    }
    return logWa(c, w, {
      kind: 'bill', to, customerName: name, customerId: cust?.ROWID ?? null, orderId: o.ROWID, templateId: tRow.ROWID, template: { name: WA_KIND.bill.name, language: t.language },
      body: renderTemplate(t.body, values), attachment: t.attach ? `${str(o.invoice_number)}.pdf` : null,
    })
  }, { perm: 'billing.create', tx: 'none' }),

  /** Today's offer to many customers at once (only those who agreed to offers, have a mobile and weren't sent one today). */
  sendOffer: userWrite(async (c, input: { details: string; customerIds: string[]; productIds: string[]; poster: boolean }) => {
    const { w, tpl: t, tplRow: tRow } = await waReady(c, 'offer')
    const details = String(input?.details ?? '').replace(/\s*\n+\s*/g, ' · ').trim()
    if (details.length < 3) throw new ApiError('Write the offer details')
    if (details.length > 300) throw new ApiError('Offer details: up to 300 characters')
    const wanted = [...new Set((Array.isArray(input.customerIds) ? input.customerIds : []).map(String))]
    const [customers, todays] = await Promise.all([
      selectIn(c, 'customers', 'ROWID', wanted.filter(isId), { business_id: c.businessId }),
      c.db.select('whatsapp_messages', { where: { business_id: c.businessId, sender: E.WaSender.business, kind: E.WaMessageKind.offer, CREATEDTIME: { gte: bizDayStart(c) } } }),
    ])
    const already = new Set(todays.filter((m) => !isManualShare(m)).map((m) => str(m.customer_id)))
    const byId = new Map(customers.map((x) => [x.ROWID, x]))
    const send: Row[] = []
    let skipped = 0
    for (const id of wanted) {
      const cu = byId.get(id)
      if (!cu || cu.is_active === false || !cu.phone || cu.marketing_opt_in === false || already.has(id)) { skipped++; continue }
      send.push(cu)
    }
    if (!send.length) throw new ApiError('No one to send to — everyone selected was skipped (no mobile, didn’t agree to offers, or already sent today)')
    const productIds = (Array.isArray(input.productIds) ? input.productIds : []).map(String).filter(isId)
    const camp = await c.db.insert('campaigns', {
      business_id: c.businessId, channel: E.Channel.whatsapp, campaign_date: bizDay(c), message: details.slice(0, 1000), product_ids_json: JSON.stringify(productIds), sent_count: send.length, created_by: c.actorId,
    })
    for (const cu of send) {
      await logWa(c, w, {
        kind: 'offer', to: str(cu.phone), customerName: str(cu.name), customerId: cu.ROWID, campaignId: camp.ROWID, templateId: tRow.ROWID, template: { name: WA_KIND.offer.name, language: t.language },
        body: renderTemplate(t.body, { customer_name: str(cu.name).split(' ')[0], shop_name: c.business.name, offer_details: details }), attachment: t.attach && input.poster ? 'offer-poster.png' : null,
      })
    }
    await audit(c, 'whatsapp', camp.ROWID, 'whatsapp_send', `${send.length} sent · ${skipped} skipped`)
    return { sent: send.length, skipped }
  }, { perm: 'customers.manage', tx: 'none' }),

  /** Messages sent through the API, newest first, with live receipts. */
  /** Newest first. `q` = a number (how many) or { limit, kind, since, before } to read only what a screen needs. */
  messages: userRead(async (c, q: number | WaMessageQuery = 200) => {
    const o: WaMessageQuery = typeof q === 'object' && q ? q : { limit: Number(q) }
    const n = Math.min(Math.max(1, Math.floor(Number(o.limit) || 200)), 1000)
    const iso = (s?: string) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null)
    const since = iso(o.since), before = iso(o.before)
    const created = since && before ? { gte: since, lt: before } : since ? { gte: since } : before ? { lt: before } : null
    const where = { business_id: c.businessId, sender: E.WaSender.business, ...(o.kind && o.kind in E.WaMessageKind ? { kind: E.WaMessageKind[o.kind as keyof typeof E.WaMessageKind] } : {}), ...(created ? { CREATEDTIME: created } : {}) }
    const rows = await c.db.select('whatsapp_messages', { where, orderBy: [['CREATEDTIME', 'DESC'], ['ROWID', 'DESC']], limit: n })
    return messagesFrom(c, rows.filter((r) => !isManualShare(r)))
  }),
})

// ---------- offer campaigns ----------
// A campaign's sends are its whatsapp_messages rows (campaign_id): sent by the API (sendOffer) or shared by hand (markSent).
async function campaignsFrom(c: Ctx, rows: Row[]): Promise<Campaign[]> {
  const msgs = rows.length ? await selectIn(c, 'whatsapp_messages', 'campaign_id', rows.map((r) => r.ROWID), { business_id: c.businessId }, c.db) : []
  return rows.map((r) => ({
    id: r.ROWID, businessId: str(r.business_id), date: str(r.campaign_date), channel: 'whatsapp' as const, message: str(r.message), productIds: json<string[]>(r.product_ids_json, []),
    sends: msgs.filter((m) => m.campaign_id === r.ROWID && m.customer_id && Number(m.status) !== E.WaMessageStatus.failed)
      .sort((a, b) => a.CREATEDTIME.localeCompare(b.CREATEDTIME)).map((m) => ({ customerId: str(m.customer_id), at: m.CREATEDTIME, by: str(m.created_by) })),
    createdAt: r.CREATEDTIME, createdBy: str(r.created_by),
  }))
}
function checkCampaign(message: string, productIds: string[]) {
  const msg = String(message ?? '')
  if (msg.length > 1000) throw new ApiError('Message: up to 1,000 characters')
  return { message: msg, product_ids_json: JSON.stringify((Array.isArray(productIds) ? productIds : []).map(String).filter(isId)) }
}

define('campaigns', {
  today: userRead(async (c) => {
    const rows = await c.db.select('campaigns', { where: { business_id: c.businessId, campaign_date: bizDay(c) }, orderBy: [['CREATEDTIME', 'DESC']] })
    return campaignsFrom(c, rows)
  }),
  create: userWrite(async (c, input: { message: string; productIds: string[] }) => {
    const data = checkCampaign(input?.message, input?.productIds)
    const r = await c.db.insert('campaigns', { business_id: c.businessId, channel: E.Channel.whatsapp, campaign_date: bizDay(c), ...data, sent_count: 0, created_by: c.actorId })
    await audit(c, 'whatsapp', r.ROWID, 'create', `${json<string[]>(data.product_ids_json, []).length} items`)
    return (await campaignsFrom(c, [r]))[0]
  }, { perm: 'customers.manage' }),
  update: userWrite(async (c, id: string, message: string, productIds: string[]) => {
    const r = isId(id) ? await c.db.first('campaigns', { ROWID: id, business_id: c.businessId }) : null
    if (r) await c.db.update('campaigns', r.ROWID, checkCampaign(message, productIds))
  }),
  /** The offer was shared with this customer by hand (WhatsApp link from the phone). Once per customer. */
  markSent: userWrite(async (c, id: string, customerId: string) => {
    const camp = isId(id) ? await c.db.first('campaigns', { ROWID: id, business_id: c.businessId }) : null
    if (!camp) throw new ApiError('Campaign not found')
    const cu = await own(c, 'customers', customerId, 'Customer not found')
    if (await c.db.first('whatsapp_messages', { business_id: c.businessId, campaign_id: camp.ROWID, customer_id: cu.ROWID })) return
    await c.db.insert('whatsapp_messages', {
      business_id: c.businessId, sender: E.WaSender.business, kind: E.WaMessageKind.offer, to_number: str(cu.phone).slice(0, 16), customer_id: cu.ROWID, campaign_id: camp.ROWID,
      body: str(camp.message) || '-', status: E.WaMessageStatus.sent, status_at: c.now.toISOString(), created_by: c.actorId,
    })
    await c.db.update('campaigns', camp.ROWID, { sent_count: Number(camp.sent_count ?? 0) + 1 })
  }),
})

