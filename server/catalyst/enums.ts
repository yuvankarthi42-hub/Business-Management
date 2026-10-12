// Fixed lists stored as numbers in the Catalyst Data Store. Shared by the backend functions and the app.
//
// RULES — read before editing:
//  1. Never change or reuse a number. Add new values at the END with the next number.
//  2. A value that is no longer used stays here (mark it @deprecated) so old rows still read correctly.
//  3. 0 is never stored. An optional column uses NULL for "not set".
//  4. The API sends and receives the names ('completed'); only the database stores the numbers.
//     Exports (Excel / ZIP) and reports show the names too — use toName() / toCode().

export const AdminRole = { super: 1, manager: 2, support: 3 } as const
export type AdminRole = keyof typeof AdminRole
export const SecretOwner = { platform: 1, business: 2 } as const
export type SecretOwner = keyof typeof SecretOwner
export const SecretKind = { whatsapp_token: 1 } as const
export type SecretKind = keyof typeof SecretKind
export const Rollout = { off: 1, selected: 2, all: 3 } as const
export type Rollout = keyof typeof Rollout
export const BusinessStatus = { active: 1, deactivated: 2 } as const
export type BusinessStatus = keyof typeof BusinessStatus
export const PeriodKind = { new: 1, renew: 2, extend: 3, change: 4 } as const
export type PeriodKind = keyof typeof PeriodKind
export const SequenceName = { invoice: 1, order: 2, kot: 3, credit_note: 4, purchase: 5 } as const
export type SequenceName = keyof typeof SequenceName
export const DeviceKind = { counter: 1, waiter: 2, kitchen: 3, display: 4 } as const
export type DeviceKind = keyof typeof DeviceKind
export const DevicePlatform = { web: 1, android: 2, ios: 3 } as const
export type DevicePlatform = keyof typeof DevicePlatform
export const MediaPurpose = { product: 1, category: 2, logo: 3, ticket: 4, poster: 5 } as const
export type MediaPurpose = keyof typeof MediaPurpose
export const RoleKey = { owner: 1, manager: 2, cashier: 3, waiter: 4, kitchen: 5 } as const
export type RoleKey = keyof typeof RoleKey
export const PayType = { monthly: 1, daily: 2 } as const
export type PayType = keyof typeof PayType
export const ProductKind = { goods: 1, service: 2 } as const
export type ProductKind = keyof typeof ProductKind
export const PurchaseStatus = { draft: 1, final: 2, void: 3 } as const
export type PurchaseStatus = keyof typeof PurchaseStatus
export const StockReason = { opening: 1, purchase: 2, sale: 3, return: 4, wastage: 5, damage: 6, expired: 7, adjustment: 8, transfer_in: 9, transfer_out: 10 } as const
export type StockReason = keyof typeof StockReason
export const StockRef = { order: 1, purchase: 2, return: 3, transfer: 4 } as const
export type StockRef = keyof typeof StockRef
export const OrderType = { dine_in: 1, takeaway: 2, delivery: 3, counter: 4 } as const
export type OrderType = keyof typeof OrderType
export const OrderSource = { pos: 1, mobile: 2, table: 3, qr: 4 } as const
export type OrderSource = keyof typeof OrderSource
export const OrderStatus = { open: 1, completed: 2, cancelled: 3 } as const
export type OrderStatus = keyof typeof OrderStatus
export const ReturnReason = { damaged: 1, wrong_item: 2, not_needed: 3, expired: 4, quality: 5, other: 6 } as const
export type ReturnReason = keyof typeof ReturnReason
export const ReturnSettle = { refund: 1, exchange: 2, credit_note: 3 } as const
export type ReturnSettle = keyof typeof ReturnSettle
export const PayMethod = { cash: 1, upi: 2, card: 3, bank: 4, credit_note: 5 } as const
export type PayMethod = keyof typeof PayMethod
export const PaymentKind = { sale: 1, due_collection: 2, refund: 3 } as const
export type PaymentKind = keyof typeof PaymentKind
export const KotStatus = { new: 1, preparing: 2, ready: 3, completed: 4, cancelled: 5 } as const
export type KotStatus = keyof typeof KotStatus
export const ExpenseKey = { purchase: 1, salary: 2, rent: 3, electricity: 4, transport: 5, maintenance: 6, other: 7 } as const
export type ExpenseKey = keyof typeof ExpenseKey
export const ExpenseRef = { salary: 1, advance: 2, purchase: 3 } as const
export type ExpenseRef = keyof typeof ExpenseRef
export const AttendanceStatus = { present: 1, half: 2, absent: 3, leave: 4 } as const
export type AttendanceStatus = keyof typeof AttendanceStatus
export const WaAccountStatus = { setup: 1, connected: 2, disconnected: 3 } as const
export type WaAccountStatus = keyof typeof WaAccountStatus
export const WaTemplateKind = { bill: 1, offer: 2, renewal_reminder: 3 } as const
export type WaTemplateKind = keyof typeof WaTemplateKind
export const WaTemplateStatus = { draft: 1, pending: 2, approved: 3, rejected: 4 } as const
export type WaTemplateStatus = keyof typeof WaTemplateStatus
export const WaSender = { business: 1, platform: 2 } as const
export type WaSender = keyof typeof WaSender
export const WaMessageKind = { bill: 1, offer: 2, test: 3, renewal_reminder: 4 } as const
export type WaMessageKind = keyof typeof WaMessageKind
export const WaMessageStatus = { queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 } as const
export type WaMessageStatus = keyof typeof WaMessageStatus
export const TicketCategory = { billing: 1, printer: 2, stock: 3, whatsapp: 4, account: 5, other: 6 } as const
export type TicketCategory = keyof typeof TicketCategory
export const TicketPriority = { low: 1, normal: 2, high: 3, urgent: 4 } as const
export type TicketPriority = keyof typeof TicketPriority
export const TicketStatus = { open: 1, in_progress: 2, waiting: 3, resolved: 4, closed: 5 } as const
export type TicketStatus = keyof typeof TicketStatus
export const TicketSide = { customer: 1, admin: 2 } as const
export type TicketSide = keyof typeof TicketSide
export const AuditEntity = { order: 1, payment: 2, product: 3, category: 4, customer: 5, inventory: 6, expense: 7, user: 8, role: 9, branch: 10, settings: 11, whatsapp: 12, return: 13, staff: 14, table: 15 } as const
export type AuditEntity = keyof typeof AuditEntity
export const AuditAction = { create: 1, update: 2, delete: 3, cancel: 4, void: 5, login: 6, printer: 7, enable: 8, disconnect: 9, import: 10, export: 11 } as const
export type AuditAction = keyof typeof AuditAction
export const WaQuality = { high: 1, medium: 2, low: 3 } as const
export type WaQuality = keyof typeof WaQuality
export const WaProvider = { meta_cloud: 1 } as const
export type WaProvider = keyof typeof WaProvider
export const Channel = { whatsapp: 1 } as const
export type Channel = keyof typeof Channel
export const AdminAction = { create: 1, update: 2, password: 3, renew: 4, branch_limit: 5, activate: 6, deactivate: 7, delete: 8, settings: 9, login: 10, export: 11, reminder: 12, support_start: 13, support_end: 14, admin_create: 15, admin_update: 16, feature: 17 } as const
export type AdminAction = keyof typeof AdminAction
export const BusinessCategory = { retail: 1, food: 2, restaurant: 3, service: 4 } as const
export type BusinessCategory = keyof typeof BusinessCategory
export const QrStatus = { pending: 1, accepted: 2, rejected: 3 } as const
export type QrStatus = keyof typeof QrStatus
export const Fulfilment = { new: 1, packing: 2, ready: 3, delivered: 4 } as const
export type Fulfilment = keyof typeof Fulfilment
export const LoginKind = { username: 1, phone: 2, email: 3 } as const
export type LoginKind = keyof typeof LoginKind
export const ShopDbStatus = { creating: 1, ready: 2, failed: 3, deleting: 4 } as const
export type ShopDbStatus = keyof typeof ShopDbStatus

type EnumMap = Record<string, number>
/** Name → number for the database. Throws on an unknown name so bad input never reaches a table. */
export function toCode<E extends EnumMap>(e: E, name: keyof E | string): number {
  const code = e[name as keyof E]
  if (code === undefined) throw new Error(`Unknown value: ${String(name)}`)
  return code
}
/** Number from the database → name for the API, exports and reports. */
export function toName<E extends EnumMap>(e: E, code: number): keyof E {
  const hit = Object.entries(e).find(([, v]) => v === code)
  if (!hit) throw new Error(`Unknown code: ${code}`)
  return hit[0] as keyof E
}
