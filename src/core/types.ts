import type { FeatureFlags } from './features'
import type { WaLang, WaTemplateKind } from './whatsapp'
// Common core domain. Every entity uses generic names (Product, Customer, Order...)
// and the UI maps them to business-specific words via terminology config.
// Field names mirror the MySQL schema in server/schema.sql (camelCase <-> snake_case).

export type ID = string
export type ISODate = string

/** Audit trail carried by every business record. Financial rows are never hard-deleted. */
export interface Audit {
  createdAt: ISODate
  createdBy: ID
  updatedAt: ISODate
  updatedBy: ID
}

/** Records owned by a business; branch-scoped records also carry branchId. */
export interface Scoped {
  businessId: ID
  branchId: ID
}

// ---------- Business configuration ----------

export type BusinessCategory = 'retail' | 'food' | 'restaurant' | 'service'

export type TermKey =
  | 'product' | 'category' | 'customer' | 'order' | 'invoice' | 'employee' | 'table' | 'kot' | 'expense' | 'payment'

export type Terminology = Record<TermKey, { singular: string; plural: string }>

export type ModuleKey =
  | 'billing' | 'orders' | 'products' | 'inventory' | 'customers' | 'payments' | 'expenses'
  | 'reports' | 'tables' | 'kitchen' | 'mobileOrders' | 'employees' | 'appointments' | 'specials' | 'qrOrdering' | 'customerOrders'

export type ModuleConfig = Record<ModuleKey, boolean>

/** credit = pay later (due). credit_note = paid with a credit note from an earlier return. */
export type PaymentMethod = 'cash' | 'upi' | 'card' | 'bank' | 'credit' | 'credit_note'
export type OrderType = 'counter' | 'dine_in' | 'takeaway' | 'delivery'

export interface TaxRate {
  id: ID
  name: string
  rate: number // percent
}

export interface BillingSettings {
  invoicePrefix: string
  nextInvoiceNumber: number
  orderPrefix: string
  nextOrderNumber: number
  nextKotNumber: number
  taxEnabled: boolean
  /** inclusive: product price already contains tax. exclusive: tax added on top. */
  taxMode: 'inclusive' | 'exclusive'
  taxRates: TaxRate[]
  defaultTaxRateId: ID | null
  discountEnabled: boolean
  paymentMethods: PaymentMethod[]
  orderTypes: OrderType[]
  receiptFooter: string
  roundOff: boolean
  /** Thermal printer roll width. Defaults to 80mm. */
  paperWidth?: '58mm' | '80mm'
  /** Second price list for contractors / wholesale buyers (retail shops). */
  wholesale?: { enabled: boolean; label: string }
  /** Credit notes (returns): CN-1001, CN-1002… */
  creditNotePrefix?: string
  nextCreditNoteNumber?: number
  /**
   * Customer discount below MRP (textile / supermarket). On (default): items sell at their selling price and the
   * bill shows "You saved". Off: everything sells at MRP — the selling prices are kept for when it is turned on again.
   */
  mrpDiscounts?: boolean
}

/** Price sticker / label printing (Settings → Price stickers). */
export type StickerSize = '50x38' | '50x25' | '38x25' | 'a4'
export interface StickerSettings {
  size: StickerSize
  /** QR code (phone-style 2D scanners) or barcode (1D laser scanners). Both hold the item's code. */
  code: 'qr' | 'barcode'
  showShop: boolean
  showName: boolean
  /** Design no. / SKU. */
  showDesign: boolean
  /** Fabric, colour and size. */
  showDetails: boolean
  /** auto: MRP, discount and offer price when discounts are on; MRP only when off or no discount. mrp: always MRP only. */
  priceMode: 'auto' | 'mrp'
  /** Short line at the bottom, e.g. "No exchange after 7 days". */
  footer: string
  /** Stickers per item when printing (stock-in prints one per piece). */
  copies: number
}

/** Customer self-ordering via QR code. */
export interface QrSettings {
  orderTypes: OrderType[] // which types customers may choose (dine_in only via a table QR)
  autoAccept: boolean // true: send straight to kitchen; false: staff accept first
  baseUrl: string // public address printed in the QR, e.g. http://10.89.33.221:5173
}

export interface Business {
  id: ID
  name: string
  category: BusinessCategory
  subType: string
  logoEmoji: string
  /** Uploaded shop logo (Settings → Business profile). Unset = the Kadai Kalanjiyam logo is shown. */
  logoUrl?: string | null
  address: string
  phone: string
  email: string
  gstin: string
  currency: string
  currencySymbol: string
  timezone: string
  /** ISO country used as the default code for mobile numbers (e.g. "IN" → +91). */
  defaultCountry?: string
  terminology: Terminology
  modules: ModuleConfig
  billing: BillingSettings
  qr?: QrSettings
  /** Price sticker layout. Unset = defaults (core/stickers.ts). */
  stickers?: StickerSettings
  /** GST state of the shop (01–38) when it has no GSTIN; with a GSTIN its first two digits are used. */
  stateCode?: string
  /** Loyalty points rules (Settings → Loyalty points). Unset = off. */
  loyalty?: LoyaltySettings
  onboarded: boolean
  createdAt: ISODate
  // ---- Set by the product admin (customer account) ----
  /** Deactivated accounts can't sign in. */
  status?: AccountStatus
  /** Paid period. After `endAt` the account is read-only until renewed. */
  subscription?: Subscription
  /** Most branches this customer may have (pricing is per branch). */
  maxBranches?: number
  /** Admin-only note (not shown to the customer). */
  adminNote?: string
  /** Product admin paused renewal reminders for this customer. */
  remindersPaused?: boolean
  /** WhatsApp Business integration (Settings → Integrations). The access token is kept server-side only. */
  whatsapp?: WhatsAppConfig
}

export interface WaTemplate {
  kind: WaTemplateKind
  language: WaLang
  /** Text with {{field}} placeholders, e.g. "Hi {{customer_name}} …" */
  body: string
  /** Offer → poster image header; bill → PDF document header. */
  attach: boolean
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  reason?: string
  submittedAt?: ISODate | null
  updatedAt: ISODate
}
export interface WhatsAppConfig {
  enabled: boolean
  provider: 'meta_cloud'
  /** E.164 — the customer's own WhatsApp Business number. */
  businessNumber: string
  wabaId: string
  phoneNumberId: string
  /** Only the last 4 characters of the token are ever sent to the browser. */
  tokenLast4: string
  verified: { name: string; number: string; quality: 'High' | 'Medium' | 'Low'; at: ISODate } | null
  templates: Partial<Record<WaTemplateKind, WaTemplate>>
  autoSendBill: boolean
  finishedAt: ISODate | null
  updatedAt: ISODate
}
export interface WaMessage {
  id: ID
  businessId: ID
  kind: 'bill' | 'offer' | 'test'
  /** E.164 */
  to: string
  customerName: string
  customerId: ID | null
  refId: ID | null
  body: string
  attachment: string | null
  status: 'sent' | 'delivered' | 'read' | 'failed'
  /** Receipts are simulated from the message's age (no real Meta yet): see core/waReceipts.ts. */
  simulated?: boolean
  error?: string
  createdAt: ISODate
  createdBy: ID
}

export type AccountStatus = 'active' | 'deactivated'
export interface Subscription { startAt: ISODate; endAt: ISODate }

export interface Branch {
  id: ID
  businessId: ID
  name: string
  address: string
  phone?: string
  isDefault: boolean
  /** Closed branches stay in reports but can't be selected for billing. */
  active?: boolean
  /** Own bill series, e.g. "AD-" + 10001. Empty = use the business-wide series. */
  invoicePrefix?: string
  nextInvoiceNumber?: number
  /** This branch's receipt printer setup (every counter in the branch uses it). */
  printer?: BranchPrinter
}

/** Printer setup per branch. Which physical printer a device is paired with stays on that device. */
export interface BranchPrinter {
  transport: 'browser' | 'usb' | 'serial' | 'bluetooth'
  /** null = follow Billing settings */
  paper: '58mm' | '80mm' | null
  /** auto = image only when a bill has Tamil / other script text */
  mode: 'auto' | 'text' | 'image'
  autoPrint: boolean
  copies: number
  cut: boolean
  drawer: boolean
  baudRate: number
  updatedAt?: ISODate
  updatedBy?: ID
}

// ---------- Users / roles ----------

export type Permission =
  | 'dashboard.view' | 'billing.create' | 'billing.discount' | 'billing.price' | 'orders.view' | 'orders.cancel'
  | 'products.manage' | 'inventory.manage' | 'customers.manage' | 'payments.view' | 'payments.collect'
  | 'expenses.manage' | 'reports.view' | 'reports.profit' | 'tables.manage' | 'kitchen.view'
  | 'settings.manage' | 'users.manage'

export interface Role {
  id: ID
  businessId: ID
  name: string
  system: boolean // built-in roles cannot be deleted
  permissions: Permission[] | ['*']
}

export interface User extends Audit {
  id: ID
  businessId: ID
  branchId: ID
  name: string
  /** E.164, e.g. +919876543210 (login ID). */
  phone: string
  email: string
  password: string // MOCK ONLY — the real backend stores a bcrypt hash
  roleId: ID
  active: boolean
  /** Branches this user may work in. Owner role = all. Empty/undefined = only `branchId`. */
  branchIds?: ID[]
  /** App language chosen by this user ('en', 'ta', …). */
  language?: string
  /** Login name given by the product admin (business owner accounts). Lower-case, unique. */
  username?: string
  /** Last real sign-in (support views by the product admin don't count). */
  lastLoginAt?: ISODate | null
  /** Salary and commission (Staff → Payroll). */
  pay?: StaffPay
  /** false = works here but doesn't use the app (cleaner, helper): attendance and salary only, never signs in. */
  canLogin?: boolean
}

export interface StaffPay {
  /** monthly = fixed salary (absent days are cut); daily = paid per day worked. */
  type: 'monthly' | 'daily'
  amount: number
  /** % of the bills this person made (after returns). 0 = no commission. */
  commissionPct: number
}

// ---------- Catalogue ----------

export interface Category {
  id: ID
  businessId: ID
  name: string
  emoji: string
  /** Photo (URL, or compressed data URL in the mock). Emoji is the fallback. Always ≤ 50 KB. */
  imageUrl?: string | null
  /** Small copy (320 px) for chips and lists. */
  thumbUrl?: string | null
  sort: number
  /** Default HSN / SAC for items in this category (an item's own code wins). */
  hsn?: string | null
}

export interface Variant {
  id: ID
  name: string
  price: number
  /** Contractor / wholesale price for this size. Empty = retail price. */
  wholesalePrice?: number | null
}

export interface AddOn {
  id: ID
  name: string
  price: number
}

export type ProductKind = 'goods' | 'service'

export interface Product extends Audit {
  id: ID
  businessId: ID
  name: string
  categoryId: ID | null
  kind: ProductKind
  emoji: string
  /** Photo (URL, or compressed data URL in the mock). Emoji is the fallback. Always ≤ 50 KB (800 px max). */
  imageUrl?: string | null
  /** Small copy (320 px) for lists, billing tiles and thumbnails. */
  thumbUrl?: string | null
  sku: string
  barcode: string
  unit: string // pc, kg, ltr, plate...
  price: number // base price (used when no variants)
  /** Printed maximum retail price (shown as "You save" when selling below it). Optional. */
  mrp?: number | null
  costPrice: number
  /** Contractor / wholesale price (retail shops). Empty = same as the selling price. */
  wholesalePrice?: number | null
  variants: Variant[]
  addOns: AddOn[]
  taxRateId: ID | null
  trackStock: boolean
  /** Total across all branches (kept for quick reads). Per-branch values live in stockByBranch. */
  stock: number
  stockByBranch?: Record<ID, number>
  /** Stock is kept in batches with expiry dates (milk, curd, medicines…). Sold first-expiry-first-out. */
  trackExpiry?: boolean
  /** Read-only projection from the API: earliest expiry (YYYY-MM-DD) among batches in stock. */
  nextExpiry?: string | null
  lowStockAt: number
  isVeg: boolean
  sendToKitchen: boolean
  active: boolean
  /** Textile shops: design no., fabric, colour and size (printed on the price sticker). */
  details?: ProductDetails | null
  /** HSN (goods) / SAC (services) code. Empty = the category's code, if any. */
  hsn?: string | null
}

export interface ProductDetails {
  /** Design no. shared by every size / colour of one design. */
  design?: string
  fabric?: string
  colour?: string
  size?: string
}

// ---------- Customers ----------

export interface Customer extends Audit {
  id: ID
  businessId: ID
  name: string
  /** E.164, e.g. +919876543210 — empty if not given. */
  phone: string
  email: string
  address: string
  notes: string
  /** OK to receive offers on WhatsApp. Undefined = yes (default for existing guests). */
  marketingOptIn?: boolean
  /** Bills for this customer use the wholesale / contractor price list. */
  priceTier?: PriceTier
  /** GST number of a business customer: bills become B2B tax invoices. */
  gstin?: string | null
  /** GST state (01–38) — place of supply. From the GSTIN when given. Empty = shop's state. */
  stateCode?: string | null
  /** Loyalty points available. */
  pointsBalance?: number
}

export type PriceTier = 'retail' | 'wholesale'

// ---------- Orders / invoices ----------

export interface OrderItemAddOn {
  id: ID
  name: string
  price: number
}

export interface OrderItem {
  id: ID
  productId: ID
  name: string
  variantId: ID | null
  variantName: string | null
  addOns: OrderItemAddOn[]
  qty: number
  unit: string
  unitPrice: number // variant/base price + addons
  taxRate: number
  notes: string
  /** Quantity already sent to the kitchen (for incremental KOTs). */
  kotQty: number
  /** Priced from the wholesale / contractor list. */
  priceTier?: PriceTier
  /** Printed MRP per unit, when it is above the price charged (receipt: "You saved"). */
  mrp?: number
  /** HSN / SAC code at billing (item's, else its category's). */
  hsn?: string
  /** Price per unit changed at the counter (price change or line discount) — needs "Change item price at billing". */
  priceOverride?: number
  /** The catalogue price before that change (shown as "was …"). */
  listPrice?: number
}

export type OrderStatus = 'open' | 'completed' | 'cancelled'
export type PaymentStatus = 'unpaid' | 'partial' | 'paid'

export interface Order extends Scoped, Audit {
  id: ID
  number: string
  type: OrderType
  tableId: ID | null
  customerId: ID | null
  status: OrderStatus
  items: OrderItem[]
  notes: string
  discount: number // absolute amount
  subtotal: number
  tax: number
  roundOff: number
  total: number
  paid: number
  balance: number
  paymentStatus: PaymentStatus
  invoiceNumber: string | null
  billedAt: ISODate | null
  cancelledAt: ISODate | null
  cancelReason: string | null
  source: 'pos' | 'mobile' | 'table' | 'qr'
  /** QR orders wait for staff approval before reaching the kitchen. */
  qrStatus?: 'pending' | 'accepted' | 'rejected'
  /** Customer-order stage (supermarket orders board). Delivered = billed. Unset for normal counter bills. */
  fulfilment?: 'new' | 'packing' | 'ready' | 'delivered'
  /** Contact details entered by the customer (QR takeaway / delivery). */
  guest?: { name: string; phone: string; address: string } | null
  /** Staff member who sold it (textile counters). Commission goes to them; unset = the person who made the bill. */
  salespersonId?: ID | null
  /** B2B tax invoice: the customer's GSTIN at billing. */
  customerGstin?: string | null
  /** Customer's GST state at billing, when it differs from the shop's. */
  placeOfSupply?: string | null
  /** Other-state customer: IGST instead of CGST + SGST. */
  igst?: boolean
  /** Loyalty: points used on this bill and their value (already inside `discount`). */
  pointsRedeemed?: number
  pointsValue?: number
  pointsEarned?: number
  /** Customer's points after this bill. */
  pointsBalance?: number | null
}

// ---------- Loyalty points ----------

export interface LoyaltySettings {
  enabled: boolean
  /** ₹ spent for 1 point (100 = 1 point per ₹100). */
  spendPerPoint: number
  /** ₹ value of 1 point when used. */
  pointValue: number
  /** Points needed before they can be used. */
  minRedeem: number
  /** Most of a bill (%) that points can pay. */
  maxBillPct: number
  /** Points expire this many months after they're earned. 0 = never. */
  expiryMonths: number
  /** Items already sold below MRP also earn points. */
  earnOnDiscounted: boolean
}

export type PointsKind = 'earn' | 'redeem' | 'return' | 'cancel' | 'expire' | 'adjust'
export interface PointsEntry {
  id: ID
  customerId: ID
  orderId: ID | null
  /** Bill / credit-note number for the history list. */
  ref: string
  kind: PointsKind
  points: number
  balanceAfter: number
  expiresOn: string | null
  note: string
  createdAt: ISODate
}

// ---------- Suppliers & purchases ----------

export interface Supplier {
  id: ID
  businessId: ID
  name: string
  phone: string
  gstin: string
  stateCode: string | null
  address: string
  notes: string
  /** Owed before using the app (+) or advance paid (−). */
  openingBalance: number
  active: boolean
  /** Read-only from the API: what the shop owes now (opening + purchases − payments). */
  balance?: number
  purchases?: number
  lastPurchaseOn?: string | null
}

export interface PurchaseLine {
  id?: ID
  productId: ID
  name: string
  unit: string
  hsn: string
  qty: number
  /** Per unit, before GST. */
  cost: number
  taxRate: number
  taxable: number
  tax: number
  batchNo?: string
  expiry?: string
}

export interface Purchase extends Scoped, Audit {
  id: ID
  number: string
  supplierId: ID | null
  supplierName: string
  supplierBillNo: string
  date: string // YYYY-MM-DD
  lines: PurchaseLine[]
  taxable: number
  tax: number
  igst: boolean
  roundOff: number
  total: number
  paid: number
  balance: number
  status: 'final' | 'void'
  note: string
  voidReason: string | null
}

export interface SupplierPayment {
  id: ID
  supplierId: ID
  purchaseId: ID | null
  date: string
  method: Exclude<PaymentMethod, 'credit' | 'credit_note'>
  amount: number
  reference: string
  note: string
  voided: boolean
  createdAt: ISODate
}

/** One row of a supplier's statement. */
export interface SupplierLedgerRow { date: string; kind: 'opening' | 'purchase' | 'payment' | 'void'; ref: string; debit: number; credit: number; balance: number; id: ID | null }

export type PaymentKind = 'sale' | 'due_collection' | 'refund'

export interface Payment extends Scoped, Audit {
  id: ID
  orderId: ID | null
  customerId: ID | null
  method: PaymentMethod
  kind: PaymentKind
  amount: number
  reference: string
  voided: boolean
}

// ---------- Staff: attendance & payroll ----------

/** leave = approved paid leave · absent = unpaid */
export type AttendanceStatus = 'present' | 'half' | 'absent' | 'leave'

export interface Attendance extends Scoped {
  id: ID
  userId: ID
  /** YYYY-MM-DD */
  date: string
  status: AttendanceStatus
  /** HH:MM */
  checkIn: string | null
  checkOut: string | null
  note: string
  markedBy: ID
  markedAt: ISODate
}

export interface StaffAdvance extends Scoped, Audit {
  id: ID
  userId: ID
  date: string
  amount: number
  method: PaymentMethod
  note: string
  /** Salary payment that recovered it. */
  settledIn: ID | null
}

export interface SalaryPayment extends Scoped, Audit {
  id: ID
  userId: ID
  /** YYYY-MM */
  month: string
  payType: StaffPay['type']
  rate: number
  daysInMonth: number
  present: number
  half: number
  leave: number
  absent: number
  unmarked: number
  basePay: number
  commissionSales: number
  commission: number
  bonus: number
  deduction: number
  advances: number
  net: number
  method: PaymentMethod
  note: string
}

// ---------- Returns / credit notes ----------

export type ReturnReason = 'damaged' | 'wrong_item' | 'not_needed' | 'expired' | 'quality' | 'other'

export interface SaleReturnLine {
  orderItemId: ID
  productId: ID
  name: string
  qty: number
  unit: string
  unitPrice: number
  /** Value of this line after the bill's discount / tax / round-off share. */
  amount: number
  /** false = damaged / not resellable → not added back to stock. */
  restock: boolean
}

/** A return against a bill. Its number is the credit note number (CN-1001). */
export interface SaleReturn extends Scoped, Audit {
  id: ID
  number: string
  orderId: ID
  invoiceNumber: string
  customerId: ID | null
  lines: SaleReturnLine[]
  /** Total value returned (includes its share of tax). */
  total: number
  tax: number
  reason: ReturnReason
  note: string
  /** Part of the value that reduced the bill's pending due. */
  dueAdjusted: number
  /** Part paid back to the customer. */
  refunded: number
  refundMethod: PaymentMethod | null
  /** Part kept as a credit note for the next bill (exchange). */
  creditIssued: number
  /** Credit note value still unused. */
  creditRemaining: number
}

// ---------- Daily specials ----------

export interface Special {
  id: ID
  businessId: ID
  date: string // YYYY-MM-DD (local business date)
  productId: ID
  /** Optional offer price; only for products without variants. */
  specialPrice: number | null
  tag: string // "Chef's pick", "Limited", "New"...
  sort: number
}

// ---------- Offers / campaigns ----------

/** One "share offer" run. Sends are tracked so a guest isn't messaged twice in a day. */
export interface Campaign {
  id: ID
  businessId: ID
  date: string // YYYY-MM-DD
  channel: 'whatsapp'
  message: string // template with {name} / {order link} placeholders
  productIds: ID[]
  sends: { customerId: ID; at: ISODate; by: ID }[]
  createdAt: ISODate
  createdBy: ID
}

// ---------- Kitchen ----------

export type KotStatus = 'new' | 'preparing' | 'ready' | 'completed' | 'cancelled'

export interface KitchenTicket extends Scoped, Audit {
  id: ID
  number: string
  orderId: ID
  orderNumber: string
  orderType: OrderType
  tableLabel: string | null
  items: { name: string; qty: number; notes: string; isVeg: boolean }[]
  status: KotStatus
  statusAt: ISODate
}

// ---------- Tables ----------

export interface DiningTable {
  id: ID
  businessId: ID
  branchId: ID
  label: string
  floor: string
  seats: number
  /** Set when tables are merged: points at the primary table. */
  mergedInto: ID | null
}

// ---------- Expenses ----------

export type ExpenseCategory = 'purchase' | 'salary' | 'rent' | 'electricity' | 'transport' | 'maintenance' | 'other'

export interface Expense extends Scoped, Audit {
  id: ID
  date: ISODate
  category: ExpenseCategory
  amount: number
  method: PaymentMethod
  notes: string
  voided: boolean
  /** Added by the app for a supplier payment (void it from the supplier's statement). */
  supplierPaymentId?: ID | null
}

// ---------- Inventory ----------

export type StockMovementType = 'opening' | 'purchase' | 'sale' | 'damage' | 'wastage' | 'adjustment' | 'return'

export interface StockMovement extends Scoped, Audit {
  id: ID
  productId: ID
  type: StockMovementType
  qty: number // signed
  balanceAfter: number
  refId: ID | null
  note: string
}

// ---------- Batches & expiry ----------

export interface StockBatch extends Scoped, Audit {
  id: ID
  productId: ID
  batchNo: string
  /** YYYY-MM-DD; empty when unknown (e.g. stock returned without a batch). */
  expiry: string
  qty: number // remaining
  receivedQty: number
}

// ---------- Audit log ----------

export interface AuditLog {
  id: ID
  businessId: ID
  entity: string
  entityId: ID
  action: string
  userId: ID
  at: ISODate
  detail: string
}

// ---------- Product admin (platform) ----------

/** People who run Kadai Kalanjiyam itself and manage customer accounts. */
export interface PlatformAdmin {
  id: ID
  name: string
  username: string
  password: string // MOCK ONLY — bcrypt on the server
  role: AdminRole
  active: boolean
  createdAt: ISODate
  lastLoginAt?: ISODate | null
}

/** super = everything · manager = no delete / team / pricing · support = view, renew and support view only */
export type AdminRole = 'super' | 'manager' | 'support'

/** One paid period of a customer's subscription (new account, renewal, extension or plan change). */
export interface SubscriptionPeriod {
  id: ID
  businessId: ID
  kind: 'new' | 'renew' | 'extend' | 'change'
  startAt: ISODate
  endAt: ISODate
  /** null for a custom end date */
  months: number | null
  branches: number
  pricePerBranch: number
  amount: number
  note: string
  createdAt: ISODate
  createdBy: ID
}

export interface AdminAuditLog {
  id: ID
  at: ISODate
  adminId: ID
  adminName: string
  action: 'create' | 'update' | 'password' | 'renew' | 'branch_limit' | 'activate' | 'deactivate' | 'delete' | 'settings' | 'login'
    | 'admin_create' | 'admin_update' | 'support_start' | 'support_end' | 'feature' | 'export' | 'reminder'
  businessId: ID | null
  businessName: string
  detail: string
}

export interface PlatformSettings {
  /** Price per branch per month (₹). Customer price = branches × months × this. */
  pricePerBranchMonth: number
  /** Feature release flags (off / selected customers / all). */
  features?: FeatureFlags
  /** Renewal reminders sent to customers before their subscription ends. */
  reminders?: ReminderSettings
  /** Kadai Kalanjiyam's own WhatsApp Business number — sends renewal reminders to shop owners. */
  whatsapp?: PlatformWhatsApp
}

/** The product's own WhatsApp (Meta Cloud API), set up on the admin WhatsApp page. */
export interface PlatformWhatsApp {
  businessNumber: string
  wabaId: string
  phoneNumberId: string
  tokenLast4: string
  verified: { name: string; number: string; quality: 'High' | 'Medium' | 'Low'; at: ISODate } | null
  /** Renewal reminder template (body is ReminderSettings.template). */
  template: { language: 'en' | 'ta'; status: 'draft' | 'pending' | 'approved' | 'rejected'; submittedAt: ISODate | null; reason?: string } | null
  updatedAt: ISODate
}

export interface ReminderSettings {
  enabled: boolean
  /** Start this many days before the end date, then every day until it ends. */
  daysBefore: number
  /** {owner} {business} {date} {days} {amount} {support} — a WhatsApp template approved by Meta. */
  template: string
  supportContact: string
}

export interface ReminderLog {
  id: ID
  businessId: ID
  businessName: string
  /** YYYY-MM-DD — at most one automatic reminder per customer per day. */
  date: string
  daysLeft: number
  channel: 'whatsapp'
  to: string
  message: string
  status: 'sent' | 'failed'
  error?: string
  trigger: 'auto' | 'manual'
  adminName?: string
  createdAt: ISODate
}

// ---------- Support tickets ----------

export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TicketCategory = 'billing' | 'printer' | 'stock' | 'whatsapp' | 'account' | 'other'

export interface TicketMessage {
  id: ID
  from: 'customer' | 'admin'
  authorId: ID
  authorName: string
  text: string
  /** Screenshots (compressed images). */
  images: string[]
  at: ISODate
}

export interface Ticket {
  id: ID
  number: string
  businessId: ID
  businessName: string
  userId: ID
  userName: string
  userPhone: string
  subject: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  assignedTo: ID | null
  /** Page, browser and app version when it was reported. */
  context: { page: string; browser: string; version: string }
  messages: TicketMessage[]
  createdAt: ISODate
  updatedAt: ISODate
  unreadForAdmin: boolean
  unreadForCustomer: boolean
}

