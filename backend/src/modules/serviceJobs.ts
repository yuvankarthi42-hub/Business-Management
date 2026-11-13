// Service jobs (repairs, laundry, tailoring…): an item the shop takes in, the stages it goes through, and its bill at
// delivery. Staff only (no public page). Every answer is small: one page of a stage, one job, one count per stage.
// The bill is made at delivery by the same code as a counter bill (writeOrder + settle), so GST, stock, receipts and
// reports stay exactly as for any bill. An advance taken at drop-off is a payment of the customer, put on that bill.
import { CLOSED_STAGES, jobStagesFor, type JobCard, type JobInput, type JobStage, type ServiceJob } from '@/core/serviceJobs'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import type { Row, Where } from '../db/types'
import { clientUuid, loadOrder, settle, writeOrder, type OrderDraft, type PaymentInput, type WriteInfo } from '../domain/orders'
import { priceItems, selectIn } from '../domain/orders'
import { E, assertBranch, audit, code, fromMinor, money, nameOf, nextNumber, own, str, toMinor } from '../domain/util'
import { r2 } from '@/core/pricing'
import { normalizePhone } from '@/core/phone'
import type { OrderItem } from '@/core/types'

const PAGE = 50
/** Open stages page by offset: never more than 20 pages (1,000 jobs in one stage). */
const MAX_PAGES = 20
/** Extra rows read on a closed stage's next page, for jobs closed at the very same moment as the cursor. */
const TIE_SLACK = 5
const NUMBERS = { prefix: 'J-', start: 1001 }
const ADVANCE_METHODS = ['cash', 'upi', 'card', 'bank'] as const
const NOT_FOUND = 'Job not found'

const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v))
/** Text from the request: trimmed, cut to the column's size; '' = not given. */
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
const digits = (s: string) => s.replace(/\D/g, '')
const stageCode = (s: JobStage) => code(E.JobStage, s)
const stageOf = (r: Row) => nameOf(E.JobStage, r.stage) as JobStage

function cardFrom(r: Row): JobCard {
  return {
    id: r.ROWID, number: str(r.job_number), stage: stageOf(r), stageAt: str(r.stage_at), item: str(r.item), brandModel: str(r.brand_model),
    customerName: str(r.customer_name), customerPhone: str(r.customer_phone), problem: str(r.problem), promisedAt: strOrNull(r.promised_at),
    technicianId: strOrNull(r.technician_id), estimate: r.estimate_minor == null ? null : fromMinor(r.estimate_minor), advance: fromMinor(r.advance_minor),
    version: Number(r.row_version ?? 1),
  }
}
function jobFrom(r: Row, events: Row[], bill: Row | null): ServiceJob {
  return {
    ...cardFrom(r), branchId: str(r.branch_id), customerId: strOrNull(r.customer_id), orderId: strOrNull(r.order_id), serial: str(r.serial),
    colour: str(r.colour), accessories: str(r.accessories), conditionNote: str(r.condition_note), closeReason: str(r.close_reason),
    deliveredAt: strOrNull(r.delivered_at), createdAt: r.CREATEDTIME, createdBy: str(r.created_by),
    events: events.map((e) => ({ from: e.from_stage == null ? null : (nameOf(E.JobStage, e.from_stage) as JobStage), to: nameOf(E.JobStage, e.to_stage) as JobStage, note: str(e.note), at: e.CREATEDTIME, by: str(e.created_by) })),
    invoiceNumber: bill ? strOrNull(bill.invoice_number) : null, total: bill ? fromMinor(bill.total_minor) : null,
  }
}

/** A job of this shop, in a branch this user may see. */
async function ownJob(c: Ctx, id: string) {
  const r = await own(c, 'service_jobs', id, NOT_FOUND)
  assertBranch(c, r.branch_id, NOT_FOUND)
  return r
}
/** The job with its history (and its bill once delivered), read together. */
async function fullJob(c: Ctx, r: Row): Promise<ServiceJob> {
  const [events, bill] = await Promise.all([
    c.db.select('service_job_events', { where: { business_id: c.businessId, job_id: r.ROWID }, orderBy: [['CREATEDTIME', 'ASC'], ['ROWID', 'ASC']], limit: 200 }),
    r.order_id ? c.db.first('orders', { ROWID: str(r.order_id), business_id: c.businessId }) : Promise.resolve(null),
  ])
  return jobFrom(r, events, bill)
}
const event = (c: Ctx, jobId: string, from: JobStage | null, to: JobStage, note = '') =>
  c.db.insert('service_job_events', { business_id: c.businessId, job_id: jobId, from_stage: from ? stageCode(from) : null, to_stage: stageCode(to), note: text(note, 255) || null, created_by: c.actorId })

function assertOpen(r: Row) {
  if (CLOSED_STAGES.includes(stageOf(r))) throw new ApiError(stageOf(r) === 'delivered' ? 'This job is already delivered' : 'This job is closed')
}
/** The fields a job's form sends (create and edit): checked and cut to size. */
function detailColumns(c: Ctx, input: Partial<JobInput>, isNew: boolean) {
  const out: Record<string, string | number | null> = {}
  const set = (key: keyof JobInput, col: string, max: number, required?: string) => {
    if (input[key] === undefined && !isNew) return
    const v = text(input[key], max)
    if (!v && required) throw new ApiError(required)
    out[col] = v || null
  }
  set('item', 'item', 80, 'Enter the item (e.g. Mobile)')
  set('brandModel', 'brand_model', 120)
  set('colour', 'colour', 30)
  set('problem', 'problem', 500, 'Describe the problem')
  set('accessories', 'accessories', 255)
  set('conditionNote', 'condition_note', 255)
  if (input.serial !== undefined || isNew) {
    const serial = text(input.serial, 40)
    out.serial = serial || null
    out.serial_key = serial ? `${c.businessId}:${serial.toLowerCase().replace(/[^a-z0-9]/g, '')}` : null
  }
  if (input.estimate !== undefined || isNew) out.estimate_minor = input.estimate == null || input.estimate === ('' as never) ? null : toMinor(r2(money(input.estimate, 'Estimate')))
  if (input.promisedAt !== undefined || isNew) {
    const p = input.promisedAt ? new Date(String(input.promisedAt)) : null
    if (p && Number.isNaN(p.getTime())) throw new ApiError('Choose the ready-by date')
    out.promised_at = p ? p.toISOString() : null
  }
  if (input.technicianId !== undefined || isNew) out.technician_id = input.technicianId && /^\d+$/.test(String(input.technicianId)) ? String(input.technicianId) : null
  return out
}

define('serviceJobs', {
  /** Jobs per stage (the board's column headers) — open jobs, and today's delivered ones. One grouped read. */
  counts: userRead(async (c) => {
    const scope = c.scope()
    const dayStart = new Date(c.now); dayStart.setUTCHours(0, 0, 0, 0)
    const working = jobStagesFor(c.business).filter((s) => s !== 'delivered')
    const where = { business_id: c.businessId, branch_id: { in: scope } }
    const [open, late, today] = await Promise.all([
      c.db.aggregate('service_jobs', { where: { ...where, stage: { in: working.map(stageCode) } }, groupBy: ['stage'], fns: { n: ['COUNT', 'ROWID'] } }),
      // Past the ready-by time and not ready yet (same index: stage, then promised_at).
      c.db.aggregate('service_jobs', { where: { ...where, stage: { in: working.filter((s) => s !== 'ready').map(stageCode) }, promised_at: { lt: c.now.toISOString() } }, groupBy: ['stage'], fns: { n: ['COUNT', 'ROWID'] } }),
      c.db.aggregate('service_jobs', { where: { ...where, stage: stageCode('delivered'), stage_at: { gte: dayStart.toISOString() } }, fns: { n: ['COUNT', 'ROWID'] } }),
    ])
    const counts: Partial<Record<JobStage, number>> = {}
    for (const r of open) counts[nameOf(E.JobStage, r.stage) as JobStage] = Number(r.n ?? 0)
    counts.delivered = Number(today[0]?.n ?? 0)
    const overdue: Partial<Record<JobStage, number>> = {}
    for (const r of late) overdue[nameOf(E.JobStage, r.stage) as JobStage] = Number(r.n ?? 0)
    return { stages: jobStagesFor(c.business), counts, overdue }
  }, { perm: 'jobs.manage' }),

  /**
   * One stage's jobs, 50 at a time, read through an index. Open stages: soonest promised first, `page` = 0, 1, 2…
   * (at most 20 pages). Delivered / cancelled / returned: newest first, `page` = the `next` cursor from the last answer.
   */
  board: userRead(async (c, stage: JobStage, page?: number | string | null) => {
    if (!jobStagesFor(c.business).includes(stage) && !CLOSED_STAGES.includes(stage)) throw new ApiError('Unknown stage')
    const where: Where = { business_id: c.businessId, branch_id: { in: c.scope() }, stage: stageCode(stage) }
    if (!CLOSED_STAGES.includes(stage)) {
      const p = Math.min(MAX_PAGES - 1, Math.max(0, Math.floor(Number(page) || 0)))
      const rows = await c.db.select('service_jobs', { where, orderBy: [['promised_at', 'ASC'], ['ROWID', 'ASC']], limit: PAGE + 1, offset: p * PAGE })
      return { rows: rows.slice(0, PAGE).map(cardFrom), next: rows.length > PAGE && p + 1 < MAX_PAGES ? p + 1 : null }
    }
    // Closed: after the cursor "<stage_at>|<id>" (rows at the same moment with a higher id were on the last page).
    const [at, id] = typeof page === 'string' && page.includes('|') ? page.split('|') : [null, null]
    const rows = await c.db.select('service_jobs', { where: at ? { ...where, stage_at: { lte: at } } : where, orderBy: [['stage_at', 'DESC'], ['ROWID', 'DESC']], limit: PAGE + 1 + TIE_SLACK })
    const after = at ? rows.filter((r) => !(str(r.stage_at) === at && BigInt(r.ROWID) >= BigInt(id || '0'))) : rows
    const out = after.slice(0, PAGE)
    const last = out[out.length - 1]
    return { rows: out.map(cardFrom), next: after.length > PAGE && last ? `${str(last.stage_at)}|${last.ROWID}` : null }
  }, { perm: 'jobs.manage' }),

  /** One job with its history and (after delivery) its bill. */
  get: userRead(async (c, id: string) => fullJob(c, await ownJob(c, id)), { perm: 'jobs.manage' }),

  /**
   * By job number, phone or serial / IMEI (top 20), every read through an index: the job number, the full phone
   * number or the full serial find any job; part of a phone (4+ digits) or serial looks among the open jobs only.
   */
  search: userRead(async (c, q: string) => {
    const t = text(q, 60)
    if (!t) return []
    const scope = c.scope()
    const base = { business_id: c.businessId, branch_id: { in: scope } }
    const open = { ...base, stage: { in: jobStagesFor(c.business).filter((x) => x !== 'delivered').map(stageCode) } }
    const d = digits(t), key = t.toLowerCase().replace(/[^a-z0-9]/g, '')
    const reads: Promise<Row[]>[] = [c.db.select('service_jobs', { where: { number_key: `${c.businessId}:${t.toUpperCase()}` }, limit: 1 })]
    if (d.length >= 10) {
      let full = ''
      try { full = digits(normalizePhone(t, c.business.defaultCountry || 'IN') ?? '') } catch { /* not a phone number */ }
      if (full) reads.push(c.db.select('service_jobs', { where: { business_id: c.businessId, phone_key: full }, orderBy: [['ROWID', 'DESC']], limit: 20 }))
    }
    if (key.length >= 4) reads.push(c.db.select('service_jobs', { where: { business_id: c.businessId, serial_key: `${c.businessId}:${key}` }, orderBy: [['ROWID', 'DESC']], limit: 20 }))
    if (d.length >= 4) reads.push(c.db.select('service_jobs', { where: { ...open, phone_key: { contains: d } }, orderBy: [['ROWID', 'DESC']], limit: 20 }))
    if (key.length >= 4) reads.push(c.db.select('service_jobs', { where: { ...open, serial_key: { contains: key } }, orderBy: [['ROWID', 'DESC']], limit: 20 }))
    const seen = new Map<string, Row>()
    for (const r of (await Promise.all(reads)).flat()) if (scope.includes(str(r.branch_id))) seen.set(r.ROWID, r)
    return [...seen.values()].slice(0, 20).map(cardFrom)
  }, { perm: 'jobs.manage' }),

  /** Take an item in: the job (and the advance as the customer's payment), in one transaction. */
  create: userWrite(async (c, input: JobInput) => {
    const uuid = clientUuid(c, ':job')
    const again = await c.db.first('service_jobs', { client_uuid: uuid })
    if (again) return fullJob(c, again) // the same request sent twice
    const cust = await own(c, 'customers', input.customerId, 'Choose the customer')
    const cols = detailColumns(c, input, true)
    const adv = input.advance && Number(input.advance.amount) > 0 ? input.advance : null
    if (adv) {
      money(adv.amount, 'Advance', { positive: true })
      if (!ADVANCE_METHODS.includes(adv.method as never)) throw new ApiError('Choose how the advance was paid')
      if (cols.estimate_minor != null && (toMinor(r2(Number(adv.amount))) ?? 0) > Number(cols.estimate_minor ?? 0)) throw new ApiError('The advance is more than the estimate')
    }
    const branchId = c.writeBranch({})
    const num = (await nextNumber(c.db, c.businessId, null, 'job', NUMBERS))!
    const at = c.now.toISOString()
    const pay = adv ? await c.db.insert('payments', {
      business_id: c.businessId, branch_id: branchId, order_id: null, customer_id: cust.ROWID, return_id: null, client_uuid: clientUuid(c, ':adv'),
      kind: E.PaymentKind.sale, method: code(E.PayMethod, adv.method), amount_minor: toMinor(r2(Number(adv.amount))), reference: text(adv.reference, 80) || `Advance ${num.text}`, is_voided: false, created_by: c.actorId,
    }) : null
    const phone = str(cust.phone)
    const row = await c.db.insert('service_jobs', {
      business_id: c.businessId, branch_id: branchId, customer_id: cust.ROWID, order_id: null, advance_payment_id: pay?.ROWID ?? null, client_uuid: uuid,
      job_number: num.text, number_key: `${c.businessId}:${num.text.toUpperCase()}`, stage: stageCode('received'), stage_at: at, ...cols,
      advance_minor: pay ? Number(pay.amount_minor) : 0, customer_name: str(cust.name).slice(0, 120), customer_phone: phone || null, phone_key: digits(phone) || null,
      created_by: c.actorId, updated_by: c.actorId,
    })
    const ev = await event(c, row.ROWID, null, 'received')
    await audit(c, 'job', row.ROWID, 'create', num.text, branchId)
    return jobFrom(row, [ev], null)
  }, { perm: 'jobs.manage' }),

  /** Edit a job's details (not its stage). `version`: the one the screen showed — a newer change wins nothing silently. */
  update: userWrite(async (c, id: string, patch: Partial<JobInput>, version: number) => {
    const r = await ownJob(c, id)
    assertOpen(r)
    const cols = detailColumns(c, patch ?? {}, false)
    if (!(await c.db.updateIfVersion('service_jobs', r.ROWID, Number(version ?? r.row_version), { ...cols, updated_by: c.actorId }))) throw new ApiError('This job was just changed on another device. Refresh and try again.', 409, 'CONFLICT')
    await audit(c, 'job', r.ROWID, 'update', str(r.job_number), str(r.branch_id))
    return fullJob(c, (await c.db.get('service_jobs', r.ROWID))!)
  }, { perm: 'jobs.manage' }),

  /** Move a job to another stage of its shop's list (any direction). Delivered / cancelled come from deliver / close. */
  setStage: userWrite(async (c, id: string, stage: JobStage, note?: string, version?: number) => {
    if (!jobStagesFor(c.business).includes(stage) || stage === 'delivered') throw new ApiError('Choose a stage')
    const r = await ownJob(c, id)
    assertOpen(r)
    const from = stageOf(r)
    if (from === stage) return cardFrom(r)
    const at = c.now.toISOString()
    if (!(await c.db.updateIfVersion('service_jobs', r.ROWID, Number(version ?? r.row_version), { stage: stageCode(stage), stage_at: at, updated_by: c.actorId }))) throw new ApiError('This job was just changed on another device. Refresh and try again.', 409, 'CONFLICT')
    await event(c, r.ROWID, from, stage, note)
    return cardFrom({ ...r, stage: stageCode(stage), stage_at: at, row_version: Number(version ?? r.row_version) + 1 })
  }, { perm: 'jobs.manage' }),

  /** Cancelled, or returned without the work done; the advance can be given back (a refund of that payment). */
  close: userWrite(async (c, id: string, how: 'cancelled' | 'returned', reason: string, refund?: { method: string } | null) => {
    if (how !== 'cancelled' && how !== 'returned') throw new ApiError('Choose cancelled or returned')
    const r = await ownJob(c, id)
    assertOpen(r)
    const advance = Number(r.advance_minor ?? 0)
    if (refund && advance > 0) {
      if (!ADVANCE_METHODS.includes(refund.method as never)) throw new ApiError('Choose how the advance is given back')
      await c.db.insert('payments', {
        business_id: c.businessId, branch_id: str(r.branch_id), order_id: null, customer_id: strOrNull(r.customer_id), return_id: null, client_uuid: clientUuid(c, ':refund'),
        kind: E.PaymentKind.refund, method: code(E.PayMethod, refund.method), amount_minor: advance, reference: `Advance back ${str(r.job_number)}`.slice(0, 80), is_voided: false, created_by: c.actorId,
      })
    }
    const at = c.now.toISOString()
    if (!(await c.db.updateIfVersion('service_jobs', r.ROWID, Number(r.row_version), { stage: stageCode(how), stage_at: at, close_reason: text(reason, 255) || null, ...(refund && advance > 0 ? { advance_minor: 0 } : {}), updated_by: c.actorId }))) throw new ApiError('This job was just changed on another device. Refresh and try again.', 409, 'CONFLICT')
    await event(c, r.ROWID, stageOf(r), how, reason)
    await audit(c, 'job', r.ROWID, 'cancel', `${str(r.job_number)} ${how}`, str(r.branch_id))
    return fullJob(c, (await c.db.get('service_jobs', r.ROWID))!)
  }, { perm: 'jobs.manage' }),

  /**
   * Hand it back: its bill (parts and labour) is made and paid exactly like a counter bill; the advance is part of it.
   * `pays` = what is collected now (the balance).
   */
  deliver: userWrite(async (c, id: string, bill: { items: OrderItem[]; discount?: number; notes?: string }, pays: PaymentInput[]) => {
    if (!Array.isArray(bill?.items) || !bill.items.length) throw new ApiError('Add the parts or labour for this job')
    const r = await ownJob(c, id)
    if (stageOf(r) === 'delivered' && r.order_id) return { job: await fullJob(c, r), order: (await loadOrder(c, str(r.order_id))).order } // sent twice
    assertOpen(r)
    if (!r.customer_id) throw new ApiError('This job has no customer')
    // The same reads as a counter bill, before the shop's write lock.
    c.memoCatalog()
    await priceItems(c, bill.items, new Map(), c.businessId, undefined, true)
    await selectIn(c, 'products', 'ROWID', bill.items.map((i) => String(i.productId)), { business_id: c.businessId })
    const advance = Number(r.advance_minor ?? 0)
    const done = await c.tx(async () => {
      const draft: OrderDraft = { type: 'counter', tableId: null, customerId: str(r.customer_id), items: bill.items, discount: Number(bill.discount ?? 0), notes: text(bill.notes ?? `Job ${str(r.job_number)}`, 255), source: 'pos' }
      const info: WriteInfo = {}
      const orderId = await writeOrder(c, draft, { info })
      if (info.existing) return { orderId, order: null } // the same request sent twice: its bill is already made
      if (advance > 0 && r.advance_payment_id) {
        const { order } = await loadOrder(c, orderId, { inScope: false })
        if (advance > (toMinor(order!.total) ?? 0)) throw new ApiError(`The bill (${order!.total}) is less than the advance (${fromMinor(advance)}). Give back the difference first.`)
        // The advance becomes this bill's payment (it was taken on the drop-off day and is counted there).
        await c.db.update('payments', str(r.advance_payment_id), { order_id: orderId })
        await c.db.update('orders', orderId, { paid_minor: advance })
      }
      const order = await settle(c, orderId, pays)
      const at = c.now.toISOString()
      if (!(await c.db.updateIfVersion('service_jobs', r.ROWID, Number(r.row_version), { stage: stageCode('delivered'), stage_at: at, delivered_at: at, order_id: orderId, updated_by: c.actorId }))) throw new ApiError('This job was just changed on another device. Refresh and try again.', 409, 'CONFLICT')
      await event(c, r.ROWID, stageOf(r), 'delivered')
      return { orderId, order }
    })
    return { job: await fullJob(c, (await c.db.get('service_jobs', r.ROWID))!), order: done.order ?? (await loadOrder(c, done.orderId)).order }
  }, { perm: 'jobs.manage', tx: 'manual' }),
})
