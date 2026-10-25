// Order tracking for customers — shared by the demo app and the server.
import type { Order, OrderItem, OrderType, PaymentStatus } from './types'

/** What a customer sees about their order (never the customer's name or phone). */
export interface TrackView {
  number: string
  type: OrderType
  status: Order['status']
  qrStatus: Order['qrStatus'] | null
  total: number
  items: OrderItem[]
  table: string | null
  cancelReason: string | null
  kitchen: 'new' | 'preparing' | 'ready' | 'completed' | null
  paymentStatus: PaymentStatus
  fulfilment: Order['fulfilment'] | null
}

export type TrackStage = 'sent' | 'confirmed' | 'preparing' | 'ready' | 'done' | 'rejected'

/** One step for the whole order: what the progress screen and the push messages follow. */
export function trackStage(v: Pick<TrackView, 'status' | 'qrStatus' | 'kitchen' | 'cancelReason' | 'fulfilment'>): TrackStage {
  if (v.qrStatus === 'rejected' || (v.status === 'cancelled' && v.cancelReason)) return 'rejected'
  if (v.status === 'completed' || v.kitchen === 'completed' || v.fulfilment === 'delivered') return 'done'
  if (v.kitchen === 'ready' || v.fulfilment === 'ready') return 'ready'
  if (v.kitchen === 'preparing' || v.fulfilment === 'packing') return 'preparing'
  if (v.qrStatus === 'pending') return 'sent'
  return 'confirmed'
}

/** Changes whenever anything the customer can see about the order changes. */
export const trackStamp = (v: TrackView) => [trackStage(v), v.paymentStatus, v.total, v.items.length].join('|')

/** The customer's Refresh button works at most this often. */
export const REFRESH_GAP_MS = 10_000
/** How far back "Track my order" looks (today's and yesterday's orders). */
export const TRACK_WINDOW_MS = 2 * 86_400_000

/** "1042", "#1042", " # 1042 " → the order numbers to look for, with this shop's prefix. */
export function orderNumberCandidates(input: string, prefix: string): string[] {
  const raw = String(input ?? '').trim().replace(/\s+/g, '').slice(0, 30)
  if (!raw) return []
  const digits = raw.replace(/\D/g, '')
  const out = new Set<string>([raw])
  if (digits) { out.add(`${prefix}${digits}`); out.add(`#${digits}`); out.add(digits) }
  return [...out].filter((x) => x.length <= 30)
}
