// Help & support tickets: the customer side (support.*) and the product admin's inbox (admin.tickets …).
// Tables: support_tickets, ticket_messages, ticket_attachments → media_files (screenshots in Stratus).
import { randomBytes } from 'node:crypto'
import type { Ticket, TicketCategory, TicketMessage, TicketPriority, TicketStatus } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { adminRead, adminWrite, define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type Row } from '../db/types'
import { selectIn } from '../domain/orders'
import { code, E, isId, nameOf, str, strOrNull } from '../domain/util'
import { businessLite } from './admin/shared'
import { storeImage } from './catalog'

const MAX_IMAGES = 5
const SCREENSHOT_MAX = 204_800 // 1600 px / 200 KB, compressed in the browser
const PLATFORM_PREFIX = 'platform/tickets/'

// ---------- screenshots ----------
type ImageInput = { image: string; width?: number; height?: number; originalBytes?: number }

/** Admin screenshots belong to no business (media_files.business_id NULL). Same checks as storeImage(). */
async function storeAdminScreenshot(c: Ctx, input: ImageInput) {
  const m = /^data:(image\/(webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(input?.image ?? ''))
  if (!m) throw new ApiError('That file is not a supported image')
  const buf = Buffer.from(m[3], 'base64')
  const ok = (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') || (buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50)
  if (!ok) throw new ApiError('That file is not a supported image')
  if (buf.length > SCREENSHOT_MAX) throw new ApiError(`Image is too large after compression (${Math.round(buf.length / 1024)} KB, the limit is ${Math.round(SCREENSHOT_MAX / 1024)} KB)`)
  const key = `${PLATFORM_PREFIX}${randomBytes(9).toString('hex')}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`
  const url = await c.files.put(key, buf, m[1])
  await c.platform.insert('media_files', {
    business_id: null, purpose: E.MediaPurpose.ticket, bucket: process.env.STRATUS_BUCKET || 'local', object_key: key, content_type: m[1], bytes: buf.length,
    width: input.width ? Math.round(input.width) : null, height: input.height ? Math.round(input.height) : null, original_bytes: input.originalBytes ? Math.round(input.originalBytes) : null, created_by: null,
  })
  return { url, bytes: buf.length }
}

/** Screenshot URLs sent back with a message → media rows. Only files uploaded by the same side are accepted. */
async function mediaFor(c: Ctx, urls: unknown, side: 'customer' | 'admin'): Promise<string[]> {
  const list = Array.isArray(urls) ? urls.map(String) : []
  if (list.length > MAX_IMAGES) throw new ApiError('Up to 5 screenshots')
  const out: string[] = []
  for (const url of list) {
    const key = c.files.keyOf(url)
    const prefix = side === 'customer' ? `${c.businessId}/tickets/` : PLATFORM_PREFIX
    if (!key || !key.startsWith(prefix)) throw new ApiError('Upload the screenshot again')
    // Screenshots are kept with the tickets, in the platform database.
    const r = await c.platform.first('media_files', { object_key: key, business_id: side === 'customer' ? c.businessId : null, purpose: E.MediaPurpose.ticket })
    if (!r) throw new ApiError('Upload the screenshot again')
    out.push(r.ROWID)
  }
  return out
}

// ---------- tickets ⇄ tables ----------
/** Tickets with their conversation. `firstImageOnly` keeps the admin list light (+ imageCount). */
async function ticketsFrom(c: Ctx, rows: Row[]): Promise<(Ticket & { imageCount: number })[]> {
  if (!rows.length) return []
  const [msgs, businesses] = await Promise.all([
    selectIn(c, 'ticket_messages', 'ticket_id', rows.map((r) => r.ROWID)),
    selectIn(c, 'businesses', 'ROWID', rows.map((r) => str(r.business_id))),
  ])
  const atts = msgs.length ? await selectIn(c, 'ticket_attachments', 'message_id', msgs.map((m) => m.ROWID)) : []
  const media = atts.length ? await selectIn(c, 'media_files', 'ROWID', atts.map((a) => str(a.media_id)), {}, c.platform) : []
  const urlOf = new Map(media.map((m) => [m.ROWID, c.files.url(str(m.object_key))]))
  const imagesOf = (msgId: string) => atts.filter((a) => a.message_id === msgId).sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map((a) => urlOf.get(str(a.media_id))).filter((u): u is string => !!u)
  const bm = new Map(businesses.map((b) => [b.ROWID, b]))
  return rows.map((r) => {
    const messages: TicketMessage[] = msgs.filter((m) => m.ticket_id === r.ROWID).sort((a, b) => a.CREATEDTIME.localeCompare(b.CREATEDTIME) || a.ROWID.localeCompare(b.ROWID)).map((m) => ({
      id: m.ROWID, from: nameOf(E.TicketSide, m.from_side) as TicketMessage['from'], authorId: str(m.admin_id) || str(m.user_id), authorName: str(m.author_name),
      text: str(m.body), images: imagesOf(m.ROWID), at: m.CREATEDTIME,
    }))
    return {
      id: r.ROWID, number: str(r.number), businessId: str(r.business_id), businessName: str(bm.get(str(r.business_id))?.name), userId: str(r.user_id),
      userName: str(r.user_name), userPhone: str(r.user_phone), subject: str(r.subject), category: nameOf(E.TicketCategory, r.category) as TicketCategory,
      priority: nameOf(E.TicketPriority, r.priority) as TicketPriority, status: nameOf(E.TicketStatus, r.status) as TicketStatus, assignedTo: strOrNull(r.assigned_to),
      context: { page: str(r.page), browser: str(r.browser), version: str(r.app_version) }, messages,
      // updatedAt = last activity (a message, a status change); reading a ticket doesn't move it up the list.
      createdAt: r.CREATEDTIME, updatedAt: str(r.last_message_at) || r.MODIFIEDTIME,
      unreadForAdmin: !!r.unread_for_admin, unreadForCustomer: !!r.unread_for_customer,
      imageCount: messages.reduce((a, m) => a + m.images.length, 0),
    }
  })
}
const withoutCount = ({ imageCount: _n, ...t }: Ticket & { imageCount: number }): Ticket => t

async function addMessage(c: Ctx, ticketId: string, m: { side: 'customer' | 'admin'; userId?: string | null; adminId?: string | null; authorName: string; text: string; media: string[] }) {
  const msg = await c.platform.insert('ticket_messages', {
    ticket_id: ticketId, from_side: E.TicketSide[m.side], user_id: m.userId ?? null, admin_id: m.adminId ?? null, author_name: m.authorName.slice(0, 120) || '-', body: m.text.slice(0, 4000),
  })
  if (m.media.length) await c.platform.insertMany('ticket_attachments', m.media.map((media_id, i) => ({ message_id: msg.ROWID, media_id, sort_order: i })))
}

/**
 * Ticket numbers are platform-wide (T-1001, T-1002 …), so the per-business sequences table can't hold them.
 * The next number is one more than the newest ticket's; the UNIQUE number column makes two tickets created at
 * the same moment impossible — the loser gets a DuplicateError and simply takes the next number.
 */
async function insertTicket(c: Ctx, data: Record<string, string | number | boolean | null>) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const last = await c.platform.first('support_tickets', {}, [['ROWID', 'DESC']])
    const n = Math.max(1000, Number(/^T-(\d+)$/.exec(str(last?.number))?.[1] ?? 1000)) + 1 + attempt
    try { return await c.platform.insert('support_tickets', { ...data, number: `T-${n}` }) } catch (e) { if (!(e instanceof DuplicateError)) throw e }
  }
  throw new ApiError('Busy — please try again', 409, 'CONFLICT')
}

const mineTicket = async (c: Ctx, id: string) => {
  const t = isId(id) ? await c.platform.first('support_tickets', { ROWID: id, business_id: c.businessId }) : null
  if (!t) throw new ApiError('Ticket not found', 404, 'NOT_FOUND')
  return t
}
const anyTicket = async (c: Ctx, id: string) => {
  const t = isId(id) ? await c.platform.get('support_tickets', id) : null
  if (!t) throw new ApiError('Ticket not found', 404, 'NOT_FOUND')
  return t
}
const isStatus = (s: unknown): s is TicketStatus => typeof s === 'string' && s in E.TicketStatus
const isPriority = (s: unknown): s is TicketPriority => typeof s === 'string' && s in E.TicketPriority

// ---------- customer side ----------
// Tickets can be raised and answered while the subscription has expired (readOnlyOk); never in support view.
define('support', {
  /** Screenshot already compressed in the browser (≤ 1600 px / 200 KB). The server checks the size again. */
  storeScreenshot: userWrite(async (c, input: ImageInput) => {
    const r = await storeImage(c, 'ticket', { image: input?.image, width: input?.width, height: input?.height, originalBytes: input?.originalBytes })
    return { url: r.url, bytes: r.bytes }
  }, { readOnlyOk: true, tx: 'none', quiet: true }),

  mine: userRead(async (c) => {
    const rows = await c.platform.select('support_tickets', { where: { business_id: c.businessId }, orderBy: [['last_message_at', 'DESC']], limit: 300 })
    return (await ticketsFrom(c, rows)).map(withoutCount)
  }),

  create: userWrite(async (c, input: { subject: string; category: TicketCategory; priority?: TicketPriority; message: string; images?: string[]; page?: string; browser?: string; version?: string }) => {
    const subject = String(input?.subject ?? '').trim(), text = String(input?.message ?? '').trim()
    if (subject.length < 4) throw new ApiError('Write a short title for the problem')
    if (text.length < 5) throw new ApiError('Tell us what happened')
    const category = code(E.TicketCategory, input.category)
    const priority = code(E.TicketPriority, input.priority ?? 'normal')
    const media = await mediaFor(c, input.images ?? [], 'customer')
    const now = c.now.toISOString()
    const t = await insertTicket(c, {
      business_id: c.businessId, user_id: c.userId, user_name: c.s.user.name.slice(0, 120), user_phone: c.s.user.phone || null, subject: subject.slice(0, 120), category, priority, status: E.TicketStatus.open, assigned_to: null,
      page: String(input.page ?? '').slice(0, 200), browser: String(input.browser ?? '').slice(0, 60), app_version: String(input.version ?? '').slice(0, 20) || null,
      unread_for_admin: true, unread_for_customer: false, last_message_at: now,
    })
    await addMessage(c, t.ROWID, { side: 'customer', userId: c.userId, authorName: c.s.user.name, text, media })
    return withoutCount((await ticketsFrom(c, [t]))[0])
  }, { readOnlyOk: true }),

  reply: userWrite(async (c, id: string, text: string, images: string[] = []) => {
    const t = await mineTicket(c, id)
    const body = String(text ?? '').trim()
    if (!body && !(Array.isArray(images) && images.length)) throw new ApiError('Write a message')
    const media = await mediaFor(c, images, 'customer')
    await addMessage(c, t.ROWID, { side: 'customer', userId: c.userId, authorName: c.s.user.name, text: body, media })
    const st = nameOf(E.TicketStatus, t.status)
    await c.platform.update('support_tickets', t.ROWID, {
      ...(st === 'resolved' || st === 'closed' || st === 'waiting' ? { status: E.TicketStatus.open, resolved_at: null } : {}),
      last_message_at: c.now.toISOString(), unread_for_admin: true,
    })
  }, { readOnlyOk: true }),

  /** Opening a ticket clears its "new reply" dot. Writes only when it changes (and never in support view). */
  markRead: userRead(async (c, id: string) => {
    const t = isId(id) ? await c.platform.first('support_tickets', { ROWID: id, business_id: c.businessId }) : null
    if (!t || !t.unread_for_customer || c.s.support) return
    await c.platform.update('support_tickets', t.ROWID, { unread_for_customer: false })
  }),

  resolve: userWrite(async (c, id: string) => {
    const t = isId(id) ? await c.platform.first('support_tickets', { ROWID: id, business_id: c.businessId }) : null
    if (!t) return
    await c.platform.update('support_tickets', t.ROWID, { status: E.TicketStatus.resolved, resolved_at: c.now.toISOString(), last_message_at: c.now.toISOString(), unread_for_admin: true })
  }, { readOnlyOk: true }),
})

// ---------- product admin ----------
define('admin', {
  /** Every ticket, newest activity first. Each message keeps only its first screenshot (imageCount has the total). */
  tickets: adminRead('customers.view', async (c) => {
    const rows = await c.platform.select('support_tickets', { orderBy: [['last_message_at', 'DESC']], limit: 500 })
    return (await ticketsFrom(c, rows)).map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, images: m.images.length ? [m.images[0]] : [] })) }))
  }),

  ticket: adminRead('customers.view', async (c, id: string) => {
    const r = await anyTicket(c, id)
    // Only write when it changes.
    if (r.unread_for_admin) await c.platform.update('support_tickets', r.ROWID, { unread_for_admin: false })
    const [[t], b, admins] = await Promise.all([
      ticketsFrom(c, [r]),
      c.platform.get('businesses', str(r.business_id)),
      c.platform.select('platform_admins', { where: { is_active: true } }),
    ])
    const lite = b && !b.deleted_at ? businessLite(b) : null
    return {
      ...withoutCount(t), unreadForAdmin: false,
      business: lite ? { state: lite.st.state, subType: lite.subType } : null,
      admins: admins.map((a) => ({ id: a.ROWID, name: str(a.name) })),
    }
  }),

  replyTicket: adminWrite('customers.view', async (c, id: string, text: string, images: string[] = [], status?: TicketStatus) => {
    const a = c.requireAdmin()
    const t = await anyTicket(c, id)
    const body = String(text ?? '').trim()
    if (!body && !(Array.isArray(images) && images.length)) throw new ApiError('Write a reply')
    if (status !== undefined && status !== null && !isStatus(status)) throw new ApiError('Unknown status')
    const media = await mediaFor(c, images, 'admin')
    await addMessage(c, t.ROWID, { side: 'admin', adminId: a.id, authorName: a.name, text: body, media })
    const cur = nameOf(E.TicketStatus, t.status) as TicketStatus
    const next: TicketStatus = status ?? (cur === 'open' ? 'waiting' : cur)
    await c.platform.update('support_tickets', t.ROWID, {
      status: E.TicketStatus[next], ...(next === 'resolved' ? { resolved_at: c.now.toISOString() } : next !== cur ? { resolved_at: null } : {}),
      ...(t.assigned_to ? {} : { assigned_to: a.id }),
      last_message_at: c.now.toISOString(), unread_for_customer: true, unread_for_admin: false,
    })
  }),

  updateTicket: adminWrite('customers.view', async (c, id: string, patch: { status?: TicketStatus; priority?: TicketPriority; assignedTo?: string | null }) => {
    const t = await anyTicket(c, id)
    const up: Record<string, string | number | null> = { last_message_at: c.now.toISOString() }
    if (patch?.status !== undefined) {
      if (!isStatus(patch.status)) throw new ApiError('Unknown status')
      up.status = E.TicketStatus[patch.status]
      up.resolved_at = patch.status === 'resolved' ? c.now.toISOString() : null
    }
    if (patch?.priority !== undefined) {
      if (!isPriority(patch.priority)) throw new ApiError('Unknown priority')
      up.priority = E.TicketPriority[patch.priority]
    }
    if (patch?.assignedTo !== undefined) {
      if (patch.assignedTo === null || patch.assignedTo === '') up.assigned_to = null
      else {
        const adm = isId(patch.assignedTo) ? await c.platform.get('platform_admins', patch.assignedTo) : null
        if (!adm || adm.is_active === false) throw new ApiError('Choose an admin')
        up.assigned_to = adm.ROWID
      }
    }
    await c.platform.update('support_tickets', t.ROWID, up)
  }),

  /** Screenshot for an admin reply (≤ 1600 px / 200 KB, compressed in the browser). */
  storeScreenshot: adminWrite('customers.view', async (c, input: ImageInput) => storeAdminScreenshot(c, input), { tx: 'none' }),
})
