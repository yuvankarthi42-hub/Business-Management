// WhatsApp delivery ticks. Until Kadai Kalanjiyam sends through Meta for real, receipts are simulated from the
// message's age (sent → delivered after 4 s → read after 30 s). The screen works them out itself, so it never
// asks the server again just to move a tick. Real Meta receipts will arrive by webhook and set `status`.
import type { WaMessage } from './types'

const ORDER: WaMessage['status'][] = ['sent', 'delivered', 'read']

export function shownStatus(m: Pick<WaMessage, 'status' | 'createdAt' | 'simulated'>, now = Date.now()): WaMessage['status'] {
  if (!m.simulated || m.status === 'failed' || m.status === 'read') return m.status
  const age = now - new Date(m.createdAt).getTime()
  const byAge: WaMessage['status'] = age > 30_000 ? 'read' : age > 4_000 ? 'delivered' : 'sent'
  return ORDER.indexOf(byAge) > ORDER.indexOf(m.status) ? byAge : m.status
}

/** True while some simulated tick can still move (the screen redraws until then — no server calls). */
export const receiptsMoving = (list: Pick<WaMessage, 'status' | 'createdAt' | 'simulated'>[], now = Date.now()) =>
  list.some((m) => m.simulated && shownStatus(m, now) !== 'read' && m.status !== 'failed' && now - new Date(m.createdAt).getTime() < 35_000)

/** Which messages to read: newest first, at most `limit`; optionally one kind and/or a time window. */
export interface WaMessageQuery { limit?: number; kind?: WaMessage['kind']; since?: string; before?: string }
